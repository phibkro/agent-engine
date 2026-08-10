import { Effect } from "effect";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AttachResolution, ProjectId, WorkId } from "@work-engine/runtime";
import type { OperatorConfig } from "./config.ts";

export const PINNED_HERDR_VERSION = "0.8.0";

export type AttachError =
  | { readonly _tag: "AttachExpired"; readonly resolutionId: string }
  | { readonly _tag: "AttachBindingMismatch"; readonly reason: string }
  | { readonly _tag: "AttachResolutionUnsafe"; readonly reason: string }
  | { readonly _tag: "AttachFilesystemFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "AttachVersionMismatch"; readonly local: string; readonly remote: string }
  | { readonly _tag: "AttachProbeFailure"; readonly reason: string }
  | { readonly _tag: "AttachHerdrFailure"; readonly reason: string };

export interface AttachFileSystem {
  readonly makeDirectory: (path: string) => Effect.Effect<void, AttachError>;
  readonly writePrivateExclusive: (path: string, content: string) => Effect.Effect<void, AttachError>;
  readonly inspect: (path: string) => Effect.Effect<{ readonly uid: number; readonly mode: number }, AttachError>;
  readonly removeOwned: (path: string) => Effect.Effect<void, AttachError>;
}

export interface AttachProcess {
  readonly capture: (
    command: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>,
  ) => Effect.Effect<ProcessCapture, AttachError>;
  readonly inherit: (
    command: string,
    args: ReadonlyArray<string>,
    environment: Record<string, string>,
  ) => Effect.Effect<number, AttachError>;
}

export interface ProcessCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AttachTarget {
  readonly alias: string;
  readonly configPath: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly session: string;
}

export interface AttachOutcome {
  readonly resolution: AttachResolution;
  readonly target: AttachTarget;
  readonly localHerdrVersion?: string;
  readonly remoteHerdrVersion?: string;
}

const currentUid = (): number => {
  const getuid = process.getuid;
  return typeof getuid === "function" ? getuid() : -1;
};

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeResolutionId = (value: string): boolean =>
  value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..") && !value.includes("/");

const parseTime = (timestamp: string): number => Date.parse(timestamp);

export const validateAttachResolution = (
  resolution: AttachResolution,
  projectId: ProjectId,
  workId: WorkId,
  now = Date.now(),
): Effect.Effect<void, AttachError> => {
  if (!safeResolutionId(resolution.resolutionId)) {
    return Effect.fail({
      _tag: "AttachResolutionUnsafe",
      reason: "resolution id is not a safe file-name component",
    });
  }
  if (resolution.projectId !== projectId || resolution.workId !== workId) {
    return Effect.fail({
      _tag: "AttachBindingMismatch",
      reason: "resolution is bound to a different Project or Work",
    });
  }
  const expiry = parseTime(resolution.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) {
    return Effect.fail({ _tag: "AttachExpired", resolutionId: resolution.resolutionId });
  }
  if (resolution.sshPort < 1 || resolution.sshPort > 65535) {
    return Effect.fail({
      _tag: "AttachResolutionUnsafe",
      reason: "resolution contains an invalid SSH port",
    });
  }
  if (resolution.proxyCommand !== "wrangler containers ssh %h") {
    return Effect.fail({
      _tag: "AttachResolutionUnsafe",
      reason: "resolution does not use the reviewed Wrangler SSH proxy",
    });
  }
  return Effect.succeed(undefined);
};

export const renderSshConfig = (
  resolution: AttachResolution,
  identityFile: string,
  alias: string,
): string =>
  [
    `Host ${alias}`,
    `  HostName ${resolution.containerInstanceId}`,
    `  User ${resolution.sshUser}`,
    `  ProxyCommand ${resolution.proxyCommand}`,
    `  IdentityFile ${identityFile}`,
    "",
  ].join("\n");

const makeNodeFileSystem = (): AttachFileSystem => ({
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true, mode: 0o700 }),
      catch: (error) => ({
        _tag: "AttachFilesystemFailure" as const,
        path,
        reason: reasonOf(error),
      }),
    }),
  writePrivateExclusive: (path, content) =>
    Effect.tryPromise({
      try: async () => {
        await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const metadata = await stat(path);
        if ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== currentUid()) {
          await unlink(path).catch(() => undefined);
          throw new Error("new SSH configuration is not owned with mode 0600");
        }
      },
      catch: (error) => ({
        _tag: "AttachFilesystemFailure" as const,
        path,
        reason: reasonOf(error),
      }),
    }),
  inspect: (path) =>
    Effect.tryPromise({
      try: async () => {
        const metadata = await stat(path);
        return { uid: metadata.uid, mode: metadata.mode & 0o777 };
      },
      catch: (error) => ({
        _tag: "AttachFilesystemFailure" as const,
        path,
        reason: reasonOf(error),
      }),
    }),
  removeOwned: (path) =>
    Effect.gen(function* () {
      const metadata = yield* Effect.tryPromise({
        try: async () => {
          const value = await stat(path);
          return { uid: value.uid, mode: value.mode & 0o777 };
        },
        catch: (error) => ({
          _tag: "AttachFilesystemFailure" as const,
          path,
          reason: reasonOf(error),
        }),
      });
      if (metadata.uid !== currentUid() || metadata.mode !== 0o600) {
        return yield* Effect.fail({
          _tag: "AttachFilesystemFailure",
          path,
          reason: "refusing to remove a file not owned with mode 0600",
        } as const);
      }
      yield* Effect.tryPromise({
        try: () => unlink(path),
        catch: (error) => ({
          _tag: "AttachFilesystemFailure" as const,
          path,
          reason: reasonOf(error),
        }),
      });
    }),
});

export const scrubbedEnvironment = (
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const entries = Object.entries(source).filter(([key, value]) => {
    if (value === undefined) return false;
    return !key.startsWith("WORK_ENGINE_") && !key.startsWith("CF_ACCESS") && key !== "AUTHORIZATION";
  });
  return Object.fromEntries(entries) as Record<string, string>;
};

const makeNodeProcess = (): AttachProcess => ({
  capture: (command, args, environment) =>
    Effect.tryPromise({
      try: async () => {
        const processHandle = Bun.spawn([command, ...args], {
          env: environment,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(processHandle.stdout).text(),
          new Response(processHandle.stderr).text(),
          processHandle.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
      catch: (error) => ({ _tag: "AttachProbeFailure" as const, reason: reasonOf(error) }),
    }),
  inherit: (command, args, environment) =>
    Effect.tryPromise({
      try: async () => {
        const processHandle = Bun.spawn([command, ...args], {
          env: environment,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return processHandle.exited;
      },
      catch: (error) => ({ _tag: "AttachHerdrFailure" as const, reason: reasonOf(error) }),
    }),
});

const parseHerdrVersion = (output: string): string | undefined => {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^(?:herdr\s+)?(\d+\.\d+\.\d+)$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
};

const checkedVersion = (
  capture: ProcessCapture,
  local: boolean,
): Effect.Effect<string, AttachError> => {
  const version = parseHerdrVersion(`${capture.stdout}\n${capture.stderr}`);
  if (capture.exitCode !== 0 || version === undefined) {
    return Effect.fail({
      _tag: "AttachProbeFailure",
      reason: `${local ? "local" : "remote"} Herdr version probe failed`,
    });
  }
  return Effect.succeed(version);
};

export const writeAttachConfig = (
  resolution: AttachResolution,
  config: OperatorConfig,
  fileSystem: AttachFileSystem = makeNodeFileSystem(),
): Effect.Effect<AttachTarget, AttachError> =>
  Effect.gen(function* () {
    const alias = `work-engine-${resolution.resolutionId}`;
    const directory = resolve(config.sshDirectory);
    const configPath = join(directory, `${resolution.resolutionId}.conf`);
    yield* fileSystem.makeDirectory(directory);
    yield* fileSystem.writePrivateExclusive(
      configPath,
      renderSshConfig(resolution, config.sshIdentityFile, alias),
    );
    return {
      alias,
      configPath,
      host: resolution.containerInstanceId,
      port: resolution.sshPort,
      user: resolution.sshUser,
      session: resolution.projectId,
    };
  });

export const runAttach = (
  resolution: AttachResolution,
  projectId: ProjectId,
  workId: WorkId,
  config: OperatorConfig,
  options: {
    readonly json: boolean;
    readonly now?: number;
    readonly fileSystem?: AttachFileSystem;
    readonly process?: AttachProcess;
  },
): Effect.Effect<AttachOutcome, AttachError> =>
  Effect.gen(function* () {
    yield* validateAttachResolution(resolution, projectId, workId, options.now ?? Date.now());
    const fileSystem = options.fileSystem ?? makeNodeFileSystem();
    const process = options.process ?? makeNodeProcess();
    const target = yield* writeAttachConfig(resolution, config, fileSystem);
    const environment = scrubbedEnvironment();
    if (options.json) {
      yield* fileSystem.removeOwned(target.configPath);
      return { resolution, target };
    }

    const interactive = Effect.gen(function* () {
      const local = yield* process.capture(config.herdrBinary, ["--version"], environment);
      const localVersion = yield* checkedVersion(local, true);
      if (localVersion !== PINNED_HERDR_VERSION) {
        return yield* Effect.fail({
          _tag: "AttachVersionMismatch",
          local: localVersion,
          remote: "unknown",
        } as const);
      }

      const remote = yield* process.capture(
        "ssh",
        ["-F", target.configPath, target.alias, "herdr", "--version"],
        environment,
      );
      const remoteVersion = yield* checkedVersion(remote, false);
      if (remoteVersion !== PINNED_HERDR_VERSION) {
        return yield* Effect.fail({
          _tag: "AttachVersionMismatch",
          local: localVersion,
          remote: remoteVersion,
        } as const);
      }

      const exitCode = yield* process.inherit(
        config.herdrBinary,
        ["--remote", target.alias, "--session", projectId],
        environment,
      );
      if (exitCode !== 0) {
        return yield* Effect.fail({
          _tag: "AttachHerdrFailure",
          reason: `Herdr exited with status ${exitCode}`,
        } as const);
      }
      return {
        resolution,
        target,
        localHerdrVersion: localVersion,
        remoteHerdrVersion: remoteVersion,
      };
    });
    return yield* Effect.ensuring(
      interactive,
      Effect.ignore(fileSystem.removeOwned(target.configPath)),
    );
  });

export const removeAttachConfig = (
  path: string,
  fileSystem: AttachFileSystem = makeNodeFileSystem(),
): Effect.Effect<void, AttachError> => fileSystem.removeOwned(path);

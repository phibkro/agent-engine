import { Effect } from "effect";
import type { ProjectId, WorkId } from "@work-engine/protocol";
import type { AttachResolution } from "@work-engine/runtime";
import type { OperatorConfig } from "./config.ts";
import {
  currentUid,
  environment as bunEnvironment,
  inspectFile,
  makeDirectory,
  removeFile,
  resolvePath,
  writeTextFileExclusive,
} from "./platform.ts";

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
  readonly writePrivateExclusive: (
    path: string,
    content: string,
  ) => Effect.Effect<void, AttachError>;
  readonly inspect: (
    path: string,
  ) => Effect.Effect<{ readonly uid: number; readonly mode: number }, AttachError>;
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

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeResolutionId = (value: string): boolean =>
  value.length > 0 &&
  /^[A-Za-z0-9._-]+$/.test(value) &&
  !value.includes("..") &&
  !value.includes("/");

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
  return Effect.void;
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

const fileFailure = (path: string, error: unknown): AttachError => ({
  _tag: "AttachFilesystemFailure",
  path,
  reason: reasonOf(error),
});

const makeBunFileSystem = (): AttachFileSystem => ({
  makeDirectory: (path) =>
    makeDirectory(path).pipe(Effect.mapError((error) => fileFailure(path, error))),
  writePrivateExclusive: (path, content) =>
    Effect.gen(function* () {
      yield* writeTextFileExclusive(path, content).pipe(
        Effect.mapError((error) => fileFailure(path, error)),
      );
      const metadata = yield* inspectFile(path).pipe(
        Effect.mapError((error) => fileFailure(path, error)),
      );
      if (metadata.mode !== 0o600 || metadata.uid !== currentUid()) {
        yield* Effect.ignore(removeFile(path));
        return yield* Effect.fail(
          fileFailure(path, "new SSH configuration is not owned with mode 0600"),
        );
      }
    }),
  inspect: (path) => inspectFile(path).pipe(Effect.mapError((error) => fileFailure(path, error))),
  removeOwned: (path) =>
    Effect.gen(function* () {
      const metadata = yield* inspectFile(path).pipe(
        Effect.mapError((error) => fileFailure(path, error)),
      );
      if (metadata.uid !== currentUid() || metadata.mode !== 0o600) {
        return yield* Effect.fail(
          fileFailure(path, "refusing to remove a file not owned with mode 0600"),
        );
      }
      yield* removeFile(path).pipe(Effect.mapError((error) => fileFailure(path, error)));
    }),
});

export const scrubbedEnvironment = (
  source: Readonly<Record<string, string | undefined>> = bunEnvironment(),
): Record<string, string> => {
  const entries = Object.entries(source).filter(([key, value]) => {
    if (value === undefined) return false;
    return (
      !key.startsWith("WORK_ENGINE_") && !key.startsWith("CF_ACCESS") && key !== "AUTHORIZATION"
    );
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
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
  fileSystem: AttachFileSystem = makeBunFileSystem(),
): Effect.Effect<AttachTarget, AttachError> =>
  Effect.gen(function* () {
    const alias = `work-engine-${resolution.resolutionId}`;
    const directory = yield* resolvePath(config.sshDirectory);
    const configPath = yield* resolvePath(directory, `${resolution.resolutionId}.conf`);
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
    const fileSystem = options.fileSystem ?? makeBunFileSystem();
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
  fileSystem: AttachFileSystem = makeBunFileSystem(),
): Effect.Effect<void, AttachError> => fileSystem.removeOwned(path);

import {
  EnvironmentCheckpointSchema,
  EnvironmentPairingSchema,
  decodeUnknownStrict,
  type EnvironmentCheckpoint,
  type EnvironmentPairing,
  type EnvironmentSnapshot,
} from "@work-engine/protocol";
import { getSandbox, type DirectoryBackup, type Sandbox } from "@cloudflare/sandbox";
import type { EnvironmentRuntime } from "./environment.ts";
import type { EnvironmentCredentialBroker } from "./environment-credentials.ts";
import { InvalidRequestError } from "./errors.ts";

const T3CODE_PORT = 3773;
const T3CODE_HOME = "/workspace/environment/t3code";
const REPOSITORY_DIR = "/workspace/environment/repository";
const T3CODE_PROCESS_ID = "t3code";
const BACKUP_TTL_SECONDS = 30 * 24 * 60 * 60;
const backupObjectKeys = (backupId: string): string[] => [
  `backups/${backupId}/data.sqsh`,
  `backups/${backupId}/meta.json`,
];
const SAFE_GIT_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface SandboxEnvironmentRuntimeOptions {
  readonly sandbox: DurableObjectNamespace<Sandbox>;
  readonly credentials: EnvironmentCredentialBroker;
  readonly backupBucket: R2Bucket;
  readonly publicOrigin: string;
  readonly now: () => string;
}

const requireSuccessfulExec = async (
  sandbox: Sandbox,
  command: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed with exit ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
  return result;
};

const requireSafeGitSegment = (value: string, field: string): string => {
  if (!SAFE_GIT_SEGMENT.test(value)) throw new InvalidRequestError(`${field} is not shell-safe`);
  return value;
};

const parsePairingOutput = (
  output: string,
): { readonly token: string; readonly expiresAt: string } => {
  const token = /^Token:\s*(\S+)\s*$/mu.exec(output)?.[1];
  const expiresAt = /^Expires:\s*(\S+)\s*$/mu.exec(output)?.[1];
  if (token === undefined || expiresAt === undefined) {
    throw new Error("T3Code did not emit a pairing token and expiry");
  }
  return { token, expiresAt };
};

export class CloudflareSandboxEnvironmentRuntime implements EnvironmentRuntime {
  readonly #options: SandboxEnvironmentRuntimeOptions;
  #activeSandbox: Sandbox | undefined;

  constructor(options: SandboxEnvironmentRuntimeOptions) {
    this.#options = options;
  }

  #sandbox(generationId: string): Sandbox {
    return getSandbox(this.#options.sandbox, generationId, { normalizeId: true });
  }

  #environmentId: string | undefined;
  async start(input: {
    readonly environmentId: string;
    readonly generationOrdinal: number;
    readonly keepAlive: true;
  }): Promise<{ readonly generationId: string }> {
    const generationId = `${input.environmentId}-g${String(input.generationOrdinal)}`;
    this.#environmentId = input.environmentId;
    const sandbox = this.#sandbox(generationId);
    await sandbox.setKeepAlive(input.keepAlive);
    await sandbox.exec("true");
    this.#activeSandbox = sandbox;
    return { generationId };
  }

  async initialize(input: {
    readonly repository: { readonly owner: string; readonly name: string };
    readonly baseCommit: string;
    readonly provider: "claude" | "codex";
  }): Promise<void> {
    const sandbox = this.#activeSandbox;
    if (sandbox === undefined) throw new Error("Sandbox must start before initialization");
    const owner = requireSafeGitSegment(input.repository.owner, "repository.owner");
    const name = requireSafeGitSegment(input.repository.name, "repository.name");
    const lease = await this.#options.credentials.lease({
      environmentId: this.#environmentId ?? "unknown",
      repository: input.repository,
      provider: input.provider,
    });
    await sandbox.setEnvVars({
      ...lease.environment,
      T3CODE_HOME,
      T3CODE_NO_BROWSER: "true",
      T3CODE_HOST: "0.0.0.0",
      T3CODE_PORT: String(T3CODE_PORT),
    });
    await requireSuccessfulExec(
      sandbox,
      [
        `mkdir -p ${REPOSITORY_DIR}`,
        `cd ${REPOSITORY_DIR}`,
        "git init",
        `git remote add origin https://github.com/${owner}/${name}.git`,
        `git -c http.extraHeader="Authorization: Bearer $GITHUB_TOKEN" fetch --depth=1 origin ${input.baseCommit}`,
        `git checkout --detach ${input.baseCommit}`,
      ].join(" && "),
    );
    await this.#startT3Code(sandbox);
  }

  async #startT3Code(sandbox: Sandbox): Promise<void> {
    const existing = await sandbox.getProcess(T3CODE_PROCESS_ID);
    if (existing !== null && (await existing.getStatus()) === "running") return;
    const process = await sandbox.startProcess(
      `t3 serve --host 0.0.0.0 --port ${String(T3CODE_PORT)} --base-dir ${T3CODE_HOME} ${REPOSITORY_DIR}`,
      { processId: T3CODE_PROCESS_ID, autoCleanup: false },
    );
    await process.waitForPort(T3CODE_PORT, {
      mode: "http",
      path: "/.well-known/t3/environment",
      status: 200,
      timeout: 120_000,
    });
  }

  async waitUntilReady(): Promise<void> {
    const sandbox = this.#activeSandbox;
    if (sandbox === undefined) throw new Error("Sandbox is not active");
    const process = await sandbox.getProcess(T3CODE_PROCESS_ID);
    if (process === null) throw new Error("T3Code process is not running");
    await process.waitForPort(T3CODE_PORT, {
      mode: "http",
      path: "/.well-known/t3/environment",
      status: 200,
      timeout: 30_000,
    });
  }

  async mintPairing(input: { readonly environmentId: string }): Promise<EnvironmentPairing> {
    const sandbox = this.#activeSandbox;
    if (sandbox === undefined) throw new Error("Sandbox is not active");
    const output = await requireSuccessfulExec(
      sandbox,
      `t3 pair --base-dir ${T3CODE_HOME} --ttl 10m --label cloudflare`,
    );
    const pairing = parsePairingOutput(output.stdout);
    return decodeUnknownStrict(EnvironmentPairingSchema, {
      endpoint: `${this.#options.publicOrigin}/v1/environments/${input.environmentId}/connect`,
      token: pairing.token,
      expiresAt: pairing.expiresAt,
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ],
    });
  }

  async checkpoint(snapshot: EnvironmentSnapshot): Promise<EnvironmentCheckpoint> {
    if (snapshot.generation === null) throw new Error("Cannot checkpoint without a generation");
    const sandbox = this.#sandbox(snapshot.generation.id);
    const process = await sandbox.getProcess(T3CODE_PROCESS_ID);
    if (process !== null && (await process.getStatus()) === "running") {
      await process.kill("SIGTERM");
      await process.waitForExit(30_000);
    }
    try {
      const checks = await requireSuccessfulExec(
        sandbox,
        `sqlite3 ${T3CODE_HOME}/userdata/state.sqlite 'PRAGMA integrity_check;' && git -C ${REPOSITORY_DIR} rev-parse HEAD`,
      );
      const lines = checks.stdout.trim().split(/\s+/u);
      if (lines[0] !== "ok") throw new Error("T3Code SQLite integrity check failed");
      const head = lines.at(-1);
      if (head === undefined) throw new Error("Git HEAD was not reported");
      const backup = await sandbox.createBackup({
        dir: "/workspace/environment",
        name: `${snapshot.environmentId}-g${String(snapshot.generation.ordinal)}`,
        ttl: BACKUP_TTL_SECONDS,
        gitignore: false,
      });
      return decodeUnknownStrict(EnvironmentCheckpointSchema, {
        generation: snapshot.generation.ordinal,
        stateCapture: "quiesced",
        head,
        versions: snapshot.versions,
        backup: { id: backup.id, dir: backup.dir },
        validated: true,
        createdAt: this.#options.now(),
      });
    } finally {
      await this.#startT3Code(sandbox);
    }
  }

  async recover(input: {
    readonly snapshot: EnvironmentSnapshot;
    readonly checkpoint: EnvironmentCheckpoint;
    readonly generationOrdinal: number;
  }): Promise<{ readonly generationId: string }> {
    const generationId = `${input.snapshot.environmentId}-g${String(input.generationOrdinal)}`;
    const sandbox = this.#sandbox(generationId);
    await sandbox.setKeepAlive(true);
    const backup: DirectoryBackup = {
      id: input.checkpoint.backup.id,
      dir: input.checkpoint.backup.dir,
    };
    const restored = await sandbox.restoreBackup(backup);
    if (!restored.success) throw new Error("Sandbox backup restore failed");
    const checks = await requireSuccessfulExec(
      sandbox,
      `sqlite3 ${T3CODE_HOME}/userdata/state.sqlite 'PRAGMA integrity_check;' && git -C ${REPOSITORY_DIR} rev-parse HEAD`,
    );
    const lines = checks.stdout.trim().split(/\s+/u);
    if (lines[0] !== "ok" || lines.at(-1) !== input.checkpoint.head) {
      throw new Error("Restored Sandbox failed SQLite or Git validation");
    }
    await this.#startT3Code(sandbox);
    this.#activeSandbox = sandbox;
    return { generationId };
  }

  async destroy(snapshot: EnvironmentSnapshot): Promise<void> {
    if (snapshot.generation !== null) {
      const sandbox = this.#sandbox(snapshot.generation.id);
      await sandbox.setKeepAlive(false);
      await sandbox.destroy();
    }
    if (snapshot.acceptedCheckpoint !== null) {
      await this.#options.backupBucket.delete(
        backupObjectKeys(snapshot.acceptedCheckpoint.backup.id),
      );
    }
  }

  async proxy(request: Request, generationId: string): Promise<Response> {
    const sandbox = this.#sandbox(generationId);
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/v1\/environments\/[^/]+\/connect/u, "") || "/";
    const proxied = new Request(url.toString(), request);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return sandbox.wsConnect(proxied, T3CODE_PORT);
    }
    return sandbox.containerFetch(proxied, T3CODE_PORT);
  }
}

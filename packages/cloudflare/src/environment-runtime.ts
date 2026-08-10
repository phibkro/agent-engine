import {
  EnvironmentCheckpointSchema,
  EnvironmentPairingSchema,
  decodeUnknownStrict,
  type EnvironmentCheckpoint,
  type EnvironmentPairing,
  type EnvironmentSnapshot,
} from "@work-engine/protocol";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
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
  if (!SAFE_GIT_SEGMENT.test(value) || value === "." || value === "..") {
    throw new InvalidRequestError(`${field} is not a safe repository path segment`);
  }
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
  #generationId: string | undefined;

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
    this.#generationId = generationId;
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
    const environmentId = this.#environmentId;
    const generationId = this.#generationId;
    if (environmentId === undefined || generationId === undefined) {
      throw new Error("Sandbox generation identity is unavailable");
    }
    const lease = await this.#options.credentials.lease({
      environmentId,
      generationId,
      repository: input.repository,
      provider: input.provider,
    });
    const broker = new URL(lease.brokerOrigin);
    await sandbox.setAllowedHosts([broker.hostname, "*.r2.cloudflarestorage.com"]);
    await sandbox.setEnvVars({
      T3CODE_BROKER_TOKEN: lease.generationToken,
      T3CODE_BROKER_EXPIRES_AT: lease.expiresAt,
      ...(input.provider === "claude"
        ? {
            ANTHROPIC_API_KEY: lease.generationToken,
            ANTHROPIC_BASE_URL: `${lease.brokerOrigin}/v1/provider/anthropic`,
          }
        : {
            OPENAI_API_KEY: lease.generationToken,
            OPENAI_BASE_URL: `${lease.brokerOrigin}/v1/provider/openai`,
          }),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${lease.generationToken}`,
      T3CODE_HOME,
      T3CODE_NO_BROWSER: "true",
      T3CODE_HOST: "0.0.0.0",
      T3CODE_PORT: String(T3CODE_PORT),
    });
    const remote = `${lease.brokerOrigin}/v1/git/${owner}/${name}`;
    await requireSuccessfulExec(
      sandbox,
      [
        `mkdir -p ${REPOSITORY_DIR}`,
        `cd ${REPOSITORY_DIR}`,
        "git init",
        `git remote add origin ${remote}`,
        `git fetch origin ${input.baseCommit}`,
        `git checkout --detach ${input.baseCommit}`,
        'git config user.name "Work Engine"',
        'git config user.email "work-engine@invalid"',
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
  async isReady(generationId: string): Promise<boolean> {
    const process = await this.#sandbox(generationId).getProcess(T3CODE_PROCESS_ID);
    return process !== null && (await process.getStatus()) === "running";
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

  async checkpoint(
    snapshot: EnvironmentSnapshot,
    options?: { readonly final?: boolean },
  ): Promise<EnvironmentCheckpoint> {
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
        `test -s ${T3CODE_HOME}/userdata/state.sqlite && sqlite3 ${T3CODE_HOME}/userdata/state.sqlite 'PRAGMA integrity_check;' && git -C ${REPOSITORY_DIR} rev-parse HEAD`,
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
      const candidate = decodeUnknownStrict(EnvironmentCheckpointSchema, {
        generation: snapshot.generation.ordinal,
        stateCapture: "quiesced",
        head,
        versions: snapshot.versions,
        backup: { id: backup.id, dir: backup.dir },
        validated: false,
        createdAt: this.#options.now(),
      });
      try {
        await this.#validateCheckpoint(snapshot.environmentId, candidate);
      } catch (cause) {
        await this.deleteCheckpoint(candidate).catch(() => undefined);
        throw cause;
      }
      return decodeUnknownStrict(EnvironmentCheckpointSchema, {
        ...candidate,
        validated: true,
      });
    } finally {
      if (options?.final !== true) await this.#startT3Code(sandbox);
    }
  }

  async #validateCheckpoint(
    environmentId: string,
    checkpoint: EnvironmentCheckpoint,
  ): Promise<void> {
    const sandbox = this.#sandbox(`${environmentId}-validation-${checkpoint.backup.id}`);
    try {
      await sandbox.setKeepAlive(false);
      const restored = await sandbox.restoreBackup({
        id: checkpoint.backup.id,
        dir: checkpoint.backup.dir,
      });
      if (!restored.success) throw new Error("Checkpoint validation restore failed");
      await this.#validateRestoredState(sandbox, checkpoint);
      await this.#startT3Code(sandbox);
    } finally {
      await sandbox.setKeepAlive(false).catch(() => undefined);
      await sandbox.destroy().catch(() => undefined);
    }
  }

  async #validateRestoredState(sandbox: Sandbox, checkpoint: EnvironmentCheckpoint): Promise<void> {
    const checks = await requireSuccessfulExec(
      sandbox,
      `test -s ${T3CODE_HOME}/userdata/state.sqlite && sqlite3 ${T3CODE_HOME}/userdata/state.sqlite 'PRAGMA integrity_check;' && git -C ${REPOSITORY_DIR} rev-parse HEAD`,
    );
    const lines = checks.stdout.trim().split(/\s+/u);
    if (lines[0] !== "ok" || lines.at(-1) !== checkpoint.head) {
      throw new Error("Restored Sandbox failed SQLite or Git validation");
    }
  }

  async #configureRecoveredGeneration(
    sandbox: Sandbox,
    input: {
      readonly snapshot: EnvironmentSnapshot;
      readonly generationId: string;
    },
  ): Promise<void> {
    const lease = await this.#options.credentials.lease({
      environmentId: input.snapshot.environmentId,
      generationId: input.generationId,
      repository: input.snapshot.repository,
      provider: input.snapshot.provider,
    });
    const broker = new URL(lease.brokerOrigin);
    await sandbox.setAllowedHosts([broker.hostname, "*.r2.cloudflarestorage.com"]);
    await sandbox.setEnvVars({
      T3CODE_BROKER_TOKEN: lease.generationToken,
      T3CODE_BROKER_EXPIRES_AT: lease.expiresAt,
      ...(input.snapshot.provider === "claude"
        ? {
            ANTHROPIC_API_KEY: lease.generationToken,
            ANTHROPIC_BASE_URL: `${lease.brokerOrigin}/v1/provider/anthropic`,
          }
        : {
            OPENAI_API_KEY: lease.generationToken,
            OPENAI_BASE_URL: `${lease.brokerOrigin}/v1/provider/openai`,
          }),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${lease.generationToken}`,
      T3CODE_HOME,
      T3CODE_NO_BROWSER: "true",
      T3CODE_HOST: "0.0.0.0",
      T3CODE_PORT: String(T3CODE_PORT),
    });
  }

  async deleteCheckpoint(checkpoint: EnvironmentCheckpoint): Promise<void> {
    await this.#options.backupBucket.delete(backupObjectKeys(checkpoint.backup.id));
  }
  async cleanupBackups(snapshot: EnvironmentSnapshot): Promise<void> {
    const tracked = new Set([
      ...snapshot.retainedCheckpoints.map((checkpoint) => checkpoint.backup.id),
      ...(snapshot.acceptedCheckpoint === null ? [] : [snapshot.acceptedCheckpoint.backup.id]),
    ]);
    const cutoff = Date.parse(this.#options.now()) - 24 * 60 * 60 * 1_000;
    const objects = await this.#listBackupObjects();
    await Promise.all(
      objects
        .filter((object) => {
          const match = /^backups\/([^/]+)\//u.exec(object.key);
          return (
            match !== null && !tracked.has(match[1] ?? "") && object.uploaded.getTime() <= cutoff
          );
        })
        .map((object) => this.#options.backupBucket.delete(object.key)),
    );
  }

  async #listBackupObjects(cursor?: string): Promise<R2Object[]> {
    const page = await this.#options.backupBucket.list({
      prefix: "backups/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!page.truncated) return [...page.objects];
    return [...page.objects, ...(await this.#listBackupObjects(page.cursor))];
  }
  async recover(input: {
    readonly snapshot: EnvironmentSnapshot;
    readonly checkpoint: EnvironmentCheckpoint;
    readonly generationOrdinal: number;
  }): Promise<{ readonly generationId: string }> {
    if (JSON.stringify(input.checkpoint.versions) !== JSON.stringify(input.snapshot.versions)) {
      throw new Error("Checkpoint runtime version tuple does not match the Environment");
    }
    const previousId = input.snapshot.generation?.id;
    if (previousId !== undefined) {
      await this.#options.credentials.revoke({
        environmentId: input.snapshot.environmentId,
        generationId: previousId,
      });
      const previous = this.#sandbox(previousId);
      await previous.setKeepAlive(false);
      await previous.destroy();
    }
    const generationId = `${input.snapshot.environmentId}-g${String(input.generationOrdinal)}`;
    const sandbox = this.#sandbox(generationId);
    try {
      await sandbox.setKeepAlive(true);
      const restored = await sandbox.restoreBackup({
        id: input.checkpoint.backup.id,
        dir: input.checkpoint.backup.dir,
      });
      if (!restored.success) throw new Error("Sandbox backup restore failed");
      await this.#validateRestoredState(sandbox, input.checkpoint);
      await this.#configureRecoveredGeneration(sandbox, {
        snapshot: input.snapshot,
        generationId,
      });
      await this.#startT3Code(sandbox);
      this.#activeSandbox = sandbox;
      this.#environmentId = input.snapshot.environmentId;
      this.#generationId = generationId;
      return { generationId };
    } catch (cause) {
      await this.#options.credentials
        .revoke({ environmentId: input.snapshot.environmentId, generationId })
        .catch(() => undefined);
      await sandbox.setKeepAlive(false).catch(() => undefined);
      await sandbox.destroy().catch(() => undefined);
      throw cause;
    }
  }

  async destroy(snapshot: EnvironmentSnapshot): Promise<void> {
    const generationIds = [
      ...(snapshot.generation === null ? [] : [snapshot.generation.id]),
      ...snapshot.retiredGenerationIds,
    ];
    const failures = (
      await Promise.all(
        [...new Set(generationIds)].map(async (generationId) => {
          const generationFailures: unknown[] = [];
          await this.#options.credentials
            .revoke({ environmentId: snapshot.environmentId, generationId })
            .catch((cause: unknown) => generationFailures.push(cause));
          const sandbox = this.#sandbox(generationId);
          await sandbox
            .setKeepAlive(false)
            .catch((cause: unknown) => generationFailures.push(cause));
          await sandbox.destroy().catch((cause: unknown) => generationFailures.push(cause));
          return generationFailures;
        }),
      )
    ).flat();
    const checkpoints = [
      ...snapshot.retainedCheckpoints,
      ...(snapshot.acceptedCheckpoint === null ? [] : [snapshot.acceptedCheckpoint]),
    ];
    await Promise.all(
      [
        ...new Map(checkpoints.map((checkpoint) => [checkpoint.backup.id, checkpoint])).values(),
      ].map((checkpoint) =>
        this.deleteCheckpoint(checkpoint).catch((cause: unknown) => failures.push(cause)),
      ),
    );
    if (failures.length > 0) throw new AggregateError(failures, "Environment cleanup failed");
  }

  async proxy(request: Request, generationId: string): Promise<Response> {
    const sandbox = this.#sandbox(generationId);
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\/v1\/environments\/[^/]+\/connect/u, "") || "/";
    const headers = new Headers(request.headers);
    headers.delete("X-Environment-Internal");
    const proxied = new Request(new Request(url.toString(), request), { headers });
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return sandbox.wsConnect(proxied, T3CODE_PORT);
    }
    return sandbox.containerFetch(proxied, T3CODE_PORT);
  }
}

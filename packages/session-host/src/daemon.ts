import type { SessionId, SessionStartSpec, WorkspaceLease, WorkspaceReady } from "@work-engine/protocol";
import { SessionHostRouter, type SessionHostAccessCredentials } from "./router.ts";
import { SessionHostService } from "./host.ts";
import { ModelProxy, type ModelProvider } from "./model-proxy.ts";
import { SessionMcpServer, type SessionMcpHandlers } from "./mcp.ts";
import {
  LinuxSessionIdentityProvider,
  SessionCredentialManager,
  scrubSessionEnvironment,
  ensurePrivateRuntime,
  type SessionIdentity,
  type SessionIdentityProvider,
} from "./security.ts";
import { BunFileSystem } from "./bun-platform.ts";
import type { Environment } from "./process.ts";
import { joinPath } from "./posix-path.ts";
import type { EffectExecutor } from "./execution.ts";

export interface ContainerVersions {
  readonly herdr: string;
  readonly omp: string;
  readonly bun: string;
  readonly integration: string;
  readonly work: string;
  readonly imageDigest: string;
}

export interface SessionRuntime {
  readonly sessionId: SessionId;
  readonly identity: SessionIdentity;
  readonly capabilityTokenFile: string;
  readonly modelTokenFile: string;
  readonly ompHome: string;
  readonly environment: Environment;
  readonly mcp: SessionMcpServer;
}

export interface SessionRuntimeManagerOptions {
  readonly identityProvider: SessionIdentityProvider;
  readonly credentials: SessionCredentialManager;
  readonly modelProxy: ModelProxy;
  readonly homeRoot: string;
  readonly hostUid?: number;
  readonly hostGid?: number;
  readonly fileSystem?: BunFileSystem;
  readonly handlers: (sessionId: SessionId, capabilityFile: string) => SessionMcpHandlers;
}
export class SessionRuntimeManager {
  private readonly sessions = new Map<SessionId, SessionRuntime>();
  private readonly fileSystem: BunFileSystem;

  constructor(private readonly options: SessionRuntimeManagerOptions) {
    this.fileSystem = options.fileSystem ?? new BunFileSystem();
  }
  get modelProxy(): ModelProxy {
    return this.options.modelProxy;
  }

  async create(spec: SessionStartSpec, worktree: string): Promise<SessionRuntime> {
    const existing = this.sessions.get(spec.sessionId);
    if (existing !== undefined) return existing;
    const identity = await this.options.identityProvider.allocate(spec.sessionId, worktree);
    const credentials = await this.options.credentials.issue(
      spec.sessionId,
      identity.capabilityFile,
      identity.modelTokenFile,
      identity.uid,
      identity.gid,
    );
    const ompHome = joinPath(this.options.homeRoot, spec.sessionId, ".omp");
    await this.fileSystem.makeDirectory(joinPath(ompHome, "agent"), {
      recursive: true,
      mode: 0o700,
    });
    await writeOwned(
      this.fileSystem,
      joinPath(ompHome, "agent", "models.yml"),
      modelsConfig(credentials.modelToken),
      identity.uid,
      identity.gid,
    );
    await writeOwned(
      this.fileSystem,
      joinPath(ompHome, "agent", "config.yml"),
      "modelRoles:\n  default: work-engine/gpt-oss-120b\n",
      identity.uid,
      identity.gid,
    );
    const environment = scrubSessionEnvironment({
      ...Bun.env,
      HOME: joinPath(this.options.homeRoot, spec.sessionId),
      USER: identity.username,
      WORK_ENGINE_CAPABILITY_FILE: credentials.capabilityFile,
      WORK_ENGINE_MODEL_TOKEN_FILE: credentials.modelTokenFile,
    });
    await this.options.modelProxy.registerSession(spec.sessionId, spec.outputLimit);
    const mcp = new SessionMcpServer({
      sessionId: spec.sessionId,
      capabilityFile: credentials.capabilityFile,
      credentials: this.options.credentials,
      handlers: this.options.handlers(spec.sessionId, credentials.capabilityFile),
      fileSystem: this.fileSystem,
    });
    const runtime: SessionRuntime = {
      sessionId: spec.sessionId,
      identity,
      capabilityTokenFile: credentials.capabilityFile,
      modelTokenFile: credentials.modelTokenFile,
      ompHome,
      environment,
      mcp,
    };
    this.sessions.set(spec.sessionId, runtime);
    return runtime;
  }

  async terminate(sessionId: SessionId): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime === undefined) return;
    await this.options.modelProxy.revokeSession(sessionId);
    await this.options.credentials.revoke(sessionId);
    await this.options.identityProvider.revoke(runtime.identity);
    this.sessions.delete(sessionId);
  }

  get(sessionId: SessionId): SessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  list(): readonly SessionRuntime[] {
    return [...this.sessions.values()];
  }
}

export interface SessionHostDaemonOptions {
  readonly host: SessionHostService;
  readonly access: SessionHostAccessCredentials;
  readonly modelProvider: ModelProvider;
  readonly versions: ContainerVersions;
  readonly runtimeDirectory: string;
  readonly herdrSocketPath: string;
  readonly sessionRuntime: SessionRuntimeManager;
  readonly effectExecutor: EffectExecutor;
  readonly mcpBySession?: (sessionId: SessionId) => SessionMcpServer | undefined;
  readonly port?: number;
}

/**
 * Container composition root. It accepts only the shared host wire routes,
 * model proxy, and a bound Session MCP projection. No operator endpoint is
 * mounted in this process.
 */
export class SessionHostDaemon {
  private readonly router: SessionHostRouter;
  private readonly modelProxy: ModelProxy;
  private server: { stop(): void } | undefined;
  private accepting = true;

  constructor(private readonly options: SessionHostDaemonOptions) {
    this.modelProxy = options.sessionRuntime.modelProxy;
    this.router = new SessionHostRouter({
      host: options.host,
      access: options.access,
      effectExecutor: options.effectExecutor,
    });
  }

  async ready(lease: WorkspaceLease): Promise<WorkspaceReady> {
    return this.options.effectExecutor.execute(this.options.host.ensureReady(lease));
  }


  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return this.health();
    if (!this.accepting) return json({ error: "host shutting down" }, 503);
    if (url.pathname.startsWith("/v1/session-host/")) return this.router.fetch(request);
    if (
      url.pathname.startsWith("/v1/sessions/") &&
      url.pathname.endsWith("/model/chat/completions")
    )
      return this.modelProxy.fetch(request);
    const mcp = /^\/v1\/sessions\/([^/]+)\/mcp$/u.exec(url.pathname);
    if (mcp !== null && mcp[1] !== undefined && this.options.mcpBySession !== undefined) {
      const server = this.options.mcpBySession(mcp[1] as SessionId);
      if (server !== undefined) return server.fetch(request);
    }
    return json({ error: "not found" }, 404);
  }

  async start(): Promise<{ readonly port: number }> {
    await ensurePrivateRuntime(this.options.runtimeDirectory, this.options.herdrSocketPath);
    const port = this.options.port ?? 8788;
    this.server = Bun.serve({ port, fetch: (request) => this.fetch(request) });
    return { port };
  }

  async stop(reason = "sigterm"): Promise<void> {
    this.accepting = false;
    await this.options.host.shutdown(reason);
    await forEachSequential(this.options.sessionRuntime.list(), (runtime) =>
      this.options.sessionRuntime.terminate(runtime.sessionId),
    );
    this.server?.stop();
    this.server = undefined;
  }

  private health(): Response {
    const versions = this.options.versions;
    if (
      versions.herdr !== "0.8.0" ||
      versions.omp !== "17.2.3" ||
      versions.bun !== "1.3.13" ||
      versions.work.length === 0 ||
      versions.integration.length === 0
    )
      return json({ ready: false, reason: "pinned runtime mismatch" }, 503);
    return json(
      {
        _tag: "WorkspaceReady",
        ready: true,
        herdr: versions.herdr,
        omp: versions.omp,
        bun: versions.bun,
        integration: versions.integration,
        work: versions.work,
        imageDigest: versions.imageDigest,
      },
      200,
    );
  }
}

export const makeDefaultSessionRuntimeManager = (
  options: Omit<SessionRuntimeManagerOptions, "identityProvider" | "credentials" | "modelProxy"> & {
    readonly identityProvider?: SessionIdentityProvider;
    readonly credentials?: SessionCredentialManager;
    readonly modelProxy: ModelProxy;
  },
): SessionRuntimeManager =>
  new SessionRuntimeManager({
    ...options,
    identityProvider:
      options.identityProvider ??
      new LinuxSessionIdentityProvider({
        homeRoot: options.homeRoot,
        capabilityRoot: joinPath(options.homeRoot, ".capabilities"),
        modelRoot: joinPath(options.homeRoot, ".model"),
        hostUid: options.hostUid,
        hostGid: options.hostGid,
        fileSystem: options.fileSystem,
      }),
    credentials: options.credentials ?? new SessionCredentialManager(),
    modelProxy: options.modelProxy,
  });

const modelsConfig = (token: string): string =>
  `providers:\n  work-engine:\n    baseUrl: http://127.0.0.1:8788/v1\n    api: openai-completions\n    apiKey: ${token}\n    models:\n      - id: gpt-oss-120b\n        name: Work Engine GPT-OSS 120B\n        contextWindow: 128000\n        maxTokens: 8192\n`;
const writeOwned = async (
  fileSystem: BunFileSystem,
  path: string,
  content: string,
  uid: number,
  gid: number,
): Promise<void> => {
  await fileSystem.writeFile(path, content, { mode: 0o600 });
  await fileSystem.chmod(path, 0o600);
  await fileSystem.chown(path, uid, gid);
};

const forEachSequential = async <A>(
  values: readonly A[],
  operation: (value: A) => Promise<void>,
  index = 0,
): Promise<void> => {
  const value = values[index];
  if (value === undefined) return;
  await operation(value);
  await forEachSequential(values, operation, index + 1);
};
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

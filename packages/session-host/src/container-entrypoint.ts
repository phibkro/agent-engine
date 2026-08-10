import type { SessionId, Timestamp, WorkspaceReady } from "@work-engine/protocol";
import { Sha256DigestSchema, WorkspaceReadySchema } from "@work-engine/protocol";
import { JsonFileStartClaimStore } from "./persistence.ts";
import { HerdrSessionController, MemoryProcessSupervisor, NodeCommandRunner, scrubHerdrEnvironment, type CommandRunner } from "./process.ts";
import { InMemoryReadinessProbe, SessionHostService } from "./host.ts";
import { ModelProxy, type ModelChatRequest, type ModelProvider } from "./model-proxy.ts";
import { LinuxSessionIdentityProvider, SessionCredentialManager } from "./security.ts";
import { SessionRuntimeManager, SessionHostDaemon, type ContainerVersions } from "./daemon.ts";

class LocalReadinessProbe extends InMemoryReadinessProbe {
  constructor(private readonly commandRunner: CommandRunner, private readonly environment: NodeJS.ProcessEnv) {
    super(async () => {
      const commands: readonly (readonly string[])[] = [["herdr", "--version"], ["omp", "--version"], ["work", "--version"]];
      for (const command of commands) {
        const result = await commandRunner.run(command, { env: scrubHerdrEnvironment(environment) });
        if (result.exitCode !== 0) throw new Error(`${command[0]} readiness failed`);
      }
      const ready: WorkspaceReady = {
        _tag: "WorkspaceReady",
        instanceId: required("WORK_ENGINE_INSTANCE_ID", environment),
        containerGeneration: required("WORK_ENGINE_CONTAINER_GENERATION", environment),
        imageDigest: Sha256DigestSchema.make(required("WORK_ENGINE_IMAGE_DIGEST", environment)),
        readyAt: new Date().toISOString() as Timestamp,
      };
      return WorkspaceReadySchema.make(ready);
    });
  }
}

class HttpModelProvider implements ModelProvider {
  constructor(private readonly endpoint: string, private readonly clientId: string, private readonly clientSecret: string) {}

  async complete(request: ModelChatRequest, providerModel: "@cf/openai/gpt-oss-120b"): Promise<unknown> {
    if (this.endpoint.length === 0) throw new Error("model endpoint is not configured");
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Access-Client-Id": this.clientId,
        "CF-Access-Client-Secret": this.clientSecret,
      },
      body: JSON.stringify({ ...request, model: providerModel }),
    });
    if (!response.ok) throw new Error(`model provider returned ${response.status}`);
    return response.json();
  }
}

const main = async (): Promise<void> => {
  const environment = process.env;
  const runner: CommandRunner = new NodeCommandRunner();
  const runtimeDirectory = environment.WORK_ENGINE_RUNTIME_DIR ?? "/run/work-engine";
  const socketPath = environment.WORK_ENGINE_HERDR_SOCKET ?? `${runtimeDirectory}/herdr.sock`;
  const workspaceDirectory = environment.WORK_ENGINE_WORKSPACE_ROOT ?? "/var/lib/work-engine/sessions";
  const sessionHome = environment.WORK_ENGINE_SESSION_HOME_ROOT ?? "/var/lib/work-engine/sessions";
  const claims = new JsonFileStartClaimStore(`${runtimeDirectory}/start-claims.json`);
  const supervisor = new MemoryProcessSupervisor();
  const provider = new HttpModelProvider(
    required("WORK_ENGINE_MODEL_ENDPOINT", environment),
    required("CF_ACCESS_CLIENT_ID", environment),
    required("CF_ACCESS_CLIENT_SECRET", environment),
  );
  const credentials = new SessionCredentialManager();
  const modelProxy = new ModelProxy({ credentials, provider });
  let host: SessionHostService | undefined;
  const runtimeManager = new SessionRuntimeManager({
    identityProvider: new LinuxSessionIdentityProvider({
      homeRoot: sessionHome,
      capabilityRoot: `${runtimeDirectory}/capabilities`,
      modelRoot: `${runtimeDirectory}/model-tokens`,
      commandRunner: runner,
    }),
    credentials,
    modelProxy,
    homeRoot: sessionHome,
    handlers: (sessionId) => ({
      observeProject: async () => remoteProjectQuery(environment),
      sessionStatus: async () => (await host?.snapshot()) ?? { accepting: false, claims: [] },
      startSession: async (_managerSessionId, workId) => remoteStartRequest(environment, sessionId, workId),
      finalizeCandidate: async (request) => {
        if (host === undefined) throw new Error("Session host is not ready");
        return host.finalizeCandidate(request);
      },
    }),
  });
  const controller = new HerdrSessionController({
    runner,
    supervisor,
    sessionName: environment.WORK_ENGINE_HERDR_SESSION ?? "work-engine-project",
    runtimeDirectory,
    workspaceDirectory,
    environment,
  });
  host = new SessionHostService({
    claims,
    processController: controller,
    readiness: new LocalReadinessProbe(runner, environment),
    lifecycle: {
      onStarted: async ({ spec }) => runtimeManager.create(spec, `${workspaceDirectory}/${spec.sessionId}`),
      onTerminal: async ({ sessionId }) => runtimeManager.terminate(sessionId),
    },
  });
  const versions: ContainerVersions = {
    herdr: "0.8.0",
    omp: "17.2.3",
    bun: "1.3.13",
    integration: "8",
    work: required("WORK_ENGINE_VERSION", environment),
    imageDigest: Sha256DigestSchema.make(required("WORK_ENGINE_IMAGE_DIGEST", environment)),
  };
  const daemon = new SessionHostDaemon({
    host,
    access: { clientId: required("CF_ACCESS_CLIENT_ID", environment), clientSecret: required("CF_ACCESS_CLIENT_SECRET", environment) },
    modelProvider: provider,
    versions,
    runtimeDirectory,
    herdrSocketPath: socketPath,
    sessionRuntime: runtimeManager,
    mcpBySession: (sessionId) => runtimeManager.get(sessionId)?.mcp,
    port: Number(environment.WORK_ENGINE_PORT ?? "8788"),
  });
  process.once("SIGTERM", () => {
    void daemon.stop("sigterm").then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void daemon.stop("sigint").then(() => process.exit(130));
  });
  await daemon.start();
};

const remoteProjectQuery = async (environment: NodeJS.ProcessEnv): Promise<unknown> => {
  const response = await fetch(required("WORK_ENGINE_PROJECT_QUERY_ENDPOINT", environment), { headers: accessHeaders(environment) });
  if (!response.ok) throw new Error(`Project query returned ${response.status}`);
  return response.json();
};

const remoteStartRequest = async (environment: NodeJS.ProcessEnv, managerSessionId: SessionId, workId: string): Promise<unknown> => {
  const response = await fetch(required("WORK_ENGINE_SESSION_START_ENDPOINT", environment), {
    method: "POST",
    headers: { ...accessHeaders(environment), "content-type": "application/json" },
    body: JSON.stringify({ managerSessionId, workId }),
  });
  if (!response.ok) throw new Error(`Session start returned ${response.status}`);
  return response.json();
};

const accessHeaders = (environment: NodeJS.ProcessEnv): HeadersInit => ({
  "CF-Access-Client-Id": required("CF_ACCESS_CLIENT_ID", environment),
  "CF-Access-Client-Secret": required("CF_ACCESS_CLIENT_SECRET", environment),
});

const required = (name: string, environment: NodeJS.ProcessEnv): string => {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

await main();

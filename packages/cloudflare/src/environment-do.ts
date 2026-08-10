import {
  EnvironmentSnapshotSchema,
  RuntimeVersionTupleSchema,
  decodeUnknownStrict,
  type EnvironmentSnapshot,
} from "@work-engine/protocol";
import type { EnvironmentStore } from "./environment.ts";
import { EnvironmentCoordinator } from "./environment.ts";
import { CloudflareSandboxEnvironmentRuntime } from "./environment-runtime.ts";
import { FetcherEnvironmentCredentialBroker } from "./environment-credentials.ts";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { InvalidRequestError, UnauthorizedError } from "./errors.ts";

const SNAPSHOT_KEY = "environment";
const CONNECTION_COUNT_KEY = "active-connections";
const MAX_CONNECTIONS = 10;

class DurableEnvironmentStore implements EnvironmentStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async load(): Promise<EnvironmentSnapshot | undefined> {
    const stored = await this.#storage.get<unknown>(SNAPSHOT_KEY);
    return stored === undefined
      ? undefined
      : decodeUnknownStrict(EnvironmentSnapshotSchema, stored);
  }

  async save(snapshot: EnvironmentSnapshot): Promise<void> {
    await this.#storage.put(SNAPSHOT_KEY, snapshot);
  }
}

const requestPayload = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError("Environment command body must be an object");
  }
  return value as Record<string, unknown>;
};

const jsonError = (cause: unknown): Response => {
  if (cause instanceof UnauthorizedError) {
    return Response.json({ _tag: cause._tag, reason: cause.message }, { status: 403 });
  }
  if (cause instanceof InvalidRequestError) {
    return Response.json({ _tag: cause._tag, reason: cause.message }, { status: 400 });
  }
  return Response.json(
    {
      _tag: "EnvironmentRuntimeFailure",
      reason: cause instanceof Error ? cause.message : "Unknown failure",
    },
    { status: 500 },
  );
};

/** One Environment DO serializes lifecycle changes and owns exactly one live Sandbox generation. */
export class EnvironmentDurableObject implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: CloudflareRuntimeEnv;

  constructor(state: DurableObjectState, env: CloudflareRuntimeEnv) {
    this.#state = state;
    this.#env = env;
  }

  #coordinator(): {
    readonly coordinator: EnvironmentCoordinator;
    readonly runtime: CloudflareSandboxEnvironmentRuntime;
  } {
    const sandbox = this.#env.SANDBOX;
    const backupBucket = this.#env.BACKUP_BUCKET;
    const credentialFetcher = this.#env.CREDENTIAL_BROKER ?? {
      fetch: (input: string, init?: RequestInit) => fetch(input, init),
    };
    const credentialEndpoint = this.#env.CREDENTIAL_BROKER_URL;
    const credentialSecret = this.#env.CREDENTIAL_BROKER_SECRET;
    const publicOrigin = this.#env.ENVIRONMENT_PUBLIC_ORIGIN;
    if (
      backupBucket === undefined ||
      sandbox === undefined ||
      credentialEndpoint === undefined ||
      credentialSecret === undefined ||
      publicOrigin === undefined
    ) {
      throw new Error("Environment runtime bindings are incomplete");
    }
    const credentials = new FetcherEnvironmentCredentialBroker(
      credentialFetcher,
      credentialEndpoint,
      credentialSecret,
    );
    const runtime = new CloudflareSandboxEnvironmentRuntime({
      sandbox,
      backupBucket,
      credentials,
      publicOrigin: publicOrigin.replace(/\/$/u, ""),
      now: () => new Date().toISOString(),
    });
    const versions = decodeUnknownStrict(RuntimeVersionTupleSchema, {
      imageDigest: this.#env.ENVIRONMENT_IMAGE_DIGEST,
      t3codeVersion: this.#env.T3CODE_VERSION,
      sandboxSdkVersion: this.#env.SANDBOX_SDK_VERSION,
    });
    return {
      runtime,
      coordinator: new EnvironmentCoordinator({
        store: new DurableEnvironmentStore(this.#state.storage),
        runtime,
        versions,
        now: () => new Date().toISOString(),
      }),
    };
  }

  async #authorize(request: Request): Promise<void> {
    const expected = this.#env.ENVIRONMENT_ROUTER_SECRET;
    const presented = request.headers.get("X-Environment-Internal");
    if (expected === undefined || presented === null || presented !== expected) {
      throw new UnauthorizedError("Environment DO calls require the authenticated router binding");
    }
  }

  async #schedule(snapshot: EnvironmentSnapshot): Promise<void> {
    if (snapshot.lifecycle === "Destroyed") {
      await this.#state.storage.deleteAlarm();
      return;
    }
    await this.#state.storage.setAlarm(
      Math.min(Date.parse(snapshot.expiresAt), Date.parse(snapshot.inactivityDeadline)),
    );
  }

  async #proxy(
    request: Request,
    runtime: CloudflareSandboxEnvironmentRuntime,
    generationId: string,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return runtime.proxy(request, generationId);
    }
    const active = (await this.#state.storage.get<number>(CONNECTION_COUNT_KEY)) ?? 0;
    if (active >= MAX_CONNECTIONS) {
      return Response.json({ _tag: "EnvironmentConnectionLimit" }, { status: 429 });
    }
    const upstreamResponse = await runtime.proxy(request, generationId);
    const upstream = upstreamResponse.webSocket;
    if (upstream === null) throw new Error("Sandbox did not accept the WebSocket connection");
    const sockets = Object.values(new WebSocketPair());
    const client = sockets[0];
    const bridge = sockets[1];
    if (client === undefined || bridge === undefined) {
      throw new Error("Cloudflare did not create a WebSocket pair");
    }
    bridge.accept();
    upstream.accept();
    await this.#state.storage.put(CONNECTION_COUNT_KEY, active + 1);
    let closed = false;
    const release = (): void => {
      if (closed) return;
      closed = true;
      this.#state.waitUntil(
        this.#state.storage.transaction(async (transaction) => {
          const count = (await transaction.get<number>(CONNECTION_COUNT_KEY)) ?? 1;
          await transaction.put(CONNECTION_COUNT_KEY, Math.max(0, count - 1));
        }),
      );
    };
    bridge.addEventListener("message", (event) => upstream.send(event.data));
    upstream.addEventListener("message", (event) => bridge.send(event.data));
    bridge.addEventListener("close", (event) => {
      release();
      upstream.close(event.code, event.reason);
    });
    upstream.addEventListener("close", (event) => {
      release();
      bridge.close(event.code, event.reason);
    });
    bridge.addEventListener("error", () => {
      release();
      upstream.close(1011, "Client WebSocket failed");
    });
    upstream.addEventListener("error", () => {
      release();
      bridge.close(1011, "Sandbox WebSocket failed");
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.#authorize(request);
      const { coordinator, runtime } = this.#coordinator();
      const url = new URL(request.url);
      if (url.pathname.includes("/connect")) {
        const current = await coordinator.inspect();
        if (current?.lifecycle !== "Ready" || current.generation === null) {
          throw new InvalidRequestError("Environment is not ready for connections");
        }
        const response = await this.#proxy(request, runtime, current.generation.id);
        if (response.status < 400) {
          const active = await coordinator.recordActivity();
          await this.#schedule(active);
        }
        return response;
      }
      if (request.method === "GET") {
        return Response.json({
          _tag: "EnvironmentInspected",
          snapshot: await coordinator.inspect(),
        });
      }
      const payload = await requestPayload(request);
      const tag = payload["_tag"];
      if (tag === "CreateEnvironment") {
        const created = await coordinator.create(payload);
        await this.#schedule(created.snapshot);
        return Response.json({ _tag: "EnvironmentCreated", ...created });
      }
      if (tag === "RecoverEnvironment") {
        const recovered = await coordinator.recover(payload);
        await this.#schedule(recovered);
        return Response.json({ _tag: "EnvironmentRecovered", snapshot: recovered });
      }
      if (tag === "DestroyEnvironment") {
        const destroyed = await coordinator.destroy(payload);
        await this.#schedule(destroyed);
        return Response.json({ _tag: "EnvironmentDestroyed", snapshot: destroyed });
      }
      if (tag === "CheckpointEnvironment") {
        const checkpointed = await coordinator.checkpoint();
        await this.#schedule(checkpointed);
        return Response.json({ _tag: "EnvironmentCheckpointed", snapshot: checkpointed });
      }
      throw new InvalidRequestError("Unsupported Environment operation");
    } catch (cause) {
      return jsonError(cause);
    }
  }

  async alarm(): Promise<void> {
    const { coordinator } = this.#coordinator();
    const current = await coordinator.inspect();
    if (current === undefined || current.lifecycle === "Destroyed") return;
    const now = Date.now();
    if (now < Date.parse(current.expiresAt) && now < Date.parse(current.inactivityDeadline)) {
      await this.#schedule(current);
      return;
    }
    const destroyed = await coordinator.destroy({
      _tag: "DestroyEnvironment",
      commandId: "destroy-00000000-0000-4000-8000-000000000000",
      environmentId: current.environmentId,
    });
    await this.#schedule(destroyed);
  }
}

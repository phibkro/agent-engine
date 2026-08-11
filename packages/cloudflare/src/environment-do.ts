import * as Schema from "effect/Schema";
import {
  EnvironmentCheckpointedResponseSchema,
  EnvironmentCommandRequestSchema,
  EnvironmentCreatedResponseSchema,
  EnvironmentDestroyedResponseSchema,
  EnvironmentFailureSchema,
  EnvironmentInspectedResponseSchema,
  EnvironmentRecoveredResponseSchema,
  EnvironmentSnapshotSchema,
  RuntimeVersionTupleSchema,
  decodeUnknownStrict,
  type EnvironmentCommandRequest,
  type EnvironmentSnapshot,
} from "@work-engine/protocol";
import type { EnvironmentStore } from "./environment.ts";
import { EnvironmentCoordinator } from "./environment.ts";
import type { PlatformCapabilities } from "./contract.ts";
import { CloudflareSandboxEnvironmentRuntime } from "./environment-runtime.ts";
import { FetcherEnvironmentCredentialBroker } from "./environment-credentials.ts";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { InvalidRequestError, ProviderUnavailableError, UnauthorizedError } from "./errors.ts";
import { cloudflarePlatformCapabilities } from "./platform-capabilities.ts";

const SNAPSHOT_KEY = "environment";
const MAX_CONNECTIONS = 10;
const EnvironmentCommandJsonSchema = Schema.fromJsonString(EnvironmentCommandRequestSchema);
const EnvironmentConnectionLimitSchema = Schema.TaggedStruct("EnvironmentConnectionLimit", {});

const jsonResponse = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  init?: ResponseInit,
): Response => Response.json(decodeUnknownStrict(schema, value), init);

const persistedSnapshot = (value: unknown): EnvironmentSnapshot => {
  try {
    return decodeUnknownStrict(EnvironmentSnapshotSchema, value);
  } catch (cause) {
    throw new InvalidRequestError("Persisted Environment snapshot is invalid", cause);
  }
};

class DurableEnvironmentStore implements EnvironmentStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async load(): Promise<EnvironmentSnapshot | undefined> {
    const stored = await this.#storage.get<unknown>(SNAPSHOT_KEY);
    return stored === undefined ? undefined : persistedSnapshot(stored);
  }

  async save(value: EnvironmentSnapshot): Promise<void> {
    await this.#storage.put(SNAPSHOT_KEY, persistedSnapshot(value));
  }
}

const requestPayload = async (request: Request): Promise<EnvironmentCommandRequest> => {
  let body: string;
  try {
    body = await request.text();
  } catch (cause) {
    throw new InvalidRequestError("Environment command body must be JSON", cause);
  }
  try {
    return decodeUnknownStrict(EnvironmentCommandJsonSchema, body);
  } catch (cause) {
    throw new InvalidRequestError("Environment command body is invalid", cause);
  }
};

const publicSnapshot = (snapshot: EnvironmentSnapshot | undefined): unknown =>
  snapshot === undefined
    ? undefined
    : {
        ...snapshot,
        commandReceipts: snapshot.commandReceipts.map((receipt) => ({
          ...receipt,
          result:
            typeof receipt.result === "object" &&
            receipt.result !== null &&
            !Array.isArray(receipt.result) &&
            "token" in receipt.result
              ? Object.fromEntries(
                  Object.entries(receipt.result).filter(([name]) => name !== "token"),
                )
              : receipt.result,
        })),
      };
const jsonError = (cause: unknown): Response => {
  if (cause instanceof UnauthorizedError) {
    return jsonResponse(
      EnvironmentFailureSchema,
      { _tag: cause._tag, reason: cause.message },
      { status: 403 },
    );
  }
  if (cause instanceof InvalidRequestError) {
    return jsonResponse(
      EnvironmentFailureSchema,
      { _tag: cause._tag, reason: cause.message },
      { status: 400 },
    );
  }
  if (cause instanceof ProviderUnavailableError) {
    return jsonResponse(
      EnvironmentFailureSchema,
      { _tag: cause._tag, reason: cause.message },
      { status: 503 },
    );
  }
  return jsonResponse(
    EnvironmentFailureSchema,
    {
      _tag: "EnvironmentRuntimeFailure",
      reason: "Environment runtime failed",
    },
    { status: 500 },
  );
};

/** One Environment DO serializes lifecycle changes and owns exactly one live Sandbox generation. */
export class EnvironmentDurableObject implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: CloudflareRuntimeEnv;
  readonly #capabilities: PlatformCapabilities;
  #activeConnections = 0;

  constructor(
    state: DurableObjectState,
    env: CloudflareRuntimeEnv,
    capabilities: PlatformCapabilities = cloudflarePlatformCapabilities,
  ) {
    this.#state = state;
    this.#env = env;
    this.#capabilities = capabilities;
  }

  #coordinator(): {
    readonly coordinator: EnvironmentCoordinator;
    readonly runtime: CloudflareSandboxEnvironmentRuntime;
  } {
    const sandbox = this.#env.SANDBOX;
    const backupBucket = this.#env.BACKUP_BUCKET;
    if (sandbox === undefined || backupBucket === undefined) {
      throw new InvalidRequestError("Environment runtime bindings are incomplete");
    }
    const credentialFetcher = this.#env.CREDENTIAL_BROKER;
    const credentialEndpoint = this.#env.CREDENTIAL_BROKER_URL;
    const credentialSecret = this.#env.CREDENTIAL_BROKER_SECRET;
    const publicOrigin = this.#env.ENVIRONMENT_PUBLIC_ORIGIN;
    if (
      credentialFetcher === undefined ||
      credentialEndpoint === undefined ||
      credentialSecret === undefined ||
      publicOrigin === undefined
    ) {
      throw new InvalidRequestError("Environment runtime bindings are incomplete");
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
      now: this.#capabilities.now,
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
        capabilities: this.#capabilities,
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
    if (snapshot.lifecycle === "Failed") {
      await this.#state.storage.setAlarm(Date.parse(this.#capabilities.now()) + 60_000);
      return;
    }
    await this.#state.storage.setAlarm(
      Math.min(
        Date.parse(snapshot.expiresAt),
        Date.parse(snapshot.inactivityDeadline),
        ...(this.#activeConnections === 0 && snapshot.checkpointRetryAt !== null
          ? [Date.parse(snapshot.checkpointRetryAt)]
          : []),
        ...(snapshot.recoveryRetryAt === null ? [] : [Date.parse(snapshot.recoveryRetryAt)]),
      ),
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
    if (this.#activeConnections >= MAX_CONNECTIONS) {
      return jsonResponse(
        EnvironmentConnectionLimitSchema,
        { _tag: "EnvironmentConnectionLimit" },
        {
          status: 429,
        },
      );
    }
    const upstreamResponse = await runtime.proxy(request, generationId);
    const upstream = upstreamResponse.webSocket;
    if (upstream === null) {
      throw new ProviderUnavailableError(
        "Cloudflare Sandbox",
        "did not accept the WebSocket connection",
      );
    }
    const sockets = Object.values(new WebSocketPair());
    const client = sockets[0];
    const bridge = sockets[1];
    if (client === undefined || bridge === undefined) {
      throw new ProviderUnavailableError("Cloudflare Workers", "did not create a WebSocket pair");
    }
    bridge.accept();
    upstream.accept();
    this.#activeConnections += 1;
    let closed = false;
    const release = (): void => {
      if (closed) return;
      closed = true;
      this.#activeConnections = Math.max(0, this.#activeConnections - 1);
      this.#state.waitUntil(
        (async () => {
          const { coordinator } = this.#coordinator();
          let active = await coordinator.recordActivity();
          if (this.#activeConnections === 0 && active.lifecycle === "Ready") {
            active = await coordinator
              .checkpoint()
              .catch((cause: unknown) => this.#rescheduleAfterFailure(coordinator, cause));
          }
          await this.#schedule(active);
        })(),
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
        let current = await coordinator.inspect();
        if (current?.lifecycle !== "Ready" || current.generation === null) {
          throw new InvalidRequestError("Environment is not ready for connections");
        }
        if (!(await runtime.isReady(current.generation.id))) {
          current = await coordinator.recover({
            _tag: "RecoverEnvironment",
            commandId: `recover-${this.#capabilities.uuid()}`,
            environmentId: current.environmentId,
          });
          await this.#schedule(current);
        }
        if (current.generation === null) {
          throw new InvalidRequestError("Recovered Environment has no generation");
        }
        const response = await this.#proxy(request, runtime, current.generation.id);
        if (response.status === 101) {
          const active = await coordinator.recordActivity();
          await this.#schedule(active);
        }
        return response;
      }
      if (request.method === "GET") {
        const inspected = await coordinator.inspect();
        return jsonResponse(EnvironmentInspectedResponseSchema, {
          _tag: "EnvironmentInspected",
          ...(inspected === undefined ? {} : { snapshot: publicSnapshot(inspected) }),
        });
      }
      const payload = await requestPayload(request);
      const tag = payload._tag;
      if (tag === "CreateEnvironment") {
        const created = await coordinator.create(payload);
        await this.#schedule(created.snapshot);
        const pairingUrl = `${created.pairing.endpoint}#${new URLSearchParams({ token: created.pairing.token }).toString()}`;
        return jsonResponse(EnvironmentCreatedResponseSchema, {
          _tag: "EnvironmentCreated",
          snapshot: publicSnapshot(created.snapshot),
          pairingUrl,
          expiresAt: created.pairing.expiresAt,
          scopes: created.pairing.scopes,
        });
      }
      if (tag === "RecoverEnvironment") {
        const recovered = await coordinator.recover(payload);
        await this.#schedule(recovered);
        return jsonResponse(EnvironmentRecoveredResponseSchema, {
          _tag: "EnvironmentRecovered",
          snapshot: publicSnapshot(recovered),
        });
      }
      if (tag === "DestroyEnvironment") {
        const destroyed = await coordinator.destroy(payload);
        await this.#schedule(destroyed);
        return jsonResponse(EnvironmentDestroyedResponseSchema, {
          _tag: "EnvironmentDestroyed",
          snapshot: publicSnapshot(destroyed),
        });
      }
      if (tag === "CheckpointEnvironment") {
        if (this.#activeConnections > 0) {
          throw new InvalidRequestError(
            "Environment checkpoint requires all accepted WebSocket connections to close",
          );
        }
        const checkpointed = await coordinator.checkpoint(payload);
        await this.#schedule(checkpointed);
        return jsonResponse(EnvironmentCheckpointedResponseSchema, {
          _tag: "EnvironmentCheckpointed",
          snapshot: publicSnapshot(checkpointed),
        });
      }
      throw new InvalidRequestError("Unsupported Environment operation");
    } catch (cause) {
      let rescheduleFailure: unknown;
      try {
        const current = await this.#coordinator().coordinator.inspect();
        if (current !== undefined) await this.#schedule(current);
      } catch (cleanupFailure) {
        rescheduleFailure = cleanupFailure;
      }
      return jsonError(
        rescheduleFailure === undefined
          ? cause
          : new ProviderUnavailableError(
              "Environment Durable Object",
              "Failure cleanup could not be rescheduled",
              new AggregateError([cause, rescheduleFailure]),
            ),
      );
    }
  }

  async #rescheduleAfterFailure(
    coordinator: EnvironmentCoordinator,
    cause: unknown,
  ): Promise<never> {
    const latest = await coordinator.inspect();
    if (latest !== undefined) await this.#schedule(latest);
    throw cause;
  }

  async alarm(): Promise<void> {
    const { coordinator, runtime } = this.#coordinator();
    const current = await coordinator.inspect();
    if (current === undefined || current.lifecycle === "Destroyed") return;
    const now = Date.parse(this.#capabilities.now());
    const cleanupBackups = async (next: EnvironmentSnapshot): Promise<void> => {
      try {
        await runtime.cleanupBackups(next);
      } catch (cause) {
        const failure =
          cause instanceof ProviderUnavailableError
            ? cause
            : new ProviderUnavailableError(
                "Environment backup storage",
                "Backup garbage collection failed",
                cause,
              );
        await this.#rescheduleAfterFailure(coordinator, failure);
      }
    };

    let next: EnvironmentSnapshot;
    let terminal = false;
    if (current.lifecycle === "Failed") {
      next = await coordinator
        .destroy({
          _tag: "DestroyEnvironment",
          commandId: "destroy-00000000-0000-4000-8000-000000000000",
          environmentId: current.environmentId,
        })
        .catch((cause: unknown) => this.#rescheduleAfterFailure(coordinator, cause));
      terminal = true;
    } else if (
      current.lifecycle === "Ready" &&
      current.recoveryRetryAt !== null &&
      current.recoveryRequest !== null &&
      now >= Date.parse(current.recoveryRetryAt)
    ) {
      next = await coordinator
        .recover(current.recoveryRequest)
        .catch((cause: unknown) => this.#rescheduleAfterFailure(coordinator, cause));
    } else if (
      current.lifecycle === "Ready" &&
      current.checkpointRetryAt !== null &&
      now >= Date.parse(current.checkpointRetryAt) &&
      this.#activeConnections === 0
    ) {
      next = await coordinator
        .checkpoint()
        .catch((cause: unknown) => this.#rescheduleAfterFailure(coordinator, cause));
    } else if (this.#activeConnections > 0 && now < Date.parse(current.expiresAt)) {
      next = await coordinator.recordActivity();
    } else if (
      now < Date.parse(current.expiresAt) &&
      now < Date.parse(current.inactivityDeadline)
    ) {
      next = current;
    } else {
      next = await coordinator.destroy({
        _tag: "DestroyEnvironment",
        commandId: "destroy-00000000-0000-4000-8000-000000000000",
        environmentId: current.environmentId,
      });
      terminal = true;
    }

    await this.#schedule(next);
    if (terminal) return;
    await cleanupBackups(next);
  }
}

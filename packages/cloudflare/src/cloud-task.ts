import type { DurableObjectState } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";
import {
  CloudTaskCancelRequestSchema,
  CloudTaskCancelResponseSchema,
  CloudTaskObserveRequestSchema,
  CloudTaskObserveResponseSchema,
  CloudTaskResultRequestSchema,
  CloudTaskResultResponseSchema,
  CloudTaskSendRequestSchema,
  CloudTaskSendResponseSchema,
  CloudTaskSpawnRequestSchema,
  CloudTaskSpawnResponseSchema,
  TerminalSessionStateSchema,
} from "@work-engine/protocol";
import type { CloudTaskRequest, CloudTaskResponse } from "@work-engine/protocol";
import {
  CloudTaskRequestSchema,
  CloudTaskSchema,
  SessionIdSchema,
  decode,
  encode,
  type CloudTask,
  type PlatformCapabilities,
  type SessionId,
} from "./contract.ts";
import {
  CLOUD_TASK_AUTHORIZATION,
  CLOUD_TASK_BEARER_PREFIX,
  type CloudflareRuntimeEnv,
  SESSION_DO_PATH,
} from "./env.ts";
import {
  CloudRuntimeError,
  InvalidRequestError,
  ProviderUnavailableError,
  SessionNotFoundError,
  SessionTerminalError,
  UnauthorizedError,
} from "./errors.ts";
import { resolveCatalogProfile } from "./profiles.ts";
import { cloudflarePlatformCapabilities } from "./platform-capabilities.ts";
import { SessionSnapshotSchema, SessionState, decodeSessionSnapshot } from "./session.ts";

export interface CloudTaskCaller {
  readonly callerId: string;
}

export interface SessionDirectory {
  get(sessionId: string): DurableObjectStub | undefined;
}

type CloudTaskFailureTag =
  | "Unauthenticated"
  | "Unauthorized"
  | "InvalidRequest"
  | "SessionNotFound"
  | "SessionConflict"
  | "SessionTerminal"
  | "ProviderUnavailable";

const CloudTaskFailureSchema = Schema.Union([
  Schema.TaggedStruct("Unauthenticated", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("Unauthorized", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("InvalidRequest", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("SessionNotFound", {
    reason: Schema.NonEmptyString,
    sessionId: SessionIdSchema,
  }),
  Schema.TaggedStruct("SessionConflict", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("SessionTerminal", {
    reason: Schema.NonEmptyString,
    state: TerminalSessionStateSchema,
  }),
  Schema.TaggedStruct("ProviderUnavailable", { reason: Schema.NonEmptyString }),
]);
type CloudTaskFailure = typeof CloudTaskFailureSchema.Type;
const CloudTaskRequestFromJsonSchema = Schema.fromJsonString(CloudTaskRequestSchema);
const CloudTaskSpawnRequestFromJsonSchema = Schema.fromJsonString(CloudTaskSpawnRequestSchema);
const CloudTaskSendRequestFromJsonSchema = Schema.fromJsonString(CloudTaskSendRequestSchema);
const CloudTaskObserveRequestFromJsonSchema = Schema.fromJsonString(CloudTaskObserveRequestSchema);
const CloudTaskCancelRequestFromJsonSchema = Schema.fromJsonString(CloudTaskCancelRequestSchema);
const CloudTaskResultRequestFromJsonSchema = Schema.fromJsonString(CloudTaskResultRequestSchema);
const CloudTaskSpawnResponseFromJsonSchema = Schema.fromJsonString(CloudTaskSpawnResponseSchema);
const CloudTaskSendResponseFromJsonSchema = Schema.fromJsonString(CloudTaskSendResponseSchema);
const CloudTaskObserveResponseFromJsonSchema = Schema.fromJsonString(
  CloudTaskObserveResponseSchema,
);
const CloudTaskCancelResponseFromJsonSchema = Schema.fromJsonString(CloudTaskCancelResponseSchema);
const CloudTaskResultResponseFromJsonSchema = Schema.fromJsonString(CloudTaskResultResponseSchema);
const CloudTaskFailureFromJsonSchema = Schema.fromJsonString(CloudTaskFailureSchema);

type CloudTaskRequestOperationSchema =
  | typeof CloudTaskSpawnRequestSchema
  | typeof CloudTaskSendRequestSchema
  | typeof CloudTaskObserveRequestSchema
  | typeof CloudTaskCancelRequestSchema
  | typeof CloudTaskResultRequestSchema;
type CloudTaskRequestJsonSchema =
  | typeof CloudTaskSpawnRequestFromJsonSchema
  | typeof CloudTaskSendRequestFromJsonSchema
  | typeof CloudTaskObserveRequestFromJsonSchema
  | typeof CloudTaskCancelRequestFromJsonSchema
  | typeof CloudTaskResultRequestFromJsonSchema;
type CloudTaskResponseOperationSchema =
  | typeof CloudTaskSpawnResponseSchema
  | typeof CloudTaskSendResponseSchema
  | typeof CloudTaskObserveResponseSchema
  | typeof CloudTaskCancelResponseSchema
  | typeof CloudTaskResultResponseSchema;
type CloudTaskResponseJsonSchema =
  | typeof CloudTaskSpawnResponseFromJsonSchema
  | typeof CloudTaskSendResponseFromJsonSchema
  | typeof CloudTaskObserveResponseFromJsonSchema
  | typeof CloudTaskCancelResponseFromJsonSchema
  | typeof CloudTaskResultResponseFromJsonSchema;

const requestSchemaFor = (payload: CloudTaskRequest): CloudTaskRequestOperationSchema => {
  switch (payload._tag) {
    case "Spawn":
      return CloudTaskSpawnRequestSchema;
    case "Send":
      return CloudTaskSendRequestSchema;
    case "Observe":
      return CloudTaskObserveRequestSchema;
    case "Cancel":
      return CloudTaskCancelRequestSchema;
    case "Result":
      return CloudTaskResultRequestSchema;
    default:
      throw new InvalidRequestError("Cloud-task operation is unsupported");
  }
};

const requestJsonSchemaFor = (payload: CloudTaskRequest): CloudTaskRequestJsonSchema => {
  switch (payload._tag) {
    case "Spawn":
      return CloudTaskSpawnRequestFromJsonSchema;
    case "Send":
      return CloudTaskSendRequestFromJsonSchema;
    case "Observe":
      return CloudTaskObserveRequestFromJsonSchema;
    case "Cancel":
      return CloudTaskCancelRequestFromJsonSchema;
    case "Result":
      return CloudTaskResultRequestFromJsonSchema;
    default:
      throw new InvalidRequestError("Cloud-task operation is unsupported");
  }
};

const responseSchemaFor = (payload: CloudTaskRequest): CloudTaskResponseOperationSchema => {
  switch (payload._tag) {
    case "Spawn":
      return CloudTaskSpawnResponseSchema;
    case "Send":
      return CloudTaskSendResponseSchema;
    case "Observe":
      return CloudTaskObserveResponseSchema;
    case "Cancel":
      return CloudTaskCancelResponseSchema;
    case "Result":
      return CloudTaskResultResponseSchema;
    default:
      throw new InvalidRequestError("Cloud-task operation is unsupported");
  }
};

const responseJsonSchemaFor = (payload: CloudTaskRequest): CloudTaskResponseJsonSchema => {
  switch (payload._tag) {
    case "Spawn":
      return CloudTaskSpawnResponseFromJsonSchema;
    case "Send":
      return CloudTaskSendResponseFromJsonSchema;
    case "Observe":
      return CloudTaskObserveResponseFromJsonSchema;
    case "Cancel":
      return CloudTaskCancelResponseFromJsonSchema;
    case "Result":
      return CloudTaskResultResponseFromJsonSchema;
    default:
      throw new InvalidRequestError("Cloud-task operation is unsupported");
  }
};

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(text);

const encodeCloudTaskRequest = (payload: CloudTaskRequest): string => {
  const schema = requestSchemaFor(payload);
  const value = decode(schema, payload);
  return Schema.encodeSync(requestJsonSchemaFor(value), {
    onExcessProperty: "error",
  })(value);
};

const responseJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  init?: ResponseInit,
): Response => Response.json(decode(schema, value), init);

const statusForCloudTaskFailure = (tag: CloudTaskFailureTag): number => {
  if (tag === "Unauthenticated") return 401;
  if (tag === "Unauthorized") return 403;
  if (tag === "SessionNotFound") return 404;
  if (tag === "ProviderUnavailable") return 503;
  if (tag === "InvalidRequest") return 400;
  return 409;
};

const failureTag = (cause: unknown): CloudTaskFailureTag => {
  if (!(cause instanceof CloudRuntimeError)) return "InvalidRequest";
  switch (cause._tag) {
    case "Unauthenticated":
    case "Unauthorized":
    case "InvalidRequest":
    case "SessionNotFound":
    case "SessionConflict":
    case "SessionTerminal":
    case "ProviderUnavailable":
      return cause._tag;
    default:
      return "ProviderUnavailable";
  }
};

const errorResponse = (cause: unknown): Response => {
  const reason = "Cloud-task request failed";
  const tagged = failureTag(cause);
  const envelope: CloudTaskFailure =
    cause instanceof SessionNotFoundError
      ? decode(CloudTaskFailureSchema, {
          _tag: "SessionNotFound",
          reason,
          sessionId: cause.details["sessionId"],
        })
      : cause instanceof SessionTerminalError
        ? decode(CloudTaskFailureSchema, {
            _tag: "SessionTerminal",
            reason,
            state: cause.details["state"],
          })
        : decode(CloudTaskFailureSchema, {
            _tag:
              tagged === "SessionNotFound" || tagged === "SessionTerminal"
                ? "ProviderUnavailable"
                : tagged,
            reason,
          });
  return responseJson(CloudTaskFailureSchema, envelope, {
    status: statusForCloudTaskFailure(envelope._tag),
  });
};

const authToken = (request: Request): string | undefined => {
  const value = request.headers.get(CLOUD_TASK_AUTHORIZATION);
  return value?.startsWith(CLOUD_TASK_BEARER_PREFIX)
    ? value.slice(CLOUD_TASK_BEARER_PREFIX.length)
    : undefined;
};

const payloadBody = async (request: Request): Promise<CloudTaskRequest> => {
  let text: string;
  try {
    text = await request.text();
  } catch (cause) {
    throw new InvalidRequestError("Cloud-task request body must be JSON", cause);
  }
  try {
    const operation = decodeJson(CloudTaskRequestFromJsonSchema, text);
    return decodeJson(requestJsonSchemaFor(operation), text);
  } catch (cause) {
    throw new InvalidRequestError("Cloud-task request body must be valid JSON", cause);
  }
};

export class SessionDurableObject implements DurableObject {
  #state: DurableObjectState;
  #env: CloudflareRuntimeEnv;
  #capabilities: PlatformCapabilities;

  constructor(
    state: DurableObjectState,
    env: CloudflareRuntimeEnv,
    capabilities: PlatformCapabilities = cloudflarePlatformCapabilities,
  ) {
    this.#state = state;
    this.#env = env;
    this.#capabilities = capabilities;
  }

  async #authorized(request: Request): Promise<void> {
    const presented = request.headers.get("X-Cloud-Task-Internal");
    const expected = this.#env.CLOUD_TASK_ROUTER_SECRET;
    if (expected === undefined || presented === undefined || presented !== expected) {
      throw new UnauthorizedError("Session DO calls require the authenticated router binding");
    }
  }
  async #load(task?: CloudTask): Promise<SessionState> {
    const stored: unknown = await this.#state.storage.get("session");
    if (stored !== undefined) {
      const existing = decodeSessionSnapshot(stored);
      return new SessionState(existing.task, this.#capabilities, existing);
    }
    if (task === undefined) throw new SessionNotFoundError(this.#state.id.toString());
    return new SessionState(task, this.#capabilities);
  }

  async #save(session: SessionState): Promise<void> {
    const snapshot = decode(SessionSnapshotSchema, session.snapshot);
    await this.#state.storage.put("session", encode(SessionSnapshotSchema, snapshot));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.#authorized(request);
      const payload = await payloadBody(request);
      const task = payload._tag === "Spawn" ? payload.task : undefined;
      if (task !== undefined) {
        if (task.deadline <= this.#capabilities.now()) {
          throw new InvalidRequestError("CloudTask deadline has expired");
        }
        await resolveCatalogProfile(this.#env.PROFILE_CATALOG, task, this.#capabilities);
      }
      const session = await this.#load(task);
      if (payload._tag === "Spawn") {
        const admission = session.spawn(payload.task);
        await this.#save(session);
        return responseJson(CloudTaskSpawnResponseSchema, { _tag: "Spawned", admission });
      }
      if (payload.sessionId !== session.sessionId) {
        throw new UnauthorizedError("Session address mismatch");
      }
      if (payload._tag === "Send") {
        const acceptedCursor = session.send(payload.messageId, payload.message);
        await this.#save(session);
        return responseJson(CloudTaskSendResponseSchema, {
          _tag: "Accepted",
          acceptedCursor,
        });
      }
      if (payload._tag === "Observe") {
        const observations = session.observe(payload.afterCursor);
        return responseJson(CloudTaskObserveResponseSchema, {
          _tag: "Observed",
          observations,
        });
      }
      if (payload._tag === "Cancel") {
        const observation = session.requestCancellation(payload.reason);
        await this.#save(session);
        return responseJson(CloudTaskCancelResponseSchema, {
          _tag: "Cancelled",
          observation,
        });
      }
      const result = session.terminalResult ?? { _tag: "Pending", sessionId: payload.sessionId };
      return responseJson(CloudTaskResultResponseSchema, { _tag: "Result", result });
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

export interface CloudTaskRouterOptions {
  readonly expectedToken?: string;
  readonly expectedCaller?: string;
}

/** Authenticated adapter. A valid sessionId is never accepted as authorization. */
export class CloudTaskRouter {
  #env: CloudflareRuntimeEnv;
  #expectedToken: string | undefined;
  #expectedCaller: string | undefined;

  constructor(env: CloudflareRuntimeEnv, options: CloudTaskRouterOptions = {}) {
    this.#env = env;
    this.#expectedToken = options.expectedToken ?? env.CLOUD_TASK_AUTH_TOKEN;
    this.#expectedCaller = options.expectedCaller;
  }

  #authenticate(request: Request): CloudTaskCaller {
    if (this.#expectedToken === undefined)
      throw new ProviderUnavailableError("Cloud-task authentication secret");
    const presented = authToken(request);
    if (presented === undefined || presented !== this.#expectedToken)
      throw new UnauthorizedError("Cloud-task caller authentication failed");
    const callerId = request.headers.get("X-Cloud-Task-Caller") ?? "operator";
    if (this.#expectedCaller !== undefined && callerId !== this.#expectedCaller)
      throw new UnauthorizedError();
    return { callerId };
  }

  #namespace(): DurableObjectNamespace {
    return this.#env.SESSION;
  }

  async #forward(request: Request, body: CloudTaskRequest, sessionId: string): Promise<Response> {
    const internalSecret = this.#env.CLOUD_TASK_ROUTER_SECRET;
    if (internalSecret === undefined)
      throw new ProviderUnavailableError("Cloud-task router secret");
    const stub = this.#namespace().getByName(sessionId);
    const headers = new Headers(request.headers);
    headers.delete(CLOUD_TASK_AUTHORIZATION);
    headers.set("X-Cloud-Task-Internal", internalSecret);
    headers.set("content-type", "application/json");
    return stub.fetch(`https://session${SESSION_DO_PATH}`, {
      method: "POST",
      headers,
      body: encodeCloudTaskRequest(body),
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      this.#authenticate(request);
      const payload = await payloadBody(request);
      const response = await this.#forward(request, payload, payload.sessionId);
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        throw new ProviderUnavailableError(
          "Cloud-task session service",
          "invalid response body",
          cause,
        );
      }
      if (!response.ok) {
        let failure: CloudTaskFailure;
        try {
          failure = decodeJson(CloudTaskFailureFromJsonSchema, text);
        } catch (cause) {
          throw new ProviderUnavailableError(
            "Cloud-task session service",
            "invalid failure response",
            cause,
          );
        }
        return responseJson(CloudTaskFailureSchema, failure, { status: response.status });
      }
      try {
        const responseSchema = responseSchemaFor(payload);
        const decoded = decodeJson(responseJsonSchemaFor(payload), text);
        return responseJson(responseSchema, decoded);
      } catch (cause) {
        throw new ProviderUnavailableError(
          "Cloud-task session service",
          "invalid success response",
          cause,
        );
      }
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

/** Production cloud-task client; unavailable bindings are typed failures, never local execution. */
export class CloudflareCloudTaskClient {
  #binding: Fetcher | undefined;
  #token: string | undefined;

  constructor(binding: Fetcher | undefined, token: string | undefined) {
    this.#binding = binding;
    this.#token = token;
  }

  async #request(payload: CloudTaskRequest): Promise<CloudTaskResponse> {
    if (this.#binding === undefined)
      throw new ProviderUnavailableError("Cloud-task service binding");
    if (this.#token === undefined)
      throw new ProviderUnavailableError("Cloud-task authentication secret");
    const response = await this.#binding.fetch("https://cloud-task/v1/cloud-tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLOUD_TASK_AUTHORIZATION]: `${CLOUD_TASK_BEARER_PREFIX}${this.#token}`,
      },
      body: encodeCloudTaskRequest(payload),
    });
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new ProviderUnavailableError(
        "Cloud-task service binding",
        "invalid response body",
        cause,
      );
    }
    if (!response.ok) {
      let failure: CloudTaskFailure;
      try {
        failure = decodeJson(CloudTaskFailureFromJsonSchema, text);
      } catch (cause) {
        throw new ProviderUnavailableError(
          "Cloud-task service binding",
          "invalid failure response",
          cause,
        );
      }
      switch (failure._tag) {
        case "ProviderUnavailable":
          throw new ProviderUnavailableError("Cloud-task service binding", failure.reason);
        case "InvalidRequest":
          throw new InvalidRequestError(failure.reason);
        case "SessionNotFound":
          throw new SessionNotFoundError(failure.sessionId);
        case "SessionTerminal":
          throw new SessionTerminalError(failure.state, failure.reason);
        default:
          throw new CloudRuntimeError(failure._tag, failure.reason);
      }
    }
    try {
      return decodeJson(responseJsonSchemaFor(payload), text);
    } catch (cause) {
      throw new ProviderUnavailableError(
        "Cloud-task service binding",
        "invalid success response",
        cause,
      );
    }
  }

  spawn(sessionId: SessionId, task: CloudTask): Promise<CloudTaskResponse> {
    const value = decode(CloudTaskSchema, task);
    if (value.sessionId !== sessionId)
      throw new InvalidRequestError("sessionId does not match CloudTask");
    return this.#request(decode(CloudTaskRequestSchema, { _tag: "Spawn", sessionId, task: value }));
  }

  send(sessionId: SessionId, messageId: string, message: Json): Promise<CloudTaskResponse> {
    return this.#request(
      decode(CloudTaskRequestSchema, { _tag: "Send", sessionId, messageId, message }),
    );
  }

  observe(sessionId: SessionId, afterCursor: number): Promise<CloudTaskResponse> {
    return this.#request(
      decode(CloudTaskRequestSchema, { _tag: "Observe", sessionId, afterCursor }),
    );
  }

  cancel(sessionId: SessionId, reason: string): Promise<CloudTaskResponse> {
    return this.#request(decode(CloudTaskRequestSchema, { _tag: "Cancel", sessionId, reason }));
  }

  result(sessionId: SessionId): Promise<CloudTaskResponse> {
    return this.#request(decode(CloudTaskRequestSchema, { _tag: "Result", sessionId }));
  }
}

/** Focused-test directory with the same idempotent SessionState semantics, not a provider fallback. */
export class InMemoryCloudTaskDirectory {
  #sessions = new Map<string, SessionState>();
  #clock: Pick<PlatformCapabilities, "now">;
  #token: string;

  constructor(clock: Pick<PlatformCapabilities, "now">, token = "test-token") {
    this.#clock = clock;
    this.#token = token;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const presented = authToken(request);
      if (presented !== this.#token) throw new UnauthorizedError();
      const payload = await payloadBody(request);
      const sessionId = payload.sessionId;
      if (payload._tag === "Spawn") {
        const existing = this.#sessions.get(sessionId);
        const session = existing ?? new SessionState(payload.task, this.#clock);
        const admission = session.spawn(payload.task);
        this.#sessions.set(sessionId, session);
        return responseJson(CloudTaskSpawnResponseSchema, { _tag: "Spawned", admission });
      }
      const session = this.#sessions.get(sessionId);
      if (session === undefined) throw new SessionNotFoundError(sessionId);
      if (payload._tag === "Send") {
        return responseJson(CloudTaskSendResponseSchema, {
          _tag: "Accepted",
          acceptedCursor: session.send(payload.messageId, payload.message),
        });
      }
      if (payload._tag === "Observe") {
        return responseJson(CloudTaskObserveResponseSchema, {
          _tag: "Observed",
          observations: session.observe(payload.afterCursor),
        });
      }
      if (payload._tag === "Cancel") {
        return responseJson(CloudTaskCancelResponseSchema, {
          _tag: "Cancelled",
          observation: session.requestCancellation(payload.reason),
        });
      }
      return responseJson(CloudTaskResultResponseSchema, {
        _tag: "Result",
        result: session.terminalResult ?? { _tag: "Pending", sessionId },
      });
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

export const cloudTaskRouter = (env: CloudflareRuntimeEnv): CloudTaskRouter =>
  new CloudTaskRouter(env);

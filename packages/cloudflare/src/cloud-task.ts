import type { DurableObjectState } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";
import type { CloudTaskRequest, CloudTaskResponse } from "@work-engine/protocol";
import {
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  decode,
  encode,
  json,
  type CloudTask,
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
  UnauthorizedError,
} from "./errors.ts";
import { resolveCatalogProfile } from "./profiles.ts";
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

const CloudTaskFailureSchema = Schema.Struct({
  _tag: Schema.Literals([
    "Unauthenticated",
    "Unauthorized",
    "InvalidRequest",
    "SessionNotFound",
    "SessionConflict",
    "SessionTerminal",
    "ProviderUnavailable",
  ] as const),
  reason: Schema.NonEmptyString,
});
type CloudTaskFailure = typeof CloudTaskFailureSchema.Type;

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
  const tag = failureTag(cause);
  const envelope: CloudTaskFailure = decode(CloudTaskFailureSchema, {
    _tag: tag,
    reason: "Cloud-task request failed",
  });
  return Response.json(envelope, { status: statusForCloudTaskFailure(tag) });
};

const authToken = (request: Request): string | undefined => {
  const value = request.headers.get(CLOUD_TASK_AUTHORIZATION);
  return value?.startsWith(CLOUD_TASK_BEARER_PREFIX)
    ? value.slice(CLOUD_TASK_BEARER_PREFIX.length)
    : undefined;
};

const payloadBody = async (request: Request): Promise<CloudTaskRequest> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidRequestError("Cloud-task request body must be JSON");
  }
  return decode(CloudTaskRequestSchema, value);
};

/** One Session DO owns private lifecycle, cursor, messages, cancellation, and terminal result. */
export class SessionDurableObject implements DurableObject {
  #state: DurableObjectState;
  #env: CloudflareRuntimeEnv;

  constructor(state: DurableObjectState, env: CloudflareRuntimeEnv) {
    this.#state = state;
    this.#env = env;
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
      return new SessionState(existing.task, existing);
    }
    if (task === undefined) throw new SessionNotFoundError(this.#state.id.toString());
    return new SessionState(task);
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
        if (Date.parse(task.deadline) <= Date.now()) {
          throw new InvalidRequestError("CloudTask deadline has expired");
        }
        await resolveCatalogProfile(this.#env.PROFILE_CATALOG, task);
      }
      const session = await this.#load(task);
      if (payload._tag === "Spawn") {
        const admission = session.spawn(payload.task);
        await this.#save(session);
        return Response.json(decode(CloudTaskResponseSchema, { _tag: "Spawned", admission }));
      }
      if (payload.sessionId !== session.sessionId) {
        throw new UnauthorizedError("Session address mismatch");
      }
      if (payload._tag === "Send") {
        const acceptedCursor = session.send(payload.messageId, payload.message);
        await this.#save(session);
        return Response.json(decode(CloudTaskResponseSchema, { _tag: "Accepted", acceptedCursor }));
      }
      if (payload._tag === "Observe") {
        const observations = session.observe(payload.afterCursor);
        return Response.json(decode(CloudTaskResponseSchema, { _tag: "Observed", observations }));
      }
      if (payload._tag === "Cancel") {
        const observation = session.requestCancellation(payload.reason);
        await this.#save(session);
        return Response.json(decode(CloudTaskResponseSchema, { _tag: "Cancelled", observation }));
      }
      const result = session.terminalResult ?? { _tag: "Pending", sessionId: payload.sessionId };
      return Response.json(decode(CloudTaskResponseSchema, { _tag: "Result", result }));
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
      body: json(body),
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      this.#authenticate(request);
      const payload = await payloadBody(request);
      const response = await this.#forward(request, payload, payload.sessionId);
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = decode(CloudTaskFailureSchema, body);
        return Response.json(failure, { status: response.status });
      }
      return Response.json(decode(CloudTaskResponseSchema, body));
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
      body: json(payload),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      let failure: CloudTaskFailure;
      try {
        failure = decode(CloudTaskFailureSchema, body);
      } catch {
        throw new ProviderUnavailableError("Cloud-task service binding", "invalid failure response");
      }
      if (failure._tag === "ProviderUnavailable") {
        throw new ProviderUnavailableError("Cloud-task service binding", failure.reason);
      }
      if (failure._tag === "InvalidRequest") throw new InvalidRequestError(failure.reason);
      if (failure._tag === "SessionNotFound") throw new SessionNotFoundError("requested");
      throw new CloudRuntimeError(failure._tag, failure.reason);
    }
    return decode(CloudTaskResponseSchema, body);
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
  #token: string;

  constructor(token = "test-token") {
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
        const session = existing ?? new SessionState(payload.task);
        const admission = session.spawn(payload.task);
        this.#sessions.set(sessionId, session);
        return Response.json(decode(CloudTaskResponseSchema, { _tag: "Spawned", admission }));
      }
      const session = this.#sessions.get(sessionId);
      if (session === undefined) throw new SessionNotFoundError(sessionId);
      if (payload._tag === "Send") {
        return Response.json(
          decode(CloudTaskResponseSchema, {
            _tag: "Accepted",
            acceptedCursor: session.send(payload.messageId, payload.message),
          }),
        );
      }
      if (payload._tag === "Observe") {
        return Response.json(
          decode(CloudTaskResponseSchema, {
            _tag: "Observed",
            observations: session.observe(payload.afterCursor),
          }),
        );
      }
      if (payload._tag === "Cancel") {
        return Response.json(
          decode(CloudTaskResponseSchema, {
            _tag: "Cancelled",
            observation: session.requestCancellation(payload.reason),
          }),
        );
      }
      return Response.json(
        decode(CloudTaskResponseSchema, {
          _tag: "Result",
          result: session.terminalResult ?? { _tag: "Pending", sessionId },
        }),
      );
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

export const cloudTaskRouter = (env: CloudflareRuntimeEnv): CloudTaskRouter =>
  new CloudTaskRouter(env);

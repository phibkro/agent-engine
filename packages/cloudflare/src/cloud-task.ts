import type { DurableObjectState } from "@cloudflare/workers-types";
import type { Json } from "effect/Schema";
import type {
  CloudTaskRequest,
  CloudTaskResponse,
} from "@work-engine/protocol";
import {
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  decode,
  encode,
  json,
  record,
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

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof CloudRuntimeError) {
    const status =
      cause._tag === "Unauthenticated"
        ? 401
        : cause._tag === "Unauthorized"
          ? 403
          : cause._tag === "SessionNotFound"
            ? 404
            : cause._tag === "ProviderUnavailable"
              ? 503
              : cause._tag === "InvalidRequest"
                ? 400
                : 409;
    return Response.json(
      { _tag: cause._tag, reason: cause.message, details: cause.details },
      { status },
    );
  }
  const reason = cause instanceof Error ? cause.message : "Unknown cloud-task error";
  return Response.json({ _tag: "InvalidRequest", reason }, { status: 400 });
};

const authToken = (request: Request): string | undefined => {
  const value = request.headers.get(CLOUD_TASK_AUTHORIZATION);
  return value?.startsWith(CLOUD_TASK_BEARER_PREFIX)
    ? value.slice(CLOUD_TASK_BEARER_PREFIX.length)
    : undefined;
};

const wireTag = (payload: CloudTaskRequest): CloudTaskRequest["_tag"] => payload._tag;

const payloadBody = async (request: Request): Promise<CloudTaskRequest> => {
  const value: unknown = await request.json();
  return decode(CloudTaskRequestSchema, value);
};

const taskFromPayload = (
  payload: Extract<CloudTaskRequest, { readonly _tag: "Spawn" }>,
): CloudTask => payload.task;

const sessionIdFromPayload = (payload: CloudTaskRequest, task?: CloudTask): SessionId => {
  if (task !== undefined && payload.sessionId !== task.sessionId) {
    throw new InvalidRequestError("payload.sessionId must equal task.sessionId");
  }
  return payload.sessionId;
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
    const snapshot = session.snapshot;
    await this.#state.storage.put("session", encode(SessionSnapshotSchema, snapshot));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.#authorized(request);
      const payload = await payloadBody(request);
      const tag = wireTag(payload);
      const task = payload._tag === "Spawn" ? taskFromPayload(payload) : undefined;
      if (task !== undefined) {
        if (Date.parse(task.deadline) <= Date.now()) {
          throw new InvalidRequestError("CloudTask deadline has expired");
        }
        await resolveCatalogProfile(this.#env.PROFILE_CATALOG, task);
      }
      const session = await this.#load(task);
      if (payload._tag === "Spawn") {
        if (task === undefined) throw new InvalidRequestError("Spawn task is required");
        const admission = session.spawn(task);
        await this.#save(session);
        return Response.json({ _tag: "Spawned", admission });
      }
      const sessionId = sessionIdFromPayload(payload);
      if (sessionId !== session.sessionId) throw new UnauthorizedError("Session address mismatch");
      if (payload._tag === "Send") {
        const acceptedCursor = session.send(payload.messageId, payload.message);
        await this.#save(session);
        return Response.json({ _tag: "Accepted", acceptedCursor });
      }
      if (payload._tag === "Observe") {
        const observations = session.observe(payload.afterCursor);
        return Response.json({ _tag: "Observed", observations });
      }
      if (payload._tag === "Cancel") {
        const observation = session.requestCancellation(payload.reason);
        await this.#save(session);
        return Response.json({ _tag: "Cancelled", observation });
      }
      if (payload._tag === "Result") {
        return Response.json({
          _tag: "Result",
          result: session.terminalResult ?? { _tag: "Pending", sessionId },
        });
      }
      throw new InvalidRequestError(`Unsupported cloud-task operation ${tag}`);
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

  async #forward(
    request: Request,
    body: CloudTaskRequest,
    sessionId: string,
  ): Promise<Response> {
    const stub = this.#namespace().getByName(sessionId);
    const headers = new Headers(request.headers);
    headers.delete(CLOUD_TASK_AUTHORIZATION);
    headers.set("X-Cloud-Task-Internal", this.#env.CLOUD_TASK_ROUTER_SECRET ?? "");
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
      const tag = wireTag(payload);
      const task = payload._tag === "Spawn" ? taskFromPayload(payload) : undefined;
      const sessionId = sessionIdFromPayload(payload, task);
      const response = await this.#forward(request, payload, sessionId);
      const body: unknown = await response.json();
      if (!response.ok) return Response.json(body, { status: response.status });
      const decoded = decode(CloudTaskResponseSchema, body);
      return Response.json(decoded);
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
      const error = record(body);
      const tag = error["_tag"];
      const reason = String(error["reason"] ?? response.status);
      const details =
        typeof error["details"] === "object" && error["details"] !== null
          ? record(error["details"])
          : {};
      if (
        tag === "Unauthenticated" ||
        tag === "Unauthorized" ||
        tag === "InvalidRequest" ||
        tag === "SessionNotFound" ||
        tag === "SessionConflict" ||
        tag === "SessionTerminal" ||
        tag === "ProviderUnavailable"
      ) {
        throw new CloudRuntimeError(tag, reason, details);
      }
      throw new ProviderUnavailableError("Cloud-task service binding", reason);
    }
    return decode(CloudTaskResponseSchema, body);
  }

  spawn(sessionId: SessionId, task: CloudTask): Promise<CloudTaskResponse> {
    const value = decode(CloudTaskSchema, task);
    if (value.sessionId !== sessionId)
      throw new InvalidRequestError("sessionId does not match CloudTask");
    return this.#request(
      decode(CloudTaskRequestSchema, { _tag: "Spawn", sessionId, task: value }),
    );
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
    return this.#request(
      decode(CloudTaskRequestSchema, { _tag: "Cancel", sessionId, reason }),
    );
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
      const tag = wireTag(payload);
      const task = payload._tag === "Spawn" ? taskFromPayload(payload) : undefined;
      const sessionId = sessionIdFromPayload(payload, task);
      if (payload._tag === "Spawn") {
        if (task === undefined) throw new InvalidRequestError("Spawn task is required");
        const existing = this.#sessions.get(sessionId);
        const session = existing ?? new SessionState(task);
        const admission = session.spawn(task);
        this.#sessions.set(sessionId, session);
        return Response.json({ _tag: "Spawned", admission });
      }
      const session = this.#sessions.get(sessionId);
      if (session === undefined) throw new SessionNotFoundError(sessionId);
      if (payload._tag === "Send") {
        return Response.json({
          _tag: "Accepted",
          acceptedCursor: session.send(payload.messageId, payload.message),
        });
      }
      if (payload._tag === "Observe") {
        return Response.json({
          _tag: "Observed",
          observations: session.observe(payload.afterCursor),
        });
      }
      if (payload._tag === "Cancel") {
        return Response.json({
          _tag: "Cancelled",
          observation: session.requestCancellation(payload.reason),
        });
      }
      if (payload._tag === "Result") {
        return Response.json({
          _tag: "Result",
          result: session.terminalResult ?? { _tag: "Pending", sessionId },
        });
      }
      throw new InvalidRequestError(`Unsupported cloud-task operation ${tag}`);
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

export const cloudTaskRouter = (env: CloudflareRuntimeEnv): CloudTaskRouter =>
  new CloudTaskRouter(env);

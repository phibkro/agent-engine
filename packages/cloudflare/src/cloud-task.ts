import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  type CloudTask,
  type SessionId,
} from "./contract.ts";
import { decode, json, record, requiredString } from "./contract.ts";
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
import { SessionState, type SessionSnapshot } from "./session.ts";

export interface CloudTaskCaller {
  readonly callerId: string;
}

export interface SessionDirectory {
  get(sessionId: string): DurableObjectStub | undefined;
}

const errorResponse = (cause: unknown): Response => {
  if (cause instanceof CloudRuntimeError) {
    const status = cause._tag === "Unauthenticated"
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
    return Response.json({ _tag: cause._tag, reason: cause.message, details: cause.details }, { status });
  }
  const reason = cause instanceof Error ? cause.message : "Unknown cloud-task error";
  return Response.json({ _tag: "InvalidRequest", reason }, { status: 400 });
};

const authToken = (request: Request): string | undefined => {
  const value = request.headers.get(CLOUD_TASK_AUTHORIZATION);
  return value?.startsWith(CLOUD_TASK_BEARER_PREFIX) ? value.slice(CLOUD_TASK_BEARER_PREFIX.length) : undefined;
};

const wireTag = (payload: Record<string, unknown>): string => {
  const tag = payload["_tag"] ?? payload["operation"];
  if (typeof tag !== "string") throw new InvalidRequestError("Cloud-task request tag is required");
  return tag;
};

const payloadBody = async (request: Request): Promise<Record<string, unknown>> => {
  const value: unknown = await request.json();
  const decoded = decode(CloudTaskRequestSchema, value);
  return record(decoded);
};

const taskFromPayload = (payload: Record<string, unknown>): CloudTask => {
  const task = payload["task"] ?? payload;
  return decode(CloudTaskSchema, task);
};

const sessionIdFromPayload = (payload: Record<string, unknown>, task?: CloudTask): string => {
  const candidate = payload["sessionId"] ?? (task === undefined ? undefined : record(task)["sessionId"]);
  return requiredString(candidate, "sessionId");
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
    const existing = await this.#state.storage.get<SessionSnapshot>("session");
    if (existing !== undefined) return new SessionState(existing.task as CloudTask, existing);
    if (task === undefined) throw new SessionNotFoundError(this.#state.id.toString());
    return new SessionState(task);
  }

  async #save(session: SessionState): Promise<void> {
    await this.#state.storage.put("session", session.snapshot);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.#authorized(request);
      const payload = await payloadBody(request);
      const tag = wireTag(payload);
      const task = tag === "Spawn" ? taskFromPayload(payload) : undefined;
      const session = await this.#load(task);
      if (tag === "Spawn") {
        const admission = session.spawn(task as CloudTask);
        await this.#save(session);
        return Response.json({ _tag: "Spawned", admission });
      }
      const sessionId = sessionIdFromPayload(payload);
      if (sessionId !== this.#state.id.toString()) throw new UnauthorizedError("Session address mismatch");
      if (tag === "Send") {
        const messageId = requiredString(payload["messageId"], "messageId");
        const message = payload["message"];
        if (message === undefined) throw new InvalidRequestError("message is required");
        const acceptedCursor = session.send(messageId, String(message));
        await this.#save(session);
        return Response.json({ _tag: "Accepted", acceptedCursor });
      }
      if (tag === "Observe") {
        const afterCursor = payload["afterCursor"] === undefined ? 0 : payload["afterCursor"];
        const observations = session.observe(Number(afterCursor));
        return Response.json({ _tag: "Observed", observations });
      }
      if (tag === "Cancel") {
        const reason = requiredString(payload["reason"], "reason");
        const observation = session.requestCancellation(reason);
        await this.#save(session);
        return Response.json({ _tag: "Cancelled", observation });
      }
      if (tag === "Result") {
        return Response.json({ _tag: "Result", result: session.terminalResult ?? { _tag: "Pending", sessionId } });
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
    if (this.#expectedToken === undefined) throw new ProviderUnavailableError("Cloud-task authentication secret");
    const presented = authToken(request);
    if (presented === undefined || presented !== this.#expectedToken) throw new UnauthorizedError("Cloud-task caller authentication failed");
    const callerId = request.headers.get("X-Cloud-Task-Caller") ?? "operator";
    if (this.#expectedCaller !== undefined && callerId !== this.#expectedCaller) throw new UnauthorizedError();
    return { callerId };
  }

  #namespace(): DurableObjectNamespace {
    return this.#env.SESSION;
  }

  async #forward(request: Request, body: Record<string, unknown>, sessionId: string): Promise<Response> {
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
      const task = tag === "Spawn" ? taskFromPayload(payload) : undefined;
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

  async #request(payload: Record<string, unknown>): Promise<unknown> {
    if (this.#binding === undefined) throw new ProviderUnavailableError("Cloud-task service binding");
    if (this.#token === undefined) throw new ProviderUnavailableError("Cloud-task authentication secret");
    const response = await this.#binding.fetch("https://cloud-task/v1/cloud-tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLOUD_TASK_AUTHORIZATION]: `${CLOUD_TASK_BEARER_PREFIX}${this.#token}`,
      },
      body: json(payload),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new UnauthorizedError(String(record(body)["reason"] ?? response.status));
    return decode(CloudTaskResponseSchema, body);
  }

  spawn(sessionId: SessionId, task: CloudTask): Promise<unknown> {
    const value = decode(CloudTaskSchema, task);
    if (record(value)["sessionId"] !== sessionId) throw new InvalidRequestError("sessionId does not match CloudTask");
    return this.#request({ _tag: "Spawn", sessionId, task: value });
  }

  send(sessionId: SessionId, messageId: string, message: unknown): Promise<unknown> {
    return this.#request({ _tag: "Send", sessionId, messageId, message });
  }

  observe(sessionId: SessionId, afterCursor: number): Promise<unknown> {
    return this.#request({ _tag: "Observe", sessionId, afterCursor });
  }

  cancel(sessionId: SessionId, reason: string): Promise<unknown> {
    return this.#request({ _tag: "Cancel", sessionId, reason });
  }

  result(sessionId: SessionId): Promise<unknown> {
    return this.#request({ _tag: "Result", sessionId });
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
      const task = tag === "Spawn" ? taskFromPayload(payload) : undefined;
      const sessionId = sessionIdFromPayload(payload, task);
      if (tag === "Spawn") {
        const existing = this.#sessions.get(sessionId);
        const session = existing ?? new SessionState(task as CloudTask);
        const admission = session.spawn(task as CloudTask);
        this.#sessions.set(sessionId, session);
        return Response.json({ _tag: "Spawned", admission });
      }
      const session = this.#sessions.get(sessionId);
      if (session === undefined) throw new SessionNotFoundError(sessionId);
      if (tag === "Send") {
        const message = payload["message"];
        if (message === undefined) throw new InvalidRequestError("message is required");
        return Response.json({ _tag: "Accepted", acceptedCursor: session.send(requiredString(payload["messageId"], "messageId"), String(message)) });
      }
      if (tag === "Observe") return Response.json({ _tag: "Observed", observations: session.observe(Number(payload["afterCursor"] ?? 0)) });
      if (tag === "Cancel") return Response.json({ _tag: "Cancelled", observation: session.requestCancellation(requiredString(payload["reason"], "reason")) });
      if (tag === "Result") return Response.json({ _tag: "Result", result: session.terminalResult ?? { _tag: "Pending", sessionId } });
      throw new InvalidRequestError(`Unsupported cloud-task operation ${tag}`);
    } catch (cause) {
      return errorResponse(cause);
    }
  }
}

export const cloudTaskRouter = (env: CloudflareRuntimeEnv): CloudTaskRouter => new CloudTaskRouter(env);

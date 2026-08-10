import { Effect, Schema } from "effect";
import {
  AcceptedCursorSchema,
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  SessionAdmissionSchema,
  SessionIdSchema,
  SessionObservationSchema,
  SessionResultSchema,
  type CloudTask,
  type SessionAdmission,
  type SessionId,
  type SessionObservation,
  type SessionResult,
} from "@work-engine/protocol";
import type { CloudTaskClient, CloudTaskError } from "@work-engine/runtime";
import type { OperatorConfig } from "./config.ts";

/** Cloudflare Access headers are part of the local adapter boundary. */
export const AccessHeader = {
  clientId: "CF-Access-Client-Id",
  clientSecret: "CF-Access-Client-Secret",
} as const;

export type CloudTaskClientError = CloudTaskError;

export interface CloudTaskHttpOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export const CloudTaskRoute = {
  spawn: (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/spawn`,
  send: (sessionId: string, messageId: string): string =>
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
  observe: (sessionId: string, afterCursor: number): string =>
    `/v1/sessions/${encodeURIComponent(sessionId)}/observations?after=${encodeURIComponent(String(afterCursor))}`,
  cancel: (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
  result: (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/result`,
} as const;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

const encodeStrict = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  input: S["Type"],
): string => JSON.stringify(Schema.encodeSync(schema, { onExcessProperty: "error" })(input));

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const rejected = (reason: string): CloudTaskError => ({
  _tag: "CloudTaskRejected",
  reason,
});

const responseValue = <S extends Schema.ConstraintDecoder<unknown>>(
  response: unknown,
  field: string,
  schema: S,
): S["Type"] => {
  if (typeof response !== "object" || response === null || !(field in response)) {
    throw new Error(`cloud-task response does not contain ${field}`);
  }
  const value = Reflect.get(response, field);
  return decodeStrict(schema, value);
};

const responseError = (status: number, sessionId: SessionId): CloudTaskError => {
  if (status === 401) {
    return { _tag: "CloudTaskUnauthorized", reason: "Cloudflare Access rejected the service credentials" };
  }
  if (status === 404) {
    return { _tag: "CloudTaskNotFound", sessionId };
  }
  if (status >= 500) {
    return { _tag: "CloudTaskUnavailable", reason: `cloud-task endpoint returned HTTP ${status}` };
  }
  return rejected(`cloud-task endpoint returned HTTP ${status}`);
};

const endpoint = (config: OperatorConfig, path: string): string =>
  new URL(path, `${config.baseUrl.replace(/\/$/, "")}/`).toString();

const headersFor = (config: OperatorConfig, body: boolean): Headers => {
  const headers = new Headers({
    Accept: "application/json",
    [AccessHeader.clientId]: config.accessClientId,
    [AccessHeader.clientSecret]: config.accessClientSecret,
  });
  if (body) headers.set("Content-Type", "application/json");
  return headers;
};

const request = <S extends Schema.ConstraintDecoder<unknown>>(
  config: OperatorConfig,
  fetcher: typeof globalThis.fetch,
  operation: string,
  sessionId: SessionId,
  method: "GET" | "POST",
  path: string,
  responseSchema: S,
  body?: string,
): Effect.Effect<S["Type"], CloudTaskError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(endpoint(config, path), {
          method,
          headers: headersFor(config, body !== undefined),
          ...(body === undefined ? {} : { body }),
          signal,
        }),
      catch: (error) => ({
        _tag: "CloudTaskUnavailable" as const,
        reason: `${operation}: ${reasonOf(error)}`,
      }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => ({
        _tag: "CloudTaskUnavailable" as const,
        reason: `${operation}: ${reasonOf(error)}`,
      }),
    });
    if (!response.ok) return yield* Effect.fail(responseError(response.status, sessionId));
    return yield* Effect.try({
      try: () => decodeStrict(responseSchema, parseJson(text)),
      catch: (error) => rejected(`${operation}: strict response decode failed: ${reasonOf(error)}`),
    });
  });

const makeRequestBody = (
  requestInput: unknown,
): Effect.Effect<string, CloudTaskError> =>
  Effect.try({
    try: () => {
      const decoded = decodeStrict(CloudTaskRequestSchema, requestInput);
      return encodeStrict(CloudTaskRequestSchema, decoded);
    },
    catch: (error) => rejected(`strict request encode failed: ${reasonOf(error)}`),
  });

const makeClient = (
  config: OperatorConfig,
  fetcher: typeof globalThis.fetch,
): CloudTaskClient => ({
  spawn: (sessionId: SessionId, task: CloudTask) =>
    Effect.gen(function* () {
      const checkedSessionId = yield* Effect.try({
        try: () => decodeStrict(SessionIdSchema, sessionId),
        catch: (error) => rejected(`spawn: invalid session id: ${reasonOf(error)}`),
      });
      const checkedTask = yield* Effect.try({
        try: () => decodeStrict(CloudTaskSchema, task),
        catch: (error) => rejected(`spawn: invalid task: ${reasonOf(error)}`),
      });
      const body = yield* makeRequestBody({ _tag: "Spawn", sessionId: checkedSessionId, task: checkedTask });
      const response = yield* request(
        config,
        fetcher,
        "spawn",
        checkedSessionId,
        "POST",
        CloudTaskRoute.spawn(checkedSessionId),
        CloudTaskResponseSchema,
        body,
      );
      return yield* Effect.try({
        try: () => responseValue(response, "admission", SessionAdmissionSchema),
        catch: (error) => rejected(`spawn: strict response decode failed: ${reasonOf(error)}`),
      });
    }),
  send: (sessionId, messageId, message) =>
    Effect.gen(function* () {
      const body = yield* makeRequestBody({ _tag: "Send", sessionId, messageId, message });
      const response = yield* request(
        config,
        fetcher,
        "send",
        sessionId,
        "POST",
        CloudTaskRoute.send(sessionId, messageId),
        CloudTaskResponseSchema,
        body,
      );
      return yield* Effect.try({
        try: () => responseValue(response, "acceptedCursor", AcceptedCursorSchema),
        catch: (error) => rejected(`send: strict response decode failed: ${reasonOf(error)}`),
      });
    }),
  observe: (sessionId, afterCursor = 0) =>
    Effect.gen(function* () {
      const response = yield* request(
        config,
        fetcher,
        "observe",
        sessionId,
        "GET",
        CloudTaskRoute.observe(sessionId, afterCursor),
        CloudTaskResponseSchema,
      );
      return yield* Effect.try({
        try: () => responseValue(response, "observations", Schema.Array(SessionObservationSchema)),
        catch: (error) => rejected(`observe: strict response decode failed: ${reasonOf(error)}`),
      });
    }),
  cancel: (sessionId, reason) =>
    Effect.gen(function* () {
      const body = yield* makeRequestBody({ _tag: "Cancel", sessionId, reason });
      const response = yield* request(
        config,
        fetcher,
        "cancel",
        sessionId,
        "POST",
        CloudTaskRoute.cancel(sessionId),
        CloudTaskResponseSchema,
        body,
      );
      return yield* Effect.try({
        try: () => responseValue(response, "observation", SessionObservationSchema),
        catch: (error) => rejected(`cancel: strict response decode failed: ${reasonOf(error)}`),
      });
    }),
  result: (sessionId) =>
    Effect.gen(function* () {
      const response = yield* request(
        config,
        fetcher,
        "result",
        sessionId,
        "GET",
        CloudTaskRoute.result(sessionId),
        CloudTaskResponseSchema,
      );
      return yield* Effect.try({
        try: () => responseValue(response, "result", SessionResultSchema),
        catch: (error) => rejected(`result: strict response decode failed: ${reasonOf(error)}`),
      });
    }),
});

export const makeCloudTaskClient = (
  config: OperatorConfig,
  options: CloudTaskHttpOptions = {},
): CloudTaskClient => makeClient(config, options.fetch ?? globalThis.fetch);

export const encodeCloudTaskRequest = (requestInput: unknown): string =>
  encodeStrict(CloudTaskRequestSchema, decodeStrict(CloudTaskRequestSchema, requestInput));

export const decodeCloudTaskResponse = (responseInput: unknown) =>
  decodeStrict(CloudTaskResponseSchema, responseInput);

export const decodeSessionAdmission = (responseInput: unknown): SessionAdmission =>
  responseValue(decodeCloudTaskResponse(responseInput), "admission", SessionAdmissionSchema);
export const decodeSessionObservation = (responseInput: unknown): SessionObservation =>
  responseValue(decodeCloudTaskResponse(responseInput), "observation", SessionObservationSchema);
export const decodeSessionResult = (responseInput: unknown): SessionResult =>
  responseValue(decodeCloudTaskResponse(responseInput), "result", SessionResultSchema);

export const isCloudTaskClientError = (error: unknown): error is CloudTaskClientError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof Reflect.get(error, "_tag") === "string";

import { Effect, Schema } from "effect";
import { CloudTaskSchema, MessageIdSchema, SessionIdSchema } from "@work-engine/protocol";
import type { CloudTaskClient } from "@work-engine/runtime";
import { isCloudTaskClientError, type CloudTaskClientError } from "./client.ts";

export const SessionToolName = {
  spawn: "session_spawn",
  send: "session_send",
  observe: "session_observe",
  cancel: "session_cancel",
  result: "session_result",
} as const;
export type SessionToolName = (typeof SessionToolName)[keyof typeof SessionToolName];

export interface McpTool {
  readonly name: SessionToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const SESSION_TOOLS: ReadonlyArray<McpTool> = [
  {
    name: SessionToolName.spawn,
    description: "Admit one caller-minted cloud Session task.",
    inputSchema: { type: "object", required: ["sessionId", "task"] },
  },
  {
    name: SessionToolName.send,
    description: "Send one caller-minted message to one cloud Session.",
    inputSchema: { type: "object", required: ["sessionId", "messageId", "message"] },
  },
  {
    name: SessionToolName.observe,
    description: "Read durable observations after an optional cursor.",
    inputSchema: { type: "object", required: ["sessionId"] },
  },
  {
    name: SessionToolName.cancel,
    description: "Cancel one cloud Session with a durable reason.",
    inputSchema: { type: "object", required: ["sessionId", "reason"] },
  },
  {
    name: SessionToolName.result,
    description: "Read one cloud Session result.",
    inputSchema: { type: "object", required: ["sessionId"] },
  },
];

export type McpError =
  | CloudTaskClientError
  | { readonly _tag: "McpDecodeFailure"; readonly reason: string }
  | { readonly _tag: "McpMethodNotFound"; readonly method: string }
  | { readonly _tag: "McpIoFailure"; readonly reason: string };

const JsonRpcIdSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Null]);
const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcIdSchema),
  method: Schema.NonEmptyString,
  params: Schema.optionalKey(Schema.Json),
});

type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

const SpawnParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  task: CloudTaskSchema,
});
const SendParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  messageId: MessageIdSchema,
  message: Schema.Json,
});
const ObserveParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  afterCursor: Schema.optionalKey(Schema.Natural),
});
const CancelParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  reason: Schema.NonEmptyString,
});
const ResultParamsSchema = Schema.Struct({ sessionId: SessionIdSchema });

const JsonRpcResponseSchema = Schema.Union([
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(JsonRpcIdSchema),
    result: Schema.Json,
  }),
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(JsonRpcIdSchema),
    error: Schema.Struct({
      code: Schema.Finite,
      message: Schema.NonEmptyString,
      data: Schema.optionalKey(Schema.Json),
    }),
  }),
]);
export type JsonRpcResponse = typeof JsonRpcResponseSchema.Type;
const JsonRpcResponseFromStringSchema = Schema.fromJsonString(JsonRpcResponseSchema);

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], McpError> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((error) => ({ _tag: "McpDecodeFailure" as const, reason: String(error) })),
  );

const clientError = (error: unknown): McpError =>
  isCloudTaskClientError(error) ? error : { _tag: "McpDecodeFailure", reason: String(error) };

const requestId = (request: JsonRpcRequest): string | number | null | undefined => request.id;

const invoke = (
  client: CloudTaskClient,
  method: SessionToolName,
  params: unknown,
): Effect.Effect<unknown, McpError> => {
  switch (method) {
    case SessionToolName.spawn:
      return decode(SpawnParamsSchema, params).pipe(
        Effect.flatMap(({ sessionId, task }) =>
          client.spawn(sessionId, task).pipe(Effect.mapError(clientError)),
        ),
      );
    case SessionToolName.send:
      return decode(SendParamsSchema, params).pipe(
        Effect.flatMap(({ sessionId, messageId, message }) =>
          client.send(sessionId, messageId, message).pipe(Effect.mapError(clientError)),
        ),
      );
    case SessionToolName.observe:
      return decode(ObserveParamsSchema, params).pipe(
        Effect.flatMap(({ sessionId, afterCursor }) =>
          client.observe(sessionId, afterCursor ?? 0).pipe(Effect.mapError(clientError)),
        ),
      );
    case SessionToolName.cancel:
      return decode(CancelParamsSchema, params).pipe(
        Effect.flatMap(({ sessionId, reason }) =>
          client.cancel(sessionId, reason).pipe(Effect.mapError(clientError)),
        ),
      );
    case SessionToolName.result:
      return decode(ResultParamsSchema, params).pipe(
        Effect.flatMap(({ sessionId }) =>
          client.result(sessionId).pipe(Effect.mapError(clientError)),
        ),
      );
  }
};

const methodOf = (method: string): SessionToolName | undefined =>
  method === SessionToolName.spawn ||
  method === SessionToolName.send ||
  method === SessionToolName.observe ||
  method === SessionToolName.cancel ||
  method === SessionToolName.result
    ? method
    : undefined;

export const handleMcpRequest = (
  client: CloudTaskClient,
  input: unknown,
): Effect.Effect<JsonRpcResponse, McpError> =>
  Effect.gen(function* () {
    const request = yield* decode(JsonRpcRequestSchema, input);
    const method = methodOf(request.method);
    if (method === undefined) {
      return yield* Effect.fail({ _tag: "McpMethodNotFound" as const, method: request.method });
    }
    const result = yield* invoke(client, method, request.params);
    return yield* decode(JsonRpcResponseSchema, {
      jsonrpc: "2.0",
      ...(requestId(request) === undefined ? {} : { id: requestId(request) }),
      result,
    });
  });

export interface McpStdio {
  readonly readLine: Effect.Effect<string | undefined, McpError>;
  readonly writeLine: (line: string) => Effect.Effect<void, McpError>;
}

const encodeResponse = (response: JsonRpcResponse): string =>
  Schema.encodeSync(JsonRpcResponseFromStringSchema)(response);

const errorResponse = (code: number, message: string): JsonRpcResponse =>
  Schema.decodeUnknownSync(JsonRpcResponseSchema, { onExcessProperty: "error" })({
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  });

export const runMcp = (client: CloudTaskClient, stdio: McpStdio): Effect.Effect<void, McpError> => {
  const processLine = (line: string): Effect.Effect<void, McpError> =>
    Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(line).pipe(
      Effect.result,
      Effect.flatMap((parsed) => {
        if (parsed._tag === "Failure") {
          return stdio.writeLine(encodeResponse(errorResponse(-32700, "Invalid JSON-RPC input")));
        }
        return handleMcpRequest(client, parsed.success).pipe(
          Effect.result,
          Effect.flatMap((handled) =>
            stdio.writeLine(
              encodeResponse(
                handled._tag === "Success"
                  ? handled.success
                  : errorResponse(-32000, "JSON-RPC request failed"),
              ),
            ),
          ),
        );
      }),
    );

  const loop: Effect.Effect<void, McpError> = Effect.suspend(() =>
    stdio.readLine.pipe(
      Effect.flatMap((line) =>
        line === undefined ? Effect.void : processLine(line).pipe(Effect.andThen(loop)),
      ),
    ),
  );
  return loop;
};

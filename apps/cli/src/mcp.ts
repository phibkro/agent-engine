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
  | { readonly _tag: "McpMethodNotFound"; readonly method: string };

const JsonRpcIdSchema = Schema.Union([Schema.String, Schema.Finite, Schema.Null]);
const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcIdSchema),
  method: Schema.NonEmptyString,
  params: Schema.optionalKey(Schema.Unknown),
});

type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

const SpawnParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  task: CloudTaskSchema,
});
const SendParamsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  messageId: MessageIdSchema,
  message: Schema.String,
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

export type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null | undefined;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null | undefined;
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
    };

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
    return { jsonrpc: "2.0", id: requestId(request), result } satisfies JsonRpcResponse;
  });

export interface McpStdio {
  readonly readLine: () => Promise<string | undefined>;
  readonly writeLine: (line: string) => Promise<void>;
}

export const runMcp = (client: CloudTaskClient, stdio: McpStdio): Effect.Effect<void, never> => {
  const processNext = async (): Promise<void> => {
    const line = await stdio.readLine();
    if (line === undefined) return;
    let input: unknown;
    try {
      input = JSON.parse(line) as unknown;
    } catch (error) {
      await stdio.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: String(error) },
        }),
      );
      return processNext();
    }
    const exit = await Effect.runPromiseExit(handleMcpRequest(client, input));
    await stdio.writeLine(
      exit._tag === "Success"
        ? JSON.stringify(exit.value)
        : JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: String(exit.cause) },
          }),
    );
    return processNext();
  };
  return Effect.promise(processNext).pipe(Effect.asVoid, Effect.orDie);
};

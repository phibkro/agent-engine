import { Effect, Schema } from "effect";
import {
  CloudTaskSchema,
  MessageIdSchema,
  SessionIdSchema,
  type CloudTask,
  type MessageId,
  type SessionId,
} from "@work-engine/protocol";
import type { CloudTaskClient } from "@work-engine/runtime";
import {
  isCloudTaskClientError,
  makeCloudTaskClient,
  type CloudTaskClientError,
} from "./client.ts";
import { loadOperatorConfig, type ConfigError, type OperatorConfig } from "./config.ts";
import { readTextFile } from "./platform.ts";

export const SessionOperation = {
  spawn: "spawn",
  send: "send",
  observe: "observe",
  cancel: "cancel",
  result: "result",
} as const;
export type SessionOperation = (typeof SessionOperation)[keyof typeof SessionOperation];

export interface ParsedInvocation {
  readonly operation: SessionOperation;
  readonly options: Readonly<Record<string, string>>;
}

export type ParseFailure = {
  readonly _tag: "UsageFailure";
  readonly reason: string;
};

const OPTION_NAMES: Readonly<Record<SessionOperation, Readonly<Record<string, true>>>> = {
  spawn: { "session-id": true, "task-file": true },
  send: { "session-id": true, "message-id": true, message: true },
  observe: { "session-id": true, after: true },
  cancel: { "session-id": true, reason: true },
  result: { "session-id": true },
};

const REQUIRED_OPTIONS: Readonly<Record<SessionOperation, ReadonlyArray<string>>> = {
  spawn: ["session-id", "task-file"],
  send: ["session-id", "message-id", "message"],
  observe: ["session-id"],
  cancel: ["session-id", "reason"],
  result: ["session-id"],
};

const usage = (reason: string): ParseFailure => ({ _tag: "UsageFailure", reason });

const OPERATION_BY_NAME: Readonly<Record<string, SessionOperation>> = {
  spawn: SessionOperation.spawn,
  send: SessionOperation.send,
  observe: SessionOperation.observe,
  cancel: SessionOperation.cancel,
  result: SessionOperation.result,
};

const operationOf = (value: string): SessionOperation | undefined => OPERATION_BY_NAME[value];

export const parseInvocation = (argv: ReadonlyArray<string>): ParsedInvocation | ParseFailure => {
  if (argv[0] !== "session")
    return usage("expected one of: session spawn|send|observe|cancel|result");
  const operationValue = argv[1];
  if (operationValue === undefined) return usage("missing session operation");
  const operation = operationOf(operationValue);
  if (operation === undefined) return usage(`unknown session operation: ${operationValue}`);

  const options: Record<string, string> = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      return usage(`unexpected argument: ${argument ?? ""}`);
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const name = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (OPTION_NAMES[operation][name] !== true) return usage(`unknown option: --${name}`);
    if (options[name] !== undefined) return usage(`duplicate option: --${name}`);
    const inlineValue = equals === -1 ? undefined : withoutPrefix.slice(equals + 1);
    const value = inlineValue ?? argv[index + 1];
    if (
      value === undefined ||
      value.length === 0 ||
      (inlineValue === undefined && value.startsWith("--"))
    ) {
      return usage(`missing value for --${name}`);
    }
    options[name] = value;
    if (inlineValue === undefined) index += 1;
  }
  for (const name of REQUIRED_OPTIONS[operation]) {
    if (options[name] === undefined) return usage(`missing required option: --${name}`);
  }
  return { operation, options };
};

const requiredOption = (
  invocation: ParsedInvocation,
  name: string,
): Effect.Effect<string, ParseFailure> => {
  const value = invocation.options[name];
  return value === undefined
    ? Effect.fail(usage(`missing required option: --${name}`))
    : Effect.succeed(value);
};

const optionalOption = (invocation: ParsedInvocation, name: string): string | undefined =>
  invocation.options[name];

const parseWith = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
): Effect.Effect<S["Type"], ParseFailure> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((error) => usage(`${label}: ${String(error)}`)),
  );

const parseSessionId = (invocation: ParsedInvocation): Effect.Effect<SessionId, ParseFailure> =>
  requiredOption(invocation, "session-id").pipe(
    Effect.flatMap((value) => parseWith(SessionIdSchema, value, "session id")),
  );
const parseMessageId = (invocation: ParsedInvocation): Effect.Effect<MessageId, ParseFailure> =>
  requiredOption(invocation, "message-id").pipe(
    Effect.flatMap((value) => parseWith(MessageIdSchema, value, "message id")),
  );

const parseNatural = (value: string, label: string): Effect.Effect<number, ParseFailure> => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Effect.succeed(parsed)
    : Effect.fail(usage(`${label} must be a non-negative integer`));
};

const readJsonFile = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  path: string,
): Effect.Effect<S["Type"], ParseFailure> =>
  Effect.gen(function* () {
    const text = yield* readTextFile(path).pipe(
      Effect.mapError((error) => usage(`cannot read ${path}: ${String(error)}`)),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => usage(`invalid JSON in ${path}: ${String(error)}`),
    });
    return yield* parseWith(schema, parsed, path);
  });

export const readCloudTask = (path: string): Effect.Effect<CloudTask, ParseFailure> =>
  readJsonFile(CloudTaskSchema, path);

const clientFailure = (error: unknown): CloudTaskClientError => {
  if (isCloudTaskClientError(error)) return error;
  return { _tag: "CloudTaskUnavailable", reason: String(error) };
};

const executeSpawn = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, ParseFailure | CloudTaskClientError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseSessionId(invocation);
    const taskFile = yield* requiredOption(invocation, "task-file");
    const task = yield* readCloudTask(taskFile);
    if (task.sessionId !== sessionId) {
      return yield* Effect.fail(
        usage("task.sessionId must equal the caller-provided --session-id"),
      );
    }
    return yield* client.spawn(sessionId, task).pipe(Effect.mapError(clientFailure));
  });

const executeSend = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, ParseFailure | CloudTaskClientError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseSessionId(invocation);
    const messageId = yield* parseMessageId(invocation);
    const message = yield* requiredOption(invocation, "message");
    return yield* client.send(sessionId, messageId, message).pipe(Effect.mapError(clientFailure));
  });

const executeObserve = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, ParseFailure | CloudTaskClientError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseSessionId(invocation);
    const after = optionalOption(invocation, "after");
    const afterCursor = after === undefined ? 0 : yield* parseNatural(after, "after");
    return yield* client.observe(sessionId, afterCursor).pipe(Effect.mapError(clientFailure));
  });

const executeCancel = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, ParseFailure | CloudTaskClientError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseSessionId(invocation);
    const reason = yield* requiredOption(invocation, "reason");
    return yield* client.cancel(sessionId, reason).pipe(Effect.mapError(clientFailure));
  });

const executeResult = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, ParseFailure | CloudTaskClientError> =>
  parseSessionId(invocation).pipe(
    Effect.flatMap((sessionId) => client.result(sessionId).pipe(Effect.mapError(clientFailure))),
  );

export type CommandFailure = ParseFailure | ConfigError | CloudTaskClientError;

export const executeInvocation = (
  invocation: ParsedInvocation,
  client: CloudTaskClient,
): Effect.Effect<unknown, CommandFailure> => {
  switch (invocation.operation) {
    case "spawn":
      return executeSpawn(invocation, client);
    case "send":
      return executeSend(invocation, client);
    case "observe":
      return executeObserve(invocation, client);
    case "cancel":
      return executeCancel(invocation, client);
    case "result":
      return executeResult(invocation, client);
  }
};

export const loadClientForInvocation = (
  _invocation: ParsedInvocation,
): Effect.Effect<
  { readonly client: CloudTaskClient; readonly config: OperatorConfig },
  ConfigError
> =>
  loadOperatorConfig.pipe(
    Effect.map((config) => ({
      config,
      client: makeCloudTaskClient(config),
    })),
  );

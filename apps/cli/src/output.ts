import { Match, Schema } from "effect";
import type { ConfigError } from "./config.ts";
import type { CloudTaskClientError } from "./client.ts";
import type { ParseFailure, SessionOperation } from "./commands.ts";

const SessionOperationSchema = Schema.Literals(["spawn", "send", "observe", "cancel", "result"]);

export const ResultEnvelopeSchema = Schema.TaggedStruct("CloudTaskResult", {
  operation: SessionOperationSchema,
  ok: Schema.Boolean,
  data: Schema.optionalKey(Schema.Unknown),
  failure: Schema.optionalKey(Schema.Unknown),
});
const ResultEnvelopeFromStringSchema = Schema.fromJsonString(ResultEnvelopeSchema);
const UnknownFromStringSchema = Schema.fromJsonString(Schema.Unknown);

export const ExitCode = {
  success: 0,
  usage: 2,
  unauthorized: 3,
  notFound: 4,
  rejected: 5,
  decode: 6,
  unavailable: 7,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type CliFailure =
  | ConfigError
  | CloudTaskClientError
  | ParseFailure
  | { readonly _tag: "McpDecodeFailure"; readonly reason: string }
  | { readonly _tag: "McpMethodNotFound"; readonly method: string }
  | { readonly _tag: "UnexpectedFailure"; readonly reason: string };

export interface ResultEnvelope {
  readonly _tag: "CloudTaskResult";
  readonly operation: SessionOperation;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly failure?: CliFailure;
}

export const exitCodeFor = Match.typeTags<CliFailure, ExitCode>()({
  UsageFailure: () => ExitCode.usage,
  CloudTaskUnauthorized: () => ExitCode.unauthorized,
  CloudTaskNotFound: () => ExitCode.notFound,
  CloudTaskRejected: () => ExitCode.rejected,
  CloudTaskTerminal: () => ExitCode.rejected,
  ConfigDecodeFailure: () => ExitCode.decode,
  ConfigPermissions: () => ExitCode.decode,
  ConfigIoFailure: () => ExitCode.decode,
  ConfigMissing: () => ExitCode.decode,
  McpDecodeFailure: () => ExitCode.decode,
  McpMethodNotFound: () => ExitCode.decode,
  CloudTaskUnavailable: () => ExitCode.unavailable,
  UnexpectedFailure: () => ExitCode.unavailable,
});

export const successEnvelope = (operation: SessionOperation, data: unknown): ResultEnvelope => ({
  _tag: "CloudTaskResult",
  operation,
  ok: true,
  data,
});

export const failureEnvelope = (
  operation: SessionOperation,
  failure: CliFailure,
): ResultEnvelope => ({
  _tag: "CloudTaskResult",
  operation,
  ok: false,
  failure,
});

export const renderJson = (envelope: ResultEnvelope): string =>
  Schema.encodeSync(ResultEnvelopeFromStringSchema, { onExcessProperty: "error" })(envelope);

export const renderInteractive = (envelope: ResultEnvelope): string => {
  if (!envelope.ok) {
    return `${envelope.operation}: failed [${envelope.failure?._tag ?? "UnexpectedFailure"}] ${
      envelope.failure === undefined
        ? ""
        : Schema.encodeSync(UnknownFromStringSchema)(envelope.failure)
    }`;
  }
  return `${envelope.operation}: ${Schema.encodeSync(UnknownFromStringSchema)(envelope.data)}`;
};

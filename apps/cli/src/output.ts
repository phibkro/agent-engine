import type { ConfigError } from "./config.ts";
import type { CloudTaskClientError } from "./client.ts";
import type { ParseFailure, SessionOperation } from "./commands.ts";

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

export const exitCodeFor = (failure: CliFailure): ExitCode => {
  switch (failure._tag) {
    case "UsageFailure":
      return ExitCode.usage;
    case "CloudTaskUnauthorized":
      return ExitCode.unauthorized;
    case "CloudTaskNotFound":
      return ExitCode.notFound;
    case "CloudTaskRejected":
    case "CloudTaskTerminal":
      return ExitCode.rejected;
    case "ConfigDecodeFailure":
    case "ConfigPermissions":
    case "ConfigIoFailure":
    case "ConfigMissing":
    case "McpDecodeFailure":
    case "McpMethodNotFound":
      return ExitCode.decode;
    case "CloudTaskUnavailable":
      return ExitCode.unavailable;
    case "UnexpectedFailure":
      return ExitCode.unavailable;
  }
};

export const successEnvelope = (
  operation: SessionOperation,
  data: unknown,
): ResultEnvelope => ({
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

export const renderJson = (envelope: ResultEnvelope): string => JSON.stringify(envelope);

export const renderInteractive = (envelope: ResultEnvelope): string => {
  if (!envelope.ok) {
    return `${envelope.operation}: failed [${envelope.failure?._tag ?? "UnexpectedFailure"}] ${
      envelope.failure === undefined ? "" : JSON.stringify(envelope.failure)
    }`;
  }
  return `${envelope.operation}: ${JSON.stringify(envelope.data)}`;
};

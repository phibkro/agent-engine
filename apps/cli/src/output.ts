import type { ConfigError } from "./config.ts";
import type { AttachError } from "./attach.ts";
import type { RemoteClientError } from "./client.ts";

export const ExitCode = {
  success: 0,
  usage: 2,
  authentication: 3,
  domain: 4,
  unavailable: 5,
  cancelled: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type CliFailure =
  | ConfigError
  | AttachError
  | RemoteClientError
  | { readonly _tag: "UsageFailure"; readonly reason: string }
  | { readonly _tag: "DomainFailure"; readonly reason: string }
  | { readonly _tag: "Cancelled"; readonly reason: string };

export interface ResultEnvelope {
  readonly _tag: "WorkResult";
  readonly command: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly _tag: string;
    readonly reason: string;
    readonly exitCode: ExitCode;
  };
}

const reasonOf = (value: CliFailure): string => {
  if ("reason" in value) return value.reason;
  if (value._tag === "DomainRejection") return `${value.failure.code}: ${value.failure.reason}`;
  if (value._tag === "AttachVersionMismatch") {
    return `Herdr version mismatch (local ${value.local}, remote ${value.remote})`;
  }
  if (value._tag === "ConfigMissing") return `missing ${value.name}`;
  return value._tag;
};

export const exitCodeFor = (failure: CliFailure): ExitCode => {
  switch (failure._tag) {
    case "UsageFailure":
    case "ConfigDecodeFailure":
    case "DecodeFailure":
      return ExitCode.usage;
    case "ConfigMissing":
    case "ConfigPermissions":
    case "OperatorRequired":
    case "AuthenticationFailure":
    case "AuthorizationFailure":
      return ExitCode.authentication;
    case "DomainFailure":
    case "DomainRejection":
    case "AttachExpired":
    case "AttachBindingMismatch":
    case "AttachResolutionUnsafe":
      return failure._tag.startsWith("Attach") ? ExitCode.domain : ExitCode.domain;
    case "Cancelled":
      return ExitCode.cancelled;
    case "AttachFilesystemFailure":
    case "AttachVersionMismatch":
    case "AttachProbeFailure":
    case "AttachHerdrFailure":
    case "DependencyUnavailable":
    case "TransportFailure":
    case "ConfigIoFailure":
      return ExitCode.unavailable;
    default:
      return ExitCode.unavailable;
  }
};

export const successEnvelope = (command: string, data: unknown): ResultEnvelope => ({
  _tag: "WorkResult",
  command,
  ok: true,
  data,
});

export const failureEnvelope = (command: string, failure: CliFailure): ResultEnvelope => ({
  _tag: "WorkResult",
  command,
  ok: false,
  error: {
    _tag: failure._tag,
    reason: reasonOf(failure),
    exitCode: exitCodeFor(failure),
  },
});

export const renderJson = (envelope: ResultEnvelope): string => JSON.stringify(envelope);

const evidenceReferences = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null) return [];
  const evidenceIds = (value as { readonly evidenceIds?: unknown }).evidenceIds;
  if (!Array.isArray(evidenceIds)) return [];
  return evidenceIds.filter((item): item is string => typeof item === "string");
};

export const renderInteractive = (command: string, data: unknown): string => {
  if (typeof data !== "object" || data === null) return `${command}: ${String(data)}`;
  const record = data as Record<string, unknown>;
  const lines = [`${command}: accepted`];
  if (typeof record.projectId === "string") lines.push(`project ${record.projectId}`);
  if (typeof record.eventRevision === "number") lines.push(`event revision ${record.eventRevision}`);
  if (typeof record.contentRevision === "number") lines.push(`content revision ${record.contentRevision}`);
  if (typeof record.resolutionId === "string") lines.push(`resolution ${record.resolutionId}`);
  if (typeof record.alias === "string") lines.push(`SSH target ${record.alias}`);
  if (typeof record.configPath === "string") lines.push(`SSH config ${record.configPath}`);
  const refs = evidenceReferences(data);
  if (refs.length > 0) lines.push(`evidence ${refs.join(", ")}`);
  const history = record.history;
  if (Array.isArray(history)) {
    for (const item of history) {
      if (typeof item !== "object" || item === null) continue;
      const event = item as Record<string, unknown>;
      const eventRevision = event.eventRevision;
      const payload = event.event;
      const tag = typeof payload === "object" && payload !== null && "_tag" in payload ? String(payload._tag) : "event";
      if (typeof eventRevision === "number") lines.push(`event ${eventRevision}: ${tag}`);
      const refsForEvent = evidenceReferences(payload);
      if (refsForEvent.length > 0) lines.push(`  evidence ${refsForEvent.join(", ")}`);
    }
  }
  return lines.join("\n");
};

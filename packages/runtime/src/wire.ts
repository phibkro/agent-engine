import * as Schema from "effect/Schema";
import {
  CommandResultSchema,
  ProjectIdSchema,
  SessionHostReceiptSchema,
  SessionIdSchema,
  TimestampSchema,
  WorkIdSchema,
  WorkspaceReadySchema,
} from "@work-engine/protocol";

const NonEmptyStringSchema = Schema.NonEmptyString;

export const SessionHostCancelRequestSchema = Schema.TaggedStruct("SessionHostCancelRequest", {
  sessionId: SessionIdSchema,
  reason: NonEmptyStringSchema,
});
export type SessionHostCancelRequest = typeof SessionHostCancelRequestSchema.Type;

export const SessionHostWireFailureSchema = Schema.TaggedStruct("SessionHostWireFailure", {
  code: Schema.Literals([
    "lease_expired",
    "workspace_unavailable",
    "readiness_failed",
    "version_mismatch",
    "session_not_found",
    "session_already_started",
    "process_unavailable",
    "model_unavailable",
    "host_unavailable",
    "decode_failure",
  ] as const),
  reason: NonEmptyStringSchema,
});
export type SessionHostWireFailure = typeof SessionHostWireFailureSchema.Type;

export const SessionHostWireResponseSchema = Schema.Union([
  WorkspaceReadySchema,
  SessionHostReceiptSchema,
  SessionHostWireFailureSchema,
]);
export type SessionHostWireResponse = typeof SessionHostWireResponseSchema.Type;

export const AttachResolutionRequestSchema = Schema.TaggedStruct("AttachResolutionRequest", {
  workId: WorkIdSchema,
});
export type AttachResolutionRequest = typeof AttachResolutionRequestSchema.Type;

export const AttachResolutionSchema = Schema.TaggedStruct("AttachResolution", {
  resolutionId: NonEmptyStringSchema,
  projectId: ProjectIdSchema,
  workId: WorkIdSchema,
  containerInstanceId: NonEmptyStringSchema,
  sshHost: NonEmptyStringSchema,
  sshPort: Schema.Natural,
  sshUser: NonEmptyStringSchema,
  proxyCommand: NonEmptyStringSchema,
  herdrSessionName: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
});
export type AttachResolution = typeof AttachResolutionSchema.Type;

export const ProjectCreateResultSchema = Schema.TaggedStruct("ProjectCreateResult", {
  projectId: ProjectIdSchema,
  result: CommandResultSchema,
});
export type ProjectCreateResult = typeof ProjectCreateResultSchema.Type;

export const WorkEngineHeader = {
  accessClientId: "CF-Access-Client-Id",
  accessClientSecret: "CF-Access-Client-Secret",
  actorId: "X-Work-Engine-Actor-Id",
  grantIds: "X-Work-Engine-Grant-Ids",
} as const;

export const ApiFailureSchema = Schema.TaggedStruct("ApiFailure", {
  code: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
});
export type ApiFailure = typeof ApiFailureSchema.Type;

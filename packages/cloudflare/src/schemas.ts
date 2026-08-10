import * as Schema from "effect/Schema";
import {
  AcceptedReceiptSchema,
  AgentProfileSchema,
  ArtifactReceiptSchema,
  AuthenticatedActorSchema,
  CommandReceiptSchema,
  ContentManifestSchema,
  EffectRequestSchema,
  EventEnvelopeSchema,
  EvidenceSchema,
  GrantSchema,
  HandoffSchema,
  MergeReceiptSchema,
  PolicySchema,
  ProposalSchema,
  ProjectIdSchema,
  ProjectCommandSchema,
  SessionSchema,
  WorkSchema,
  WorkspaceLeaseSchema,
} from "@work-engine/protocol";
import {
  AttachResolutionSchema,
  SessionHostCancelRequestSchema,
  SessionHostWireResponseSchema,
} from "@work-engine/runtime";
import type { ProjectState } from "@work-engine/kernel";

const NonEmptyStringSchema = Schema.NonEmptyString;

export const WorkProcessSchema = Schema.Struct({
  workProcessId: NonEmptyStringSchema,
  workId: NonEmptyStringSchema,
  resourceIds: Schema.Array(NonEmptyStringSchema),
  requiredGates: Schema.Array(Schema.String),
});

const ResourceClaimsSchema = Schema.Record(Schema.String, WorkspaceLeaseSchema);
const ResourceMapSchema = Schema.Record(Schema.String, ResourceClaimsSchema);
const EffectReceiptSchema = Schema.Struct({
  effectId: NonEmptyStringSchema,
  kind: Schema.Literals(["request", "started", "terminal"] as const),
  receipt: AcceptedReceiptSchema,
});

/** The complete authority snapshot persisted in SQLite. */
export const ProjectStateSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  eventRevision: Schema.Natural,
  contentRevision: Schema.Natural,
  policy: PolicySchema,
  canonicalContent: Schema.NullOr(ContentManifestSchema),
  works: Schema.Record(Schema.String, WorkSchema),
  workProcesses: Schema.Record(Schema.String, WorkProcessSchema),
  profiles: Schema.Record(Schema.String, AgentProfileSchema),
  sessions: Schema.Record(Schema.String, SessionSchema),
  resources: ResourceMapSchema,
  handoffs: Schema.Record(Schema.String, HandoffSchema),
  evidence: Schema.Record(Schema.String, EvidenceSchema),
  proposals: Schema.Record(Schema.String, ProposalSchema),
  grants: Schema.Record(Schema.String, GrantSchema),
  mergeReceipts: Schema.Record(Schema.String, MergeReceiptSchema),
  history: Schema.Array(EventEnvelopeSchema),
  commandReceipts: Schema.Record(Schema.String, CommandReceiptSchema),
  effectReceipts: Schema.Record(Schema.String, EffectReceiptSchema),
  outbox: Schema.Array(EffectRequestSchema),
});

export const AttachResolutionRecordSchema = Schema.Struct({
  resolution: AttachResolutionSchema,
  containerGeneration: NonEmptyStringSchema,
  managerSessionId: NonEmptyStringSchema,
  authorizedSshKeyName: NonEmptyStringSchema,
});

export const ProjectSnapshotSchema = Schema.TaggedStruct("ProjectSnapshot", {
  state: ProjectStateSchema,
  dispatchedEffects: Schema.Record(Schema.String, Schema.Boolean),
  workflowStarts: Schema.Record(Schema.String, Schema.Boolean),
  attachResolutions: Schema.Record(Schema.String, AttachResolutionRecordSchema),
  modelUsage: Schema.Record(Schema.String, Schema.Natural),
});
export type ProjectSnapshot = typeof ProjectSnapshotSchema.Type;

export const ProjectCommandRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal("work-engine/v1"),
  commandId: Schema.NonEmptyString,
  projectId: ProjectIdSchema,
  expectedRevision: Schema.Natural,
  actor: AuthenticatedActorSchema,
  command: ProjectCommandSchema,
});

export const ProjectCreateRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal("work-engine/v1"),
  commandId: Schema.NonEmptyString,
  command: Schema.Struct({
    _tag: Schema.Literal("CreateProject"),
    policy: PolicySchema,
    grants: Schema.optionalKey(Schema.Array(GrantSchema)),
  }),
});

export const ObservationRequestSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  eventRevision: Schema.optionalKey(Schema.Natural),
});

export const WorkflowStartReceiptRequestSchema = Schema.TaggedStruct("WorkflowStartReceipt", {
  effectId: NonEmptyStringSchema,
});

export const OutboxMessageSchema = Schema.TaggedStruct("OutboxMessage", {
  projectId: ProjectIdSchema,
  effect: EffectRequestSchema,
});
export type OutboxMessage = typeof OutboxMessageSchema.Type;

export const AttachResolutionResponseSchema = AttachResolutionSchema;
export const SessionHostResponseSchema = SessionHostWireResponseSchema;
export const SessionHostCancelSchema = SessionHostCancelRequestSchema;
export const ArtifactReceiptResponseSchema = ArtifactReceiptSchema;

export const ModelAuthorizationRequestSchema = Schema.TaggedStruct("ModelAuthorizationRequest", {
  sessionId: NonEmptyStringSchema,
  requestedTokens: Schema.Natural,
});
export type ModelAuthorizationRequest = typeof ModelAuthorizationRequestSchema.Type;

export const ModelAuthorizationSchema = Schema.TaggedStruct("ModelAuthorization", {
  sessionId: NonEmptyStringSchema,
  remainingTokens: Schema.Natural,
});
export type ModelAuthorization = typeof ModelAuthorizationSchema.Type;

export const OperationalObservationSchema = Schema.TaggedStruct("OperationalObservation", {
  operation: Schema.NonEmptyString,
  at: Schema.String,
  outcome: Schema.Literals(["accepted", "rejected", "failed"] as const),
  projectId: Schema.optionalKey(ProjectIdSchema),
  effectId: Schema.optionalKey(NonEmptyStringSchema),
  durationMs: Schema.optionalKey(Schema.Natural),
  details: Schema.Record(Schema.String, Schema.Json),
});
export type OperationalObservation = typeof OperationalObservationSchema.Type;

export type PersistedProjectState = typeof ProjectStateSchema.Type & ProjectState;

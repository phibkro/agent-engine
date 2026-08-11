import { Schema } from "effect";
import {
  CommitShaSchema,
  NonEmptyStringSchema,
  SchemaVersionSchema,
  Sha256DigestSchema,
  TimestampSchema,
} from "./identifiers.ts";

const PositiveIntSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const NonNegativeIntSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const EnvironmentIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
  Schema.brand("EnvironmentId"),
);
export type EnvironmentId = typeof EnvironmentIdSchema.Type;

export const EnvironmentCommandIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?:create|recover|destroy|checkpoint)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
  Schema.brand("EnvironmentCommandId"),
);
export type EnvironmentCommandId = typeof EnvironmentCommandIdSchema.Type;

export const GitRepositorySchema = Schema.Struct({
  owner: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});
export type GitRepository = typeof GitRepositorySchema.Type;

export const AgentProviderSchema = Schema.Literals(["claude", "codex"] as const);
export type AgentProvider = typeof AgentProviderSchema.Type;

export const EnvironmentCreateRequestSchema = Schema.TaggedStruct("CreateEnvironment", {
  commandId: EnvironmentCommandIdSchema,
  environmentId: EnvironmentIdSchema,
  ownerId: NonEmptyStringSchema,
  repository: GitRepositorySchema,
  baseCommit: CommitShaSchema,
  provider: AgentProviderSchema,
});

export const EnvironmentRecoverRequestSchema = Schema.TaggedStruct("RecoverEnvironment", {
  commandId: EnvironmentCommandIdSchema,
  environmentId: EnvironmentIdSchema,
});
export type EnvironmentRecoverRequest = typeof EnvironmentRecoverRequestSchema.Type;

export const EnvironmentDestroyRequestSchema = Schema.TaggedStruct("DestroyEnvironment", {
  commandId: EnvironmentCommandIdSchema,
  environmentId: EnvironmentIdSchema,
});
export type EnvironmentDestroyRequest = typeof EnvironmentDestroyRequestSchema.Type;

export const EnvironmentCheckpointRequestSchema = Schema.TaggedStruct("CheckpointEnvironment", {
  commandId: EnvironmentCommandIdSchema,
  environmentId: EnvironmentIdSchema,
});
export type EnvironmentCheckpointRequest = typeof EnvironmentCheckpointRequestSchema.Type;

export const EnvironmentCommandRequestSchema = Schema.Union([
  EnvironmentCreateRequestSchema,
  EnvironmentRecoverRequestSchema,
  EnvironmentDestroyRequestSchema,
  EnvironmentCheckpointRequestSchema,
]);
export type EnvironmentCommandRequest = typeof EnvironmentCommandRequestSchema.Type;

export const EnvironmentPairingScopesSchema = Schema.Tuple([
  Schema.Literal("orchestration:read"),
  Schema.Literal("orchestration:operate"),
  Schema.Literal("terminal:operate"),
  Schema.Literal("review:write"),
  Schema.Literal("relay:read"),
]);
export type EnvironmentPairingScopes = typeof EnvironmentPairingScopesSchema.Type;

export const EnvironmentPairingSchema = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s/]+(?:\/.*)?$/)),
  token: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  scopes: EnvironmentPairingScopesSchema,
});
export type EnvironmentPairing = typeof EnvironmentPairingSchema.Type;

export const EnvironmentCredentialLeaseSchema = Schema.Struct({
  generationToken: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
});
export type EnvironmentCredentialLease = typeof EnvironmentCredentialLeaseSchema.Type;

export const EnvironmentPairingOutputSchema = Schema.Struct({
  token: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
});
export type EnvironmentPairingOutput = typeof EnvironmentPairingOutputSchema.Type;

export const SandboxProcessStateSchema = Schema.Struct({
  status: NonEmptyStringSchema,
});
export type SandboxProcessState = typeof SandboxProcessStateSchema.Type;
export type EnvironmentCreateRequest = typeof EnvironmentCreateRequestSchema.Type;

export const EnvironmentLifecycleSchema = Schema.Literals([
  "Requested",
  "Starting",
  "Ready",
  "Checkpointing",
  "Recovering",
  "Destroying",
  "Destroyed",
  "Failed",
] as const);
export type EnvironmentLifecycle = typeof EnvironmentLifecycleSchema.Type;

export const RuntimeVersionTupleSchema = Schema.Struct({
  imageDigest: Sha256DigestSchema,
  t3codeVersion: NonEmptyStringSchema,
  sandboxSdkVersion: NonEmptyStringSchema,
});
export type RuntimeVersionTuple = typeof RuntimeVersionTupleSchema.Type;

export const SandboxGenerationSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  ordinal: PositiveIntSchema,
});
export type SandboxGeneration = typeof SandboxGenerationSchema.Type;

export const DirectoryBackupSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  dir: Schema.Literal("/workspace/environment"),
});
export type DirectoryBackup = typeof DirectoryBackupSchema.Type;

export const EnvironmentCheckpointSchema = Schema.Struct({
  generation: PositiveIntSchema,
  stateCapture: Schema.Literal("quiesced"),
  head: CommitShaSchema,
  versions: RuntimeVersionTupleSchema,
  backup: DirectoryBackupSchema,
  validated: Schema.Boolean,
  createdAt: TimestampSchema,
});
export type EnvironmentCheckpoint = typeof EnvironmentCheckpointSchema.Type;

export const EnvironmentCommandReceiptSchema = Schema.Struct({
  commandId: EnvironmentCommandIdSchema,
  requestDigest: Sha256DigestSchema,
  result: Schema.Json,
  acceptedAt: TimestampSchema,
});
export type EnvironmentCommandReceipt = typeof EnvironmentCommandReceiptSchema.Type;

export const EnvironmentSnapshotSchema = Schema.TaggedStruct("EnvironmentSnapshot", {
  schemaVersion: SchemaVersionSchema,
  environmentId: EnvironmentIdSchema,
  ownerId: NonEmptyStringSchema,
  repository: GitRepositorySchema,
  baseCommit: CommitShaSchema,
  provider: AgentProviderSchema,
  lifecycle: EnvironmentLifecycleSchema,
  versions: RuntimeVersionTupleSchema,
  generation: Schema.NullOr(SandboxGenerationSchema),
  retiredGenerationIds: Schema.Array(NonEmptyStringSchema),
  acceptedCheckpoint: Schema.NullOr(EnvironmentCheckpointSchema),
  dataLossWarning: Schema.Boolean,
  retainedCheckpoints: Schema.Array(EnvironmentCheckpointSchema),
  checkpointFailures: NonNegativeIntSchema,
  checkpointRetryAt: Schema.NullOr(TimestampSchema),
  recoveryFailures: NonNegativeIntSchema,
  recoveryRetryAt: Schema.NullOr(TimestampSchema),
  recoveryRequest: Schema.NullOr(EnvironmentRecoverRequestSchema),
  commandReceipts: Schema.Array(EnvironmentCommandReceiptSchema),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
  expiresAt: TimestampSchema,
  inactivityDeadline: TimestampSchema,
});
export type EnvironmentSnapshot = typeof EnvironmentSnapshotSchema.Type;

export const EnvironmentInspectedResponseSchema = Schema.TaggedStruct("EnvironmentInspected", {
  snapshot: Schema.optionalKey(EnvironmentSnapshotSchema),
});
export type EnvironmentInspectedResponse = typeof EnvironmentInspectedResponseSchema.Type;

export const EnvironmentCreatedResponseSchema = Schema.TaggedStruct("EnvironmentCreated", {
  snapshot: EnvironmentSnapshotSchema,
  pairingUrl: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  scopes: EnvironmentPairingScopesSchema,
});
export type EnvironmentCreatedResponse = typeof EnvironmentCreatedResponseSchema.Type;

export const EnvironmentRecoveredResponseSchema = Schema.TaggedStruct("EnvironmentRecovered", {
  snapshot: EnvironmentSnapshotSchema,
});
export type EnvironmentRecoveredResponse = typeof EnvironmentRecoveredResponseSchema.Type;

export const EnvironmentDestroyedResponseSchema = Schema.TaggedStruct("EnvironmentDestroyed", {
  snapshot: EnvironmentSnapshotSchema,
});
export type EnvironmentDestroyedResponse = typeof EnvironmentDestroyedResponseSchema.Type;

export const EnvironmentCheckpointedResponseSchema = Schema.TaggedStruct(
  "EnvironmentCheckpointed",
  {
    snapshot: EnvironmentSnapshotSchema,
  },
);
export type EnvironmentCheckpointedResponse = typeof EnvironmentCheckpointedResponseSchema.Type;

export const EnvironmentCommandResponseSchema = Schema.Union([
  EnvironmentCreatedResponseSchema,
  EnvironmentRecoveredResponseSchema,
  EnvironmentDestroyedResponseSchema,
  EnvironmentCheckpointedResponseSchema,
]);
export type EnvironmentCommandResponse = typeof EnvironmentCommandResponseSchema.Type;

export const EnvironmentUnauthorizedFailureSchema = Schema.TaggedStruct("Unauthorized", {
  reason: NonEmptyStringSchema,
});
export type EnvironmentUnauthorizedFailure = typeof EnvironmentUnauthorizedFailureSchema.Type;

export const EnvironmentInvalidRequestFailureSchema = Schema.TaggedStruct("InvalidRequest", {
  reason: NonEmptyStringSchema,
});
export type EnvironmentInvalidRequestFailure = typeof EnvironmentInvalidRequestFailureSchema.Type;

export const EnvironmentProviderUnavailableFailureSchema = Schema.TaggedStruct(
  "ProviderUnavailable",
  {
    reason: NonEmptyStringSchema,
  },
);
export type EnvironmentProviderUnavailableFailure =
  typeof EnvironmentProviderUnavailableFailureSchema.Type;

export const EnvironmentRuntimeFailureSchema = Schema.TaggedStruct("EnvironmentRuntimeFailure", {
  reason: NonEmptyStringSchema,
});
export type EnvironmentRuntimeFailure = typeof EnvironmentRuntimeFailureSchema.Type;

export const EnvironmentRouterFailureSchema = Schema.TaggedStruct("EnvironmentRouterFailure", {
  reason: NonEmptyStringSchema,
});
export type EnvironmentRouterFailure = typeof EnvironmentRouterFailureSchema.Type;

export const EnvironmentFailureSchema = Schema.Union([
  EnvironmentUnauthorizedFailureSchema,
  EnvironmentInvalidRequestFailureSchema,
  EnvironmentProviderUnavailableFailureSchema,
  EnvironmentRuntimeFailureSchema,
  EnvironmentRouterFailureSchema,
]);
export type EnvironmentFailure = typeof EnvironmentFailureSchema.Type;

export const EnvironmentRateLimitedResponseSchema = Schema.TaggedStruct(
  "EnvironmentRateLimited",
  {},
);
export type EnvironmentRateLimitedResponse = typeof EnvironmentRateLimitedResponseSchema.Type;

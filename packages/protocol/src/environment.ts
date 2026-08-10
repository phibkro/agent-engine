import { Schema } from "effect";
import {
  CommitShaSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  TimestampSchema,
} from "./identifiers.ts";

const PositiveIntSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

export const EnvironmentIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
  Schema.brand("EnvironmentId"),
);
export type EnvironmentId = typeof EnvironmentIdSchema.Type;

export const EnvironmentCommandIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?:create|recover|destroy)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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

export const EnvironmentCommandRequestSchema = Schema.Union([
  EnvironmentCreateRequestSchema,
  EnvironmentRecoverRequestSchema,
  EnvironmentDestroyRequestSchema,
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
  commandReceipts: Schema.Array(EnvironmentCommandReceiptSchema),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
  expiresAt: TimestampSchema,
  inactivityDeadline: TimestampSchema,
});
export type EnvironmentSnapshot = typeof EnvironmentSnapshotSchema.Type;

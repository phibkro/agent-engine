import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Json } from "effect/Schema";
import { Schema } from "effect";
import {
  AcceptedCursorSchema,
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CloudTaskSchema,
  DependencyCacheManifestSchema,
  DependencyCacheRestoreSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProfileSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProvenanceSchema,
  RepositoryGrantSchema,
  SessionAdmissionSchema,
  SessionIdSchema,
  SessionObservationSchema,
  SessionResultSchema,
  Sha256DigestSchema,
  TerminalSessionStateSchema,
  VerifiedWorkspaceSchema,
  decodeUnknownStrict,
  type AcceptedCursor,
  type CandidateReceipt,
  type CheckpointReceipt,
  type CloudTask,
  type DependencyCacheManifest,
  type DependencyCacheRestore,
  type MemoryProposalId,
  type MemoryRevision,
  type MessageId,
  type Profile,
  type ProfileId,
  type ProfileRevision,
  type ProjectMemoryFact,
  type ProjectMemoryProvenance,
  type RepositoryGrant,
  type SessionAdmission,
  type SessionId,
  type SessionObservation,
  type SessionResult,
  type Sha256Digest,
  type VerifiedWorkspace,
} from "@work-engine/protocol";

export type {
  AcceptedCursor,
  CandidateReceipt,
  CheckpointReceipt,
  CloudTask,
  DependencyCacheManifest,
  DependencyCacheRestore,
  MemoryProposalId,
  MemoryRevision,
  MessageId,
  Profile,
  ProfileId,
  ProfileRevision,
  ProjectMemoryFact,
  ProjectMemoryProvenance,
  RepositoryGrant,
  SessionAdmission,
  SessionId,
  SessionObservation,
  SessionResult,
  Sha256Digest,
  VerifiedWorkspace,
};

const ErrorReasonSchema = Schema.NonEmptyString;

export const CloudTaskErrorSchema = Schema.Union([
  Schema.TaggedStruct("CloudTaskNotFound", { sessionId: SessionIdSchema }),
  Schema.TaggedStruct("CloudTaskUnauthorized", { reason: ErrorReasonSchema }),
  Schema.TaggedStruct("CloudTaskRejected", { reason: ErrorReasonSchema }),
  Schema.TaggedStruct("CloudTaskTerminal", {
    sessionId: SessionIdSchema,
    state: TerminalSessionStateSchema,
  }),
  Schema.TaggedStruct("CloudTaskUnavailable", { reason: ErrorReasonSchema }),
]);
export type CloudTaskError = typeof CloudTaskErrorSchema.Type;

export const ProjectMemoryErrorSchema = Schema.Union([
  Schema.TaggedStruct("MemoryRevisionUnavailable", {
    expectedRevision: Schema.Natural,
  }),
  Schema.TaggedStruct("MemoryRevisionStale", {
    expectedRevision: Schema.Natural,
    observedRevision: Schema.Natural,
  }),
  Schema.TaggedStruct("MemoryProposalNotFound", {
    proposalId: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("MemoryUnauthorized", { reason: ErrorReasonSchema }),
  Schema.TaggedStruct("MemoryUnavailable", { reason: ErrorReasonSchema }),
]);
export type ProjectMemoryError = typeof ProjectMemoryErrorSchema.Type;

export const RepositoryPublisherErrorSchema = Schema.Union([
  Schema.TaggedStruct("RepositoryGrantInvalid", {
    grantId: Schema.NonEmptyString,
    reason: ErrorReasonSchema,
  }),
  Schema.TaggedStruct("RepositoryGrantExpired", {
    grantId: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("RepositoryCommitInvalid", { reason: ErrorReasonSchema }),
  Schema.TaggedStruct("RepositoryScopeViolation", {
    path: ErrorReasonSchema,
  }),
  Schema.TaggedStruct("RepositoryRefConflict", { reason: ErrorReasonSchema }),
  Schema.TaggedStruct("RepositoryUnavailable", { reason: ErrorReasonSchema }),
]);
export type RepositoryPublisherError = typeof RepositoryPublisherErrorSchema.Type;

export const DependencyCacheErrorSchema = Schema.Union([
  Schema.TaggedStruct("DependencyCacheKeyMismatch", {
    expected: Sha256DigestSchema,
    observed: Sha256DigestSchema,
  }),
  Schema.TaggedStruct("DependencyCachePayloadMismatch", {
    expected: Sha256DigestSchema,
    observed: Sha256DigestSchema,
  }),
  Schema.TaggedStruct("DependencyCacheMissing", {
    cacheKey: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("DependencyCacheUnavailable", { reason: ErrorReasonSchema }),
]);
export type DependencyCacheError = typeof DependencyCacheErrorSchema.Type;

export const ProfileRegistryErrorSchema = Schema.Union([
  Schema.TaggedStruct("ProfileNotFound", {
    profileId: ProfileIdSchema,
    profileRevision: ProfileRevisionSchema,
  }),
  Schema.TaggedStruct("ProfileDigestMismatch", {
    expected: Sha256DigestSchema,
    observed: Sha256DigestSchema,
  }),
  Schema.TaggedStruct("ProfileRegistryUnavailable", { reason: ErrorReasonSchema }),
]);
export type ProfileRegistryError = typeof ProfileRegistryErrorSchema.Type;

export interface CloudTaskClient {
  readonly spawn: (
    sessionId: SessionId,
    task: CloudTask,
  ) => Effect.Effect<SessionAdmission, CloudTaskError>;
  readonly send: (
    sessionId: SessionId,
    messageId: MessageId,
    message: Json,
  ) => Effect.Effect<AcceptedCursor, CloudTaskError>;
  readonly observe: (
    sessionId: SessionId,
    afterCursor: number,
  ) => Effect.Effect<ReadonlyArray<SessionObservation>, CloudTaskError>;
  readonly cancel: (
    sessionId: SessionId,
    reason: string,
  ) => Effect.Effect<SessionObservation, CloudTaskError>;
  readonly result: (sessionId: SessionId) => Effect.Effect<SessionResult, CloudTaskError>;
}
export const CloudTaskClient = Context.Service<CloudTaskClient>("work-engine/CloudTaskClient");

export interface ProjectMemory {
  readonly readContext: (
    atRevision: MemoryRevision,
    query: string,
  ) => Effect.Effect<ReadonlyArray<ProjectMemoryFact>, ProjectMemoryError>;
  readonly proposeMemory: (
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: ProjectMemoryProvenance,
  ) => Effect.Effect<MemoryProposalId, ProjectMemoryError>;
  readonly acceptMemory: (
    proposalId: MemoryProposalId,
    expectedRevision: MemoryRevision,
  ) => Effect.Effect<MemoryRevision, ProjectMemoryError>;
}
export const ProjectMemory = Context.Service<ProjectMemory>("work-engine/ProjectMemory");

export interface RepositoryPublisher {
  readonly checkout: (
    sessionGrant: RepositoryGrant,
    baseOrCheckpointCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<VerifiedWorkspace, RepositoryPublisherError>;
  readonly checkpoint: (
    sessionGrant: RepositoryGrant,
    commit: CloudTask["baseCommit"],
    expectedRemoteCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<CheckpointReceipt, RepositoryPublisherError>;
  readonly publishCandidate: (
    sessionGrant: RepositoryGrant,
    candidateCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<CandidateReceipt, RepositoryPublisherError>;
}
export const RepositoryPublisher = Context.Service<RepositoryPublisher>(
  "work-engine/RepositoryPublisher",
);

export type DependencyCacheExpectation = Pick<
  DependencyCacheManifest,
  "runtimeDigest" | "platformDigest" | "imageDigest" | "repositoryDigest" | "lockfileDigest"
>;

export interface DependencyCache {
  readonly restore: (
    manifest: DependencyCacheManifest,
    expectation: DependencyCacheExpectation,
  ) => Effect.Effect<DependencyCacheRestore, DependencyCacheError>;
}
export const DependencyCache = Context.Service<DependencyCache>("work-engine/DependencyCache");

export interface ProfileRegistry {
  readonly resolve: (
    profileId: ProfileId,
    profileRevision: ProfileRevision,
    profileDigest: Profile["profileDigest"],
  ) => Effect.Effect<Profile, ProfileRegistryError>;
}
export const ProfileRegistry = Context.Service<ProfileRegistry>("work-engine/ProfileRegistry");

export const decodeCloudTaskError = (input: unknown): CloudTaskError =>
  decodeUnknownStrict(CloudTaskErrorSchema, input);
export const decodeProjectMemoryError = (input: unknown): ProjectMemoryError =>
  decodeUnknownStrict(ProjectMemoryErrorSchema, input);
export const decodeRepositoryPublisherError = (input: unknown): RepositoryPublisherError =>
  decodeUnknownStrict(RepositoryPublisherErrorSchema, input);
export const decodeDependencyCacheError = (input: unknown): DependencyCacheError =>
  decodeUnknownStrict(DependencyCacheErrorSchema, input);
export const decodeProfileRegistryError = (input: unknown): ProfileRegistryError =>
  decodeUnknownStrict(ProfileRegistryErrorSchema, input);

export {
  AcceptedCursorSchema,
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CloudTaskSchema,
  DependencyCacheManifestSchema,
  DependencyCacheRestoreSchema,
  ProfileSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProvenanceSchema,
  RepositoryGrantSchema,
  SessionAdmissionSchema,
  SessionObservationSchema,
  SessionResultSchema,
  VerifiedWorkspaceSchema,
};

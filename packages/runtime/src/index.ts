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
  GrantIdSchema,
  MemoryProposalIdSchema,
  MemoryRevisionSchema,
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
  type TerminalSessionState,
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
  TerminalSessionState,
  VerifiedWorkspace,
};

const ErrorReasonSchema = Schema.NonEmptyString;

export class CloudTaskNotFound extends Schema.TaggedError<CloudTaskNotFound>()(
  "CloudTaskNotFound",
  { sessionId: SessionIdSchema },
) {}

export class CloudTaskUnauthorized extends Schema.TaggedError<CloudTaskUnauthorized>()(
  "CloudTaskUnauthorized",
  { reason: ErrorReasonSchema },
) {}

export class CloudTaskRejected extends Schema.TaggedError<CloudTaskRejected>()(
  "CloudTaskRejected",
  { reason: ErrorReasonSchema },
) {}

export class CloudTaskTerminal extends Schema.TaggedError<CloudTaskTerminal>()(
  "CloudTaskTerminal",
  { sessionId: SessionIdSchema, state: TerminalSessionStateSchema },
) {}

export class CloudTaskUnavailable extends Schema.TaggedError<CloudTaskUnavailable>()(
  "CloudTaskUnavailable",
  { reason: ErrorReasonSchema },
) {}

export const CloudTaskErrorSchema = Schema.Union([
  CloudTaskNotFound,
  CloudTaskUnauthorized,
  CloudTaskRejected,
  CloudTaskTerminal,
  CloudTaskUnavailable,
]);
export type CloudTaskError = typeof CloudTaskErrorSchema.Type;

export class MemoryRevisionUnavailable extends Schema.TaggedError<MemoryRevisionUnavailable>()(
  "MemoryRevisionUnavailable",
  { expectedRevision: MemoryRevisionSchema },
) {}

export class MemoryRevisionStale extends Schema.TaggedError<MemoryRevisionStale>()(
  "MemoryRevisionStale",
  { expectedRevision: MemoryRevisionSchema, observedRevision: MemoryRevisionSchema },
) {}

export class MemoryProposalNotFound extends Schema.TaggedError<MemoryProposalNotFound>()(
  "MemoryProposalNotFound",
  { proposalId: MemoryProposalIdSchema },
) {}

export class MemoryUnauthorized extends Schema.TaggedError<MemoryUnauthorized>()(
  "MemoryUnauthorized",
  { reason: ErrorReasonSchema },
) {}

export class MemoryUnavailable extends Schema.TaggedError<MemoryUnavailable>()(
  "MemoryUnavailable",
  { reason: ErrorReasonSchema },
) {}

export const ProjectMemoryErrorSchema = Schema.Union([
  MemoryRevisionUnavailable,
  MemoryRevisionStale,
  MemoryProposalNotFound,
  MemoryUnauthorized,
  MemoryUnavailable,
]);
export type ProjectMemoryError = typeof ProjectMemoryErrorSchema.Type;

export class RepositoryGrantInvalid extends Schema.TaggedError<RepositoryGrantInvalid>()(
  "RepositoryGrantInvalid",
  { grantId: GrantIdSchema, reason: ErrorReasonSchema },
) {}

export class RepositoryGrantExpired extends Schema.TaggedError<RepositoryGrantExpired>()(
  "RepositoryGrantExpired",
  { grantId: GrantIdSchema },
) {}

export class RepositoryCommitInvalid extends Schema.TaggedError<RepositoryCommitInvalid>()(
  "RepositoryCommitInvalid",
  { reason: ErrorReasonSchema },
) {}

export class RepositoryScopeViolation extends Schema.TaggedError<RepositoryScopeViolation>()(
  "RepositoryScopeViolation",
  { path: ErrorReasonSchema },
) {}

export class RepositoryRefConflict extends Schema.TaggedError<RepositoryRefConflict>()(
  "RepositoryRefConflict",
  { reason: ErrorReasonSchema },
) {}

export class RepositoryUnavailable extends Schema.TaggedError<RepositoryUnavailable>()(
  "RepositoryUnavailable",
  { reason: ErrorReasonSchema },
) {}

export const RepositoryPublisherErrorSchema = Schema.Union([
  RepositoryGrantInvalid,
  RepositoryGrantExpired,
  RepositoryCommitInvalid,
  RepositoryScopeViolation,
  RepositoryRefConflict,
  RepositoryUnavailable,
]);
export type RepositoryPublisherError = typeof RepositoryPublisherErrorSchema.Type;

export class DependencyCacheKeyMismatch extends Schema.TaggedError<DependencyCacheKeyMismatch>()(
  "DependencyCacheKeyMismatch",
  { expected: Sha256DigestSchema, observed: Sha256DigestSchema },
) {}

export class DependencyCachePayloadMismatch extends Schema.TaggedError<DependencyCachePayloadMismatch>()(
  "DependencyCachePayloadMismatch",
  { expected: Sha256DigestSchema, observed: Sha256DigestSchema },
) {}

export class DependencyCacheMissing extends Schema.TaggedError<DependencyCacheMissing>()(
  "DependencyCacheMissing",
  { cacheKey: Schema.NonEmptyString },
) {}

export class DependencyCacheUnavailable extends Schema.TaggedError<DependencyCacheUnavailable>()(
  "DependencyCacheUnavailable",
  { reason: ErrorReasonSchema },
) {}

export const DependencyCacheErrorSchema = Schema.Union([
  DependencyCacheKeyMismatch,
  DependencyCachePayloadMismatch,
  DependencyCacheMissing,
  DependencyCacheUnavailable,
]);
export type DependencyCacheError = typeof DependencyCacheErrorSchema.Type;

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()("ProfileNotFound", {
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
}) {}

export class ProfileDigestMismatch extends Schema.TaggedError<ProfileDigestMismatch>()(
  "ProfileDigestMismatch",
  { expected: Sha256DigestSchema, observed: Sha256DigestSchema },
) {}

export class ProfileRegistryUnavailable extends Schema.TaggedError<ProfileRegistryUnavailable>()(
  "ProfileRegistryUnavailable",
  { reason: ErrorReasonSchema },
) {}

export const ProfileRegistryErrorSchema = Schema.Union([
  ProfileNotFound,
  ProfileDigestMismatch,
  ProfileRegistryUnavailable,
]);
export type ProfileRegistryError = typeof ProfileRegistryErrorSchema.Type;

export interface CloudTaskClient {
  readonly spawn: (
    sessionId: SessionId,
    task: CloudTask,
  ) => Effect.Effect<SessionAdmission, CloudTaskError, never>;
  readonly send: (
    sessionId: SessionId,
    messageId: MessageId,
    message: Json,
  ) => Effect.Effect<AcceptedCursor, CloudTaskError, never>;
  readonly observe: (
    sessionId: SessionId,
    afterCursor: number,
  ) => Effect.Effect<ReadonlyArray<SessionObservation>, CloudTaskError, never>;
  readonly cancel: (
    sessionId: SessionId,
    reason: string,
  ) => Effect.Effect<SessionObservation, CloudTaskError, never>;
  readonly result: (sessionId: SessionId) => Effect.Effect<SessionResult, CloudTaskError, never>;
}
export const CloudTaskClient = Context.Service<CloudTaskClient>("work-engine/CloudTaskClient");

export interface ProjectMemory {
  readonly readContext: (
    atRevision: MemoryRevision,
    query: string,
  ) => Effect.Effect<ReadonlyArray<ProjectMemoryFact>, ProjectMemoryError, never>;
  readonly proposeMemory: (
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: ProjectMemoryProvenance,
  ) => Effect.Effect<MemoryProposalId, ProjectMemoryError, never>;
  readonly acceptMemory: (
    proposalId: MemoryProposalId,
    expectedRevision: MemoryRevision,
  ) => Effect.Effect<MemoryRevision, ProjectMemoryError, never>;
}
export const ProjectMemory = Context.Service<ProjectMemory>("work-engine/ProjectMemory");

export interface RepositoryPublisher {
  readonly checkout: (
    sessionGrant: RepositoryGrant,
    baseOrCheckpointCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<VerifiedWorkspace, RepositoryPublisherError, never>;
  readonly checkpoint: (
    sessionGrant: RepositoryGrant,
    commit: CloudTask["baseCommit"],
    expectedRemoteCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<CheckpointReceipt, RepositoryPublisherError, never>;
  readonly publishCandidate: (
    sessionGrant: RepositoryGrant,
    candidateCommit: CloudTask["baseCommit"],
  ) => Effect.Effect<CandidateReceipt, RepositoryPublisherError, never>;
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
  ) => Effect.Effect<DependencyCacheRestore, DependencyCacheError, never>;
}
export const DependencyCache = Context.Service<DependencyCache>("work-engine/DependencyCache");

export interface ProfileRegistry {
  readonly resolve: (
    profileId: ProfileId,
    profileRevision: ProfileRevision,
    profileDigest: Profile["profileDigest"],
  ) => Effect.Effect<Profile, ProfileRegistryError, never>;
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

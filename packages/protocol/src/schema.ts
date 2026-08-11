import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { canonicalize } from "./canonical.ts";

import {
  CommitShaSchema,
  GrantIdSchema,
  MemoryProposalIdSchema,
  MemoryRevisionSchema,
  MessageIdSchema,
  NonEmptyStringSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProjectIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TaskIdSchema,
  TimestampSchema,
  type CommitSha,
  type GrantId,
  type MemoryProposalId,
  type MemoryRevision,
  type MessageId,
  type ProfileId,
  type ProfileRevision,
  type ProjectId,
  type SessionId,
  type Sha256Digest,
  type TaskId,
  type Timestamp,
} from "./identifiers.ts";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
const StringArraySchema = Schema.Array(NonEmptyStringSchema);

export {
  CommitShaSchema,
  GrantIdSchema,
  MemoryProposalIdSchema,
  MemoryRevisionSchema,
  MessageIdSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProjectIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TaskIdSchema,
  TimestampSchema,
};

export type {
  CommitSha,
  GrantId,
  MemoryProposalId,
  MemoryRevision,
  MessageId,
  ProfileId,
  ProfileRevision,
  ProjectId,
  SessionId,
  Sha256Digest,
  TaskId,
  Timestamp,
};

export const ProfileReferenceSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
});
export type ProfileReference = typeof ProfileReferenceSchema.Type;

export const ProfileRoleSchema = Schema.Literals(["orchestrator", "worker", "reviewer"] as const);
export type ProfileRole = typeof ProfileRoleSchema.Type;

export const ProfileSchema = Schema.TaggedStruct("Profile", {
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
  profileDigest: Sha256DigestSchema,
  role: ProfileRoleSchema,
  roleInstructions: NonEmptyStringSchema,
  modelPolicy: JsonRecordSchema,
  capabilities: StringArraySchema,
  skillRefs: Schema.Array(ProfileReferenceSchema),
  hookRefs: Schema.Array(ProfileReferenceSchema),
  sandboxPolicy: JsonRecordSchema,
  memoryCapabilities: StringArraySchema,
  repositoryCapabilities: StringArraySchema,
  executionBudget: JsonRecordSchema,
  evidenceBudget: JsonRecordSchema,
});
export type Profile = typeof ProfileSchema.Type;

export const PathPatternSchema = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/),
  Schema.makeFilter(
    (path) => !path.includes(String.fromCharCode(0)) || "path contains a null byte",
  ),
);
export type PathPattern = typeof PathPatternSchema.Type;

export const RepositoryIdentitySchema = Schema.Struct({
  owner: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
});
export type RepositoryIdentity = typeof RepositoryIdentitySchema.Type;

export const RepositoryCandidateVerificationSchema = Schema.Struct({
  descendedFromBase: Schema.Boolean,
  changedPaths: Schema.Array(PathPatternSchema),
  commitMetadata: JsonRecordSchema,
});
export type RepositoryCandidateVerification = typeof RepositoryCandidateVerificationSchema.Type;

export const RepositoryRefStateSchema = Schema.Struct({
  sha: optional(CommitShaSchema),
});
export type RepositoryRefState = typeof RepositoryRefStateSchema.Type;

export const CommitMetadataSchema = Schema.Struct({
  sha: CommitShaSchema,
  message: NonEmptyStringSchema,
  author: optional(NonEmptyStringSchema),
  authoredAt: optional(TimestampSchema),
});
export type CommitMetadata = typeof CommitMetadataSchema.Type;

export const CommandObservationSchema = Schema.Struct({
  command: NonEmptyStringSchema,
  exitStatus: Schema.Int,
  outputDigest: optional(Sha256DigestSchema),
  outputReference: optional(NonEmptyStringSchema),
  startedAt: optional(TimestampSchema),
  completedAt: optional(TimestampSchema),
});
export type CommandObservation = typeof CommandObservationSchema.Type;

export const ArtifactDigestSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
});
export type ArtifactDigest = typeof ArtifactDigestSchema.Type;

export const CloudTaskSchema = Schema.TaggedStruct("CloudTask", {
  taskId: TaskIdSchema,
  sessionId: SessionIdSchema,
  projectId: ProjectIdSchema,
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
  profileDigest: Sha256DigestSchema,
  baseCommit: CommitShaSchema,
  objective: NonEmptyStringSchema,
  writablePaths: Schema.Array(PathPatternSchema),
  requiredCommands: StringArraySchema,
  deadline: TimestampSchema,
  outputLimitBytes: Schema.Natural,
  memoryRevision: optional(MemoryRevisionSchema),
});
export type CloudTask = typeof CloudTaskSchema.Type;

export const SessionPendingStateSchema = Schema.TaggedStruct("Pending", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
});
export type SessionPendingState = typeof SessionPendingStateSchema.Type;

export const SessionRunningStateSchema = Schema.TaggedStruct("Running", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  startedAt: TimestampSchema,
});
export type SessionRunningState = typeof SessionRunningStateSchema.Type;

export const SessionCheckpointedStateSchema = Schema.TaggedStruct("Checkpointed", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  commit: CommitShaSchema,
  acknowledgedAt: TimestampSchema,
});
export type SessionCheckpointedState = typeof SessionCheckpointedStateSchema.Type;

export const SessionCompletedStateSchema = Schema.TaggedStruct("Completed", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  completedAt: TimestampSchema,
});
export type SessionCompletedState = typeof SessionCompletedStateSchema.Type;

export const SessionFailedStateSchema = Schema.TaggedStruct("Failed", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  failedAt: TimestampSchema,
  reason: NonEmptyStringSchema,
});
export type SessionFailedState = typeof SessionFailedStateSchema.Type;

export const SessionCancelledStateSchema = Schema.TaggedStruct("Cancelled", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  cancelledAt: TimestampSchema,
  reason: NonEmptyStringSchema,
});
export type SessionCancelledState = typeof SessionCancelledStateSchema.Type;

export const SessionExpiredStateSchema = Schema.TaggedStruct("Expired", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  expiredAt: TimestampSchema,
  reason: NonEmptyStringSchema,
});
export type SessionExpiredState = typeof SessionExpiredStateSchema.Type;

export const SessionStateSchema = Schema.Union([
  SessionPendingStateSchema,
  SessionRunningStateSchema,
  SessionCheckpointedStateSchema,
  SessionCompletedStateSchema,
  SessionFailedStateSchema,
  SessionCancelledStateSchema,
  SessionExpiredStateSchema,
]);
export type SessionState = typeof SessionStateSchema.Type;

export const TerminalSessionStateSchema = Schema.Union([
  SessionCompletedStateSchema,
  SessionFailedStateSchema,
  SessionCancelledStateSchema,
  SessionExpiredStateSchema,
]);
export type TerminalSessionState = typeof TerminalSessionStateSchema.Type;

export const SessionAdmissionSchema = Schema.TaggedStruct("SessionAdmission", {
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema,
  projectId: ProjectIdSchema,
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
  profileDigest: Sha256DigestSchema,
  baseCommit: CommitShaSchema,
  acceptedCursor: Schema.Natural,
  admittedAt: TimestampSchema,
  memoryRevision: optional(MemoryRevisionSchema),
  grantId: optional(GrantIdSchema),
  generatedClass: optional(NonEmptyStringSchema),
  binding: optional(NonEmptyStringSchema),
  migrationTag: optional(NonEmptyStringSchema),
  configurationDigest: optional(Sha256DigestSchema),
});
export type SessionAdmission = typeof SessionAdmissionSchema.Type;

export const SessionObservationSchema = Schema.TaggedStruct("SessionObservation", {
  sessionId: SessionIdSchema,
  cursor: Schema.Natural,
  observedAt: TimestampSchema,
  state: SessionStateSchema,
  messageId: optional(MessageIdSchema),
  message: optional(Schema.Json),
  event: optional(Schema.Json),
});
export type SessionObservation = typeof SessionObservationSchema.Type;

export const ObservationCursorSchema = Schema.Natural;
export type ObservationCursor = typeof ObservationCursorSchema.Type;
export const AcceptedCursorSchema = ObservationCursorSchema;
export type AcceptedCursor = ObservationCursor;

export const SessionObservationsSchema = Schema.TaggedStruct("SessionObservations", {
  sessionId: SessionIdSchema,
  afterCursor: Schema.Natural,
  observations: Schema.Array(SessionObservationSchema),
  nextCursor: Schema.Natural,
});
export type SessionObservations = typeof SessionObservationsSchema.Type;

export const SessionCompletedResultSchema = Schema.TaggedStruct("CompletedResult", {
  sessionId: SessionIdSchema,
  projectId: ProjectIdSchema,
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
  profileDigest: Sha256DigestSchema,
  repository: RepositoryIdentitySchema,
  baseCommit: CommitShaSchema,
  candidateCommit: CommitShaSchema,
  candidateBranch: NonEmptyStringSchema,
  candidateUrl: NonEmptyStringSchema,
  changedPaths: Schema.Array(PathPatternSchema),
  commitMetadata: CommitMetadataSchema,
  commands: Schema.Array(CommandObservationSchema),
  artifacts: Schema.Array(ArtifactDigestSchema),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  publishedAt: TimestampSchema,
  unresolvedBlockers: StringArraySchema,
});
export type SessionCompletedResult = typeof SessionCompletedResultSchema.Type;
export type SessionResultPayload = SessionCompletedResult;

export const SessionPendingResultSchema = Schema.TaggedStruct("Pending", {
  sessionId: SessionIdSchema,
});
export type SessionPendingResult = typeof SessionPendingResultSchema.Type;

export const SessionFailedResultSchema = Schema.TaggedStruct("Failed", {
  sessionId: SessionIdSchema,
  reason: NonEmptyStringSchema,
  completedAt: optional(TimestampSchema),
});
export type SessionFailedResult = typeof SessionFailedResultSchema.Type;

export const SessionCancelledResultSchema = Schema.TaggedStruct("Cancelled", {
  sessionId: SessionIdSchema,
  reason: NonEmptyStringSchema,
  completedAt: optional(TimestampSchema),
});
export type SessionCancelledResult = typeof SessionCancelledResultSchema.Type;

export const SessionCompletedResultEnvelopeSchema = Schema.TaggedStruct("Completed", {
  sessionId: SessionIdSchema,
  result: SessionCompletedResultSchema,
});
export type SessionCompletedResultEnvelope = typeof SessionCompletedResultEnvelopeSchema.Type;

export const SessionResultSchema = Schema.Union([
  SessionPendingResultSchema,
  SessionFailedResultSchema,
  SessionCancelledResultSchema,
  SessionCompletedResultEnvelopeSchema,
]);
export type SessionResult = typeof SessionResultSchema.Type;

export const SpawnCloudTaskRequestSchema = Schema.TaggedStruct("Spawn", {
  sessionId: SessionIdSchema,
  task: CloudTaskSchema,
}).check(
  Schema.makeFilter(
    (request) =>
      request.sessionId === request.task.sessionId ||
      "spawn route sessionId must match the CloudTask sessionId",
  ),
);
export type SpawnCloudTaskRequest = typeof SpawnCloudTaskRequestSchema.Type;
export const CloudTaskSpawnRequestSchema = SpawnCloudTaskRequestSchema;
export type CloudTaskSpawnRequest = SpawnCloudTaskRequest;

export const SendCloudTaskRequestSchema = Schema.TaggedStruct("Send", {
  sessionId: SessionIdSchema,
  messageId: MessageIdSchema,
  message: Schema.Json,
});
export type SendCloudTaskRequest = typeof SendCloudTaskRequestSchema.Type;
export const CloudTaskSendRequestSchema = SendCloudTaskRequestSchema;
export type CloudTaskSendRequest = SendCloudTaskRequest;

export const ObserveCloudTaskRequestSchema = Schema.TaggedStruct("Observe", {
  sessionId: SessionIdSchema,
  afterCursor: Schema.Natural,
});
export type ObserveCloudTaskRequest = typeof ObserveCloudTaskRequestSchema.Type;
export const CloudTaskObserveRequestSchema = ObserveCloudTaskRequestSchema;
export type CloudTaskObserveRequest = ObserveCloudTaskRequest;

export const CancelCloudTaskRequestSchema = Schema.TaggedStruct("Cancel", {
  sessionId: SessionIdSchema,
  reason: NonEmptyStringSchema,
});
export type CancelCloudTaskRequest = typeof CancelCloudTaskRequestSchema.Type;
export const CloudTaskCancelRequestSchema = CancelCloudTaskRequestSchema;
export type CloudTaskCancelRequest = CancelCloudTaskRequest;

export const ResultCloudTaskRequestSchema = Schema.TaggedStruct("Result", {
  sessionId: SessionIdSchema,
});
export type ResultCloudTaskRequest = typeof ResultCloudTaskRequestSchema.Type;
export const CloudTaskResultRequestSchema = ResultCloudTaskRequestSchema;
export type CloudTaskResultRequest = ResultCloudTaskRequest;

export const CloudTaskRequestSchema = Schema.Union([
  SpawnCloudTaskRequestSchema,
  SendCloudTaskRequestSchema,
  ObserveCloudTaskRequestSchema,
  CancelCloudTaskRequestSchema,
  ResultCloudTaskRequestSchema,
]);
export type CloudTaskRequest = typeof CloudTaskRequestSchema.Type;

export const SpawnCloudTaskResponseSchema = Schema.TaggedStruct("Spawned", {
  admission: SessionAdmissionSchema,
});
export type SpawnCloudTaskResponse = typeof SpawnCloudTaskResponseSchema.Type;
export const CloudTaskSpawnResponseSchema = SpawnCloudTaskResponseSchema;
export type CloudTaskSpawnResponse = SpawnCloudTaskResponse;

export const SendCloudTaskResponseSchema = Schema.TaggedStruct("Accepted", {
  acceptedCursor: AcceptedCursorSchema,
});
export type SendCloudTaskResponse = typeof SendCloudTaskResponseSchema.Type;
export const CloudTaskSendResponseSchema = SendCloudTaskResponseSchema;
export type CloudTaskSendResponse = SendCloudTaskResponse;

export const ObserveCloudTaskResponseSchema = Schema.TaggedStruct("Observed", {
  observations: Schema.Array(SessionObservationSchema),
});
export type ObserveCloudTaskResponse = typeof ObserveCloudTaskResponseSchema.Type;
export const CloudTaskObserveResponseSchema = ObserveCloudTaskResponseSchema;
export type CloudTaskObserveResponse = ObserveCloudTaskResponse;

export const CancelCloudTaskResponseSchema = Schema.TaggedStruct("Cancelled", {
  observation: SessionObservationSchema,
});
export type CancelCloudTaskResponse = typeof CancelCloudTaskResponseSchema.Type;
export const CloudTaskCancelResponseSchema = CancelCloudTaskResponseSchema;
export type CloudTaskCancelResponse = CancelCloudTaskResponse;

export const ResultCloudTaskResponseSchema = Schema.TaggedStruct("Result", {
  result: SessionResultSchema,
});
export type ResultCloudTaskResponse = typeof ResultCloudTaskResponseSchema.Type;
export const CloudTaskResultResponseSchema = ResultCloudTaskResponseSchema;
export type CloudTaskResultResponse = ResultCloudTaskResponse;

export const CloudTaskResponseSchema = Schema.Union([
  SpawnCloudTaskResponseSchema,
  SendCloudTaskResponseSchema,
  ObserveCloudTaskResponseSchema,
  CancelCloudTaskResponseSchema,
  ResultCloudTaskResponseSchema,
]);
export type CloudTaskResponse = typeof CloudTaskResponseSchema.Type;

export const ProjectMemoryProvenanceSchema = Schema.TaggedStruct("ProjectMemoryProvenance", {
  source: NonEmptyStringSchema,
  observedAt: TimestampSchema,
  artifactDigests: optional(Schema.Array(Sha256DigestSchema)),
});
export type ProjectMemoryProvenance = typeof ProjectMemoryProvenanceSchema.Type;
export type MemoryProvenance = ProjectMemoryProvenance;

export const ProjectMemoryFactSchema = Schema.TaggedStruct("ProjectMemoryFact", {
  factId: NonEmptyStringSchema,
  claim: NonEmptyStringSchema,
  provenance: ProjectMemoryProvenanceSchema,
  acceptedAt: optional(TimestampSchema),
});
export type ProjectMemoryFact = typeof ProjectMemoryFactSchema.Type;
export const MemoryFactSchema = ProjectMemoryFactSchema;
export type MemoryFact = ProjectMemoryFact;

export class ProjectMemoryProposalModel extends Model.Class<ProjectMemoryProposalModel>(
  "ProjectMemoryProposal",
)({
  _tag: Schema.Literal("ProjectMemoryProposal"),
  proposalId: MemoryProposalIdSchema,
  expectedRevision: MemoryRevisionSchema,
  claim: NonEmptyStringSchema,
  provenance: ProjectMemoryProvenanceSchema,
  proposedAt: TimestampSchema,
  sessionId: Model.Sensitive(SessionIdSchema),
}) {}
export const ProjectMemoryProposalSchema = ProjectMemoryProposalModel.json;
export type ProjectMemoryProposal = typeof ProjectMemoryProposalSchema.Type;
export const MemoryProposalSchema = ProjectMemoryProposalSchema;
export type MemoryProposal = ProjectMemoryProposal;
export const ProjectMemoryReadRequestSchema = Schema.Struct({
  atRevision: MemoryRevisionSchema,
  query: Schema.String,
});
export type ProjectMemoryReadRequest = typeof ProjectMemoryReadRequestSchema.Type;

export const ProjectMemoryProposeRequestSchema = Schema.Struct({
  expectedRevision: MemoryRevisionSchema,
  claim: NonEmptyStringSchema,
  provenance: ProjectMemoryProvenanceSchema,
});
export type ProjectMemoryProposeRequest = typeof ProjectMemoryProposeRequestSchema.Type;

export const ProjectMemoryAcceptRequestSchema = Schema.Struct({
  proposalId: MemoryProposalIdSchema,
  expectedRevision: MemoryRevisionSchema,
});
export type ProjectMemoryAcceptRequest = typeof ProjectMemoryAcceptRequestSchema.Type;

export const ProjectMemoryReadResponseSchema = Schema.TaggedStruct("ProjectMemoryRead", {
  facts: Schema.Array(ProjectMemoryFactSchema),
});
export type ProjectMemoryReadResponse = typeof ProjectMemoryReadResponseSchema.Type;

export const ProjectMemoryRevisionSchema = Schema.TaggedStruct("ProjectMemoryRevision", {
  projectId: ProjectIdSchema,
  memoryRevision: MemoryRevisionSchema,
  previousRevision: optional(MemoryRevisionSchema),
  facts: Schema.Array(ProjectMemoryFactSchema),
  acceptedProposalId: optional(MemoryProposalIdSchema),
  acceptedAt: TimestampSchema,
}).check(
  Schema.makeFilter(
    (revision) =>
      revision.previousRevision === undefined ||
      revision.memoryRevision > revision.previousRevision ||
      "memoryRevision must advance beyond previousRevision",
  ),
);
export type ProjectMemoryRevision = typeof ProjectMemoryRevisionSchema.Type;
export const MemoryRevisionRecordSchema = ProjectMemoryRevisionSchema;
export type MemoryRevisionRecord = ProjectMemoryRevision;

export const RepositoryRefSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?!refs\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/)),
);
export type RepositoryRef = typeof RepositoryRefSchema.Type;

export const RepositoryGrantSchema = Schema.TaggedStruct("RepositoryGrant", {
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  projectId: ProjectIdSchema,
  repository: RepositoryIdentitySchema,
  baseCommit: CommitShaSchema,
  writablePaths: Schema.Array(PathPatternSchema),
  wipRef: RepositoryRefSchema,
  candidateRef: RepositoryRefSchema,
  expiresAt: TimestampSchema,
  issuedAt: TimestampSchema,
}).check(
  Schema.makeFilter(
    (grant) => grant.wipRef !== grant.candidateRef || "wipRef and candidateRef must differ",
  ),
);
export type RepositoryGrant = typeof RepositoryGrantSchema.Type;

export const VerifiedWorkspaceSchema = Schema.TaggedStruct("VerifiedWorkspace", {
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  commit: CommitShaSchema,
  workspaceRoot: NonEmptyStringSchema,
  verifiedAt: TimestampSchema,
});
export type VerifiedWorkspace = typeof VerifiedWorkspaceSchema.Type;

export const CheckpointReceiptSchema = Schema.TaggedStruct("CheckpointReceipt", {
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  commit: CommitShaSchema,
  wipRef: RepositoryRefSchema,
  expectedRemoteCommit: CommitShaSchema,
  acknowledgedAt: TimestampSchema,
});
export type CheckpointReceipt = typeof CheckpointReceiptSchema.Type;
export const RepositoryCheckpointReceiptSchema = CheckpointReceiptSchema;
export type RepositoryCheckpointReceipt = CheckpointReceipt;

export const CandidateReceiptSchema = Schema.TaggedStruct("CandidateReceipt", {
  grantId: GrantIdSchema,
  sessionId: SessionIdSchema,
  candidateCommit: CommitShaSchema,
  candidateRef: RepositoryRefSchema,
  candidateBranch: NonEmptyStringSchema,
  candidateUrl: NonEmptyStringSchema,
  publishedAt: TimestampSchema,
});
export type CandidateReceipt = typeof CandidateReceiptSchema.Type;
export const RepositoryCandidateReceiptSchema = CandidateReceiptSchema;
export type RepositoryCandidateReceipt = CandidateReceipt;

export const DependencyCacheManifestSchema = Schema.TaggedStruct("DependencyCacheManifest", {
  cacheKey: NonEmptyStringSchema,
  runtimeDigest: Sha256DigestSchema,
  platformDigest: Sha256DigestSchema,
  imageDigest: Sha256DigestSchema,
  repositoryDigest: Sha256DigestSchema,
  lockfileDigest: Sha256DigestSchema,
  payloadDigest: Sha256DigestSchema,
  createdAt: TimestampSchema,
});
export type DependencyCacheManifest = typeof DependencyCacheManifestSchema.Type;

export const DependencyCacheRestoreSchema = Schema.TaggedStruct("DependencyCacheRestore", {
  manifest: DependencyCacheManifestSchema,
  restored: Schema.Boolean,
  payloadDigest: Sha256DigestSchema,
  verifiedAt: TimestampSchema,
  workspacePath: NonEmptyStringSchema,
});
export type DependencyCacheRestore = typeof DependencyCacheRestoreSchema.Type;

export const TrialArmSchema = Schema.Struct({
  model: NonEmptyStringSchema,
  budget: Schema.Json,
  baseCommit: CommitShaSchema,
  cacheManifest: DependencyCacheManifestSchema,
  verificationCommands: StringArraySchema,
  capabilities: StringArraySchema,
});
export type TrialArm = typeof TrialArmSchema.Type;

const equivalentCacheManifest = Schema.toEquivalence(DependencyCacheManifestSchema);
const equivalentVerificationCommands = Schema.toEquivalence(StringArraySchema);

export const TrialManifestSchema = Schema.TaggedStruct("TrialManifest", {
  trialId: NonEmptyStringSchema,
  taskId: TaskIdSchema,
  projectId: ProjectIdSchema,
  objective: NonEmptyStringSchema,
  writablePaths: Schema.Array(PathPatternSchema),
  baseline: TrialArmSchema,
  treatment: TrialArmSchema,
}).check(
  Schema.makeFilter((manifest) => {
    const { baseline, treatment } = manifest;
    const sameBudget = canonicalize(baseline.budget) === canonicalize(treatment.budget);
    const sameCache = equivalentCacheManifest(baseline.cacheManifest, treatment.cacheManifest);
    const sameCommands = equivalentVerificationCommands(
      baseline.verificationCommands,
      treatment.verificationCommands,
    );
    return (
      (baseline.model === treatment.model &&
        baseline.baseCommit === treatment.baseCommit &&
        sameBudget &&
        sameCache &&
        sameCommands) ||
      "paired trial arms must share model, budget, base commit, cache, and verification commands"
    );
  }),
);
export type TrialManifest = typeof TrialManifestSchema.Type;

export const TrialArmNameSchema = Schema.Literals(["baseline", "treatment"] as const);
export type TrialArmName = typeof TrialArmNameSchema.Type;

export const TrialRecordSchema = Schema.TaggedStruct("TrialRecord", {
  trialId: NonEmptyStringSchema,
  arm: TrialArmNameSchema,
  runId: NonEmptyStringSchema,
  sessionId: SessionIdSchema,
  result: SessionResultSchema,
  measures: JsonRecordSchema,
  recordedAt: TimestampSchema,
});
export type TrialRecord = typeof TrialRecordSchema.Type;

export const ProductDecisionSchema = Schema.Literals(["expand", "collapse", "reject"] as const);
export type ProductDecision = typeof ProductDecisionSchema.Type;

export const ProductDecisionReportSchema = Schema.TaggedStruct("ProductDecisionReport", {
  decision: ProductDecisionSchema,
  reasons: StringArraySchema,
  thresholdResults: JsonRecordSchema,
  records: Schema.Array(TrialRecordSchema),
});
export type ProductDecisionReport = typeof ProductDecisionReportSchema.Type;

export const decodeUnknownStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

export const encodeUnknownStrict = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  input: S["Type"],
): unknown => Schema.encodeSync(schema)(input);

export const decodeCloudTaskRequest = (input: unknown): CloudTaskRequest =>
  decodeUnknownStrict(CloudTaskRequestSchema, input);
export const decodeCloudTaskResponse = (input: unknown): CloudTaskResponse =>
  decodeUnknownStrict(CloudTaskResponseSchema, input);
export const decodeProfile = (input: unknown): Profile => decodeUnknownStrict(ProfileSchema, input);
export const decodeCloudTask = (input: unknown): CloudTask =>
  decodeUnknownStrict(CloudTaskSchema, input);
export const decodeSessionAdmission = (input: unknown): SessionAdmission =>
  decodeUnknownStrict(SessionAdmissionSchema, input);
export const decodeSessionObservation = (input: unknown): SessionObservation =>
  decodeUnknownStrict(SessionObservationSchema, input);
export const decodeSessionResult = (input: unknown): SessionResult =>
  decodeUnknownStrict(SessionResultSchema, input);
export const decodeRepositoryGrant = (input: unknown): RepositoryGrant =>
  decodeUnknownStrict(RepositoryGrantSchema, input);
export const decodeTrialManifest = (input: unknown): TrialManifest =>
  decodeUnknownStrict(TrialManifestSchema, input);

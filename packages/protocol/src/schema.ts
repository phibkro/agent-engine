import { Schema } from "effect";
import {
  ActorIdSchema,
  AgentProfileIdSchema,
  AttemptNumberSchema,
  CommandIdSchema,
  ContentRevisionSchema,
  EffectIdSchema,
  EventRevisionSchema,
  EvidenceIdSchema,
  GateIdSchema,
  GrantIdSchema,
  HandoffIdSchema,
  MergeIdSchema,
  PolicyIdSchema,
  ProposalIdSchema,
  ProjectIdSchema,
  ResourceIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  WorkIdSchema,
  WorkProcessIdSchema,
  WorkspaceViewIdSchema,
  type ActorId,
  type AgentProfileId,
  type AttemptNumber,
  type CommandId,
  type ContentRevision,
  type EffectId,
  type EventRevision,
  type EvidenceId,
  type GateId,
  type GrantId,
  type HandoffId,
  type MergeId,
  type PolicyId,
  type ProposalId,
  type ProjectId,
  type ResourceId,
  type SessionId,
  type Sha256Digest,
  type Timestamp,
  type WorkId,
  type WorkProcessId,
  type WorkspaceViewId,
} from "./identifiers.ts";

export {
  ActorIdSchema,
  AgentProfileIdSchema,
  AttemptNumberSchema,
  CommandIdSchema,
  ContentRevisionSchema,
  EffectIdSchema,
  EventRevisionSchema,
  EvidenceIdSchema,
  GateIdSchema,
  GrantIdSchema,
  HandoffIdSchema,
  MergeIdSchema,
  PolicyIdSchema,
  ProposalIdSchema,
  ProjectIdSchema,
  ResourceIdSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  WorkIdSchema,
  WorkProcessIdSchema,
  WorkspaceViewIdSchema,
};

export type {
  ActorId,
  AgentProfileId,
  AttemptNumber,
  CommandId,
  ContentRevision,
  EffectId,
  EventRevision,
  EvidenceId,
  GateId,
  GrantId,
  HandoffId,
  MergeId,
  PolicyId,
  ProposalId,
  ProjectId,
  ResourceId,
  SessionId,
  Sha256Digest,
  Timestamp,
  WorkId,
  WorkProcessId,
  WorkspaceViewId,
};

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
const NonEmptyStringSchema = Schema.NonEmptyString;

export const ActorKindSchema = Schema.Literals([
  "operator",
  "project_manager",
  "worker_session",
  "session_workflow",
  "session_host",
  "system",
] as const);
export type ActorKind = typeof ActorKindSchema.Type;

export const AuthenticatedActorSchema = Schema.TaggedStruct("AuthenticatedActor", {
  actorId: ActorIdSchema,
  kind: ActorKindSchema,
  presentedGrants: Schema.Array(GrantIdSchema),
});
export type AuthenticatedActor = typeof AuthenticatedActorSchema.Type;

export const CapabilitySchema = Schema.Literals([
  "project.create",
  "project.read",
  "work.submit",
  "work.read",
  "manager.open",
  "worker.start",
  "session.cancel",
  "session.cancel.execute",
  "session.started",
  "session.terminal",
  "handoff.record",
  "workspace.lease",
  "workspace.heartbeat",
  "workspace.read",
  "workspace.write",
  "candidate.finalize",
  "artifact.put",
  "evidence.record",
  "evidence.read",
  "proposal.submit",
  "proposal.read",
  "proposal.approve",
  "proposal.reject",
  "proposal.merge",
] as const);
export type Capability = typeof CapabilitySchema.Type;

export const GrantScopeSchema = Schema.Struct({
  projectId: optional(ProjectIdSchema),
  workId: optional(WorkIdSchema),
  sessionId: optional(SessionIdSchema),
  proposalId: optional(ProposalIdSchema),
});
export type GrantScope = typeof GrantScopeSchema.Type;

export const GrantSchema = Schema.TaggedStruct("Grant", {
  grantId: GrantIdSchema,
  subjectActorId: ActorIdSchema,
  capability: CapabilitySchema,
  scope: GrantScopeSchema,
  validFrom: TimestampSchema,
  validUntil: TimestampSchema,
  grantingAuthority: ActorIdSchema,
});
export type Grant = typeof GrantSchema.Type;

export const GateKeySchema = Schema.Literals([
  "gat_session_completed",
  "gat_candidate_present",
  "gat_scope_valid",
  "gat_check_passed",
  "gat_human_approved",
] as const);
export type GateKey = typeof GateKeySchema.Type;

export const PolicySchema = Schema.TaggedStruct("Policy", {
  policyId: PolicyIdSchema,
  revision: EventRevisionSchema,
  requiredGates: Schema.Array(GateKeySchema),
  mergeCapability: Schema.Literal("proposal.merge"),
  maxAttempts: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
});
export type Policy = typeof PolicySchema.Type;

export const WorkKindSchema = NonEmptyStringSchema;
export type WorkKind = typeof WorkKindSchema.Type;

export const WorkSchema = Schema.TaggedStruct("Work", {
  workId: WorkIdSchema,
  projectId: ProjectIdSchema,
  workProcessId: WorkProcessIdSchema,
  objective: NonEmptyStringSchema,
  kind: WorkKindSchema,
  writableScope: Schema.Array(NonEmptyStringSchema),
  requiredCheck: NonEmptyStringSchema,
  title: optional(NonEmptyStringSchema),
  lifecycle: Schema.Literals(["submitted", "active", "completed", "rejected"] as const),
});
export type Work = typeof WorkSchema.Type;

export const AgentProfileSchema = Schema.TaggedStruct("AgentProfile", {
  profileId: AgentProfileIdSchema,
  role: NonEmptyStringSchema,
  harnessReference: NonEmptyStringSchema,
  instructionReferences: Schema.Array(NonEmptyStringSchema),
  skillReferences: Schema.Array(NonEmptyStringSchema),
  modelPolicy: NonEmptyStringSchema,
});
export type AgentProfile = typeof AgentProfileSchema.Type;

export const SessionStatusSchema = Schema.Literals([
  "requested",
  "started",
  "cancellation_requested",
  "completed",
  "failed",
  "interrupted",
] as const);
export type SessionStatus = typeof SessionStatusSchema.Type;

export const SessionSchema = Schema.TaggedStruct("Session", {
  sessionId: SessionIdSchema,
  projectId: ProjectIdSchema,
  workId: WorkIdSchema,
  profileId: AgentProfileIdSchema,
  attempt: AttemptNumberSchema,
  predecessorSessionId: optional(SessionIdSchema),
  contextReference: NonEmptyStringSchema,
  deadline: TimestampSchema,
  outputLimit: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  toolBudget: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  status: SessionStatusSchema,
  workspaceViewId: optional(WorkspaceViewIdSchema),
  terminalReason: optional(NonEmptyStringSchema),
  startedAt: optional(TimestampSchema),
  terminalAt: optional(TimestampSchema),
});
export type Session = typeof SessionSchema.Type;

export const WorkspaceViewSchema = Schema.TaggedStruct("WorkspaceView", {
  workspaceViewId: WorkspaceViewIdSchema,
  projectId: ProjectIdSchema,
  basisContentRevision: ContentRevisionSchema,
  manifest: Schema.Struct({
    digest: Sha256DigestSchema,
    entries: Schema.Array(
      Schema.Struct({
        path: NonEmptyStringSchema,
        digest: Sha256DigestSchema,
        bytes: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
      }),
    ),
  }),
  writableScope: Schema.Array(NonEmptyStringSchema),
  lease: optional(Schema.Struct({
    resourceId: ResourceIdSchema,
    sessionId: SessionIdSchema,
    mode: Schema.Literals(["read", "write"] as const),
    acquiredAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })),
});
export type WorkspaceView = typeof WorkspaceViewSchema.Type;

export const WorkspaceLeaseSchema = Schema.TaggedStruct("WorkspaceLease", {
  resourceId: ResourceIdSchema,
  sessionId: SessionIdSchema,
  mode: Schema.Literals(["read", "write"] as const),
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
  effectId: optional(EffectIdSchema),
});
export type WorkspaceLease = typeof WorkspaceLeaseSchema.Type;
export const ResourceClaimSchema = WorkspaceLeaseSchema;
export type ResourceClaim = WorkspaceLease;

export const ContentManifestEntrySchema = Schema.Struct({
  path: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
  bytes: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
});
export type ContentManifestEntry = typeof ContentManifestEntrySchema.Type;

export const ContentManifestSchema = Schema.TaggedStruct("ContentManifest", {
  digest: Sha256DigestSchema,
  entries: Schema.Array(ContentManifestEntrySchema),
});
export type ContentManifest = typeof ContentManifestSchema.Type;

export const ArtifactReceiptSchema = Schema.TaggedStruct("ArtifactReceipt", {
  digest: Sha256DigestSchema,
  bytes: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  mediaType: NonEmptyStringSchema,
});
export type ArtifactReceipt = typeof ArtifactReceiptSchema.Type;

export const WorkspaceReadySchema = Schema.TaggedStruct("WorkspaceReady", {
  instanceId: NonEmptyStringSchema,
  containerGeneration: NonEmptyStringSchema,
  imageDigest: Sha256DigestSchema,
  readyAt: TimestampSchema,
});
export type WorkspaceReady = typeof WorkspaceReadySchema.Type;

export const SessionStartSpecSchema = Schema.TaggedStruct("SessionStartSpec", {
  sessionId: SessionIdSchema,
  effectId: EffectIdSchema,
  projectId: ProjectIdSchema,
  workId: WorkIdSchema,
  profileId: AgentProfileIdSchema,
  attempt: AttemptNumberSchema,
  predecessorSessionId: optional(SessionIdSchema),
  deadline: TimestampSchema,
  outputLimit: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  toolBudget: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  workspaceLease: WorkspaceLeaseSchema,
});
export type SessionStartSpec = typeof SessionStartSpecSchema.Type;

export const SessionHostReceiptSchema = Schema.TaggedStruct("SessionHostReceipt", {
  sessionId: SessionIdSchema,
  effectId: EffectIdSchema,
  acceptedAt: TimestampSchema,
  processReference: optional(NonEmptyStringSchema),
});
export type SessionHostReceipt = typeof SessionHostReceiptSchema.Type;

export const StartSessionEffectSchema = Schema.TaggedStruct("StartSessionEffect", {
  effectId: EffectIdSchema,
  sessionId: SessionIdSchema,
  attempt: AttemptNumberSchema,
  spec: SessionStartSpecSchema,
});
export const CancelSessionEffectSchema = Schema.TaggedStruct("CancelSessionEffect", {
  effectId: EffectIdSchema,
  sessionId: SessionIdSchema,
  reason: NonEmptyStringSchema,
});
export const EffectRequestSchema = Schema.Union([
  StartSessionEffectSchema,
  CancelSessionEffectSchema,
]);
export type StartSessionEffect = typeof StartSessionEffectSchema.Type;
export type CancelSessionEffect = typeof CancelSessionEffectSchema.Type;
export type EffectRequest = typeof EffectRequestSchema.Type;

export const EvidenceKindSchema = Schema.Literals([
  "session_terminal",
  "candidate_manifest",
  "scope_check",
  "machine_check",
  "human_approval",
  "usage",
  "artifact",
] as const);
export type EvidenceKind = typeof EvidenceKindSchema.Type;

export const EvidenceRoleSchema = Schema.Literals([
  "session_completion",
  "candidate_present",
  "scope_valid",
  "check_passed",
  "human_approval",
  "supporting",
] as const);
export type EvidenceRole = typeof EvidenceRoleSchema.Type;

export const EvidenceCheckSchema = Schema.TaggedStruct("CheckEvidence", {
  command: NonEmptyStringSchema,
  exitCode: Schema.Int,
  stdoutDigest: Sha256DigestSchema,
  stderrDigest: Sha256DigestSchema,
  candidateDigest: Sha256DigestSchema,
  containerImageDigest: Sha256DigestSchema,
  toolVersions: Schema.Record(Schema.String, NonEmptyStringSchema),
});
export type EvidenceCheck = typeof EvidenceCheckSchema.Type;

export const EvidenceScopeSchema = Schema.TaggedStruct("ScopeEvidence", {
  changedPaths: Schema.Array(NonEmptyStringSchema),
  writableScope: Schema.Array(NonEmptyStringSchema),
});
export type EvidenceScope = typeof EvidenceScopeSchema.Type;

export const EvidenceSubjectSchema = Schema.TaggedStruct("EvidenceSubject", {
  subjectType: Schema.Literals(["work", "session", "proposal", "workspace"] as const),
  subjectId: NonEmptyStringSchema,
});
export type EvidenceSubject = typeof EvidenceSubjectSchema.Type;

export const EvidenceSchema = Schema.TaggedStruct("Evidence", {
  evidenceId: EvidenceIdSchema,
  projectId: ProjectIdSchema,
  kind: EvidenceKindSchema,
  role: EvidenceRoleSchema,
  subject: EvidenceSubjectSchema,
  producerSessionId: optional(SessionIdSchema),
  producerActorId: optional(ActorIdSchema),
  observedAt: TimestampSchema,
  payloadDigest: Sha256DigestSchema,
  limitations: Schema.Array(NonEmptyStringSchema),
  candidateDigest: optional(Sha256DigestSchema),
  check: optional(EvidenceCheckSchema),
  scope: optional(EvidenceScopeSchema),
  terminalStatus: optional(Schema.Literals(["completed", "failed", "interrupted"] as const)),
});
export type Evidence = typeof EvidenceSchema.Type;

export const HandoffSchema = Schema.TaggedStruct("Handoff", {
  handoffId: HandoffIdSchema,
  projectId: ProjectIdSchema,
  producerSessionId: SessionIdSchema,
  intendedConsumer: NonEmptyStringSchema,
  basisEventRevision: EventRevisionSchema,
  basisContentRevision: ContentRevisionSchema,
  payloadDigest: Sha256DigestSchema,
  provenance: Schema.Array(EvidenceIdSchema),
});
export type Handoff = typeof HandoffSchema.Type;

export const ProposalStatusSchema = Schema.Literals(["submitted", "approved", "rejected", "merged"] as const);
export type ProposalStatus = typeof ProposalStatusSchema.Type;

export const ProposalSchema = Schema.TaggedStruct("Proposal", {
  proposalId: ProposalIdSchema,
  projectId: ProjectIdSchema,
  proposerSessionId: SessionIdSchema,
  submissionEventRevision: EventRevisionSchema,
  basisContentRevision: ContentRevisionSchema,
  candidate: ContentManifestSchema,
  evidenceIds: Schema.Array(EvidenceIdSchema),
  status: ProposalStatusSchema,
  rejectionReason: optional(NonEmptyStringSchema),
});
export type Proposal = typeof ProposalSchema.Type;

export const MergeReceiptSchema = Schema.TaggedStruct("MergeReceipt", {
  mergeId: MergeIdSchema,
  proposalId: ProposalIdSchema,
  actorId: ActorIdSchema,
  grantId: GrantIdSchema,
  policyId: PolicyIdSchema,
  policyRevision: EventRevisionSchema,
  gateKeys: Schema.Array(GateKeySchema),
  evidenceIds: Schema.Array(EvidenceIdSchema),
  priorEventRevision: EventRevisionSchema,
  resultingEventRevision: EventRevisionSchema,
  priorContentRevision: ContentRevisionSchema,
  resultingContentRevision: ContentRevisionSchema,
  candidateDigest: Sha256DigestSchema,
});
export type MergeReceipt = typeof MergeReceiptSchema.Type;

export const RejectionCodeSchema = Schema.Literals([
  "project_not_found",
  "revision_mismatch",
  "unauthorized",
  "invalid_transition",
  "resource_conflict",
  "gate_unsatisfied",
  "policy_rejected",
  "proposal_stale",
  "lease_expired",
  "artifact_missing",
] as const);
export type RejectionCode = typeof RejectionCodeSchema.Type;

export const CreateProjectSchema = Schema.TaggedStruct("CreateProject", {
  policy: PolicySchema,
  grants: optional(Schema.Array(GrantSchema)),
});
export type CreateProject = typeof CreateProjectSchema.Type;

export const SubmitWorkSchema = Schema.TaggedStruct("SubmitWork", {
  workId: WorkIdSchema,
  workProcessId: WorkProcessIdSchema,
  objective: NonEmptyStringSchema,
  kind: WorkKindSchema,
  writableScope: Schema.Array(NonEmptyStringSchema),
  requiredCheck: NonEmptyStringSchema,
  title: optional(NonEmptyStringSchema),
});
export type SubmitWork = typeof SubmitWorkSchema.Type;

export const OpenManagerSessionSchema = Schema.TaggedStruct("OpenManagerSession", {
  sessionId: SessionIdSchema,
  workId: WorkIdSchema,
  profileId: AgentProfileIdSchema,
  attempt: AttemptNumberSchema,
  contextReference: NonEmptyStringSchema,
  deadline: TimestampSchema,
  outputLimit: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  toolBudget: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  resourceId: ResourceIdSchema,
  effectId: EffectIdSchema,
});
export type OpenManagerSession = typeof OpenManagerSessionSchema.Type;

export const StartWorkerSessionSchema = Schema.TaggedStruct("StartWorkerSession", {
  sessionId: SessionIdSchema,
  workId: WorkIdSchema,
  profileId: AgentProfileIdSchema,
  attempt: AttemptNumberSchema,
  predecessorSessionId: optional(SessionIdSchema),
  contextReference: NonEmptyStringSchema,
  deadline: TimestampSchema,
  outputLimit: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  toolBudget: Schema.Int.pipe(Schema.isGreaterThanOrEqualTo(0)),
  resourceId: ResourceIdSchema,
  effectId: EffectIdSchema,
});
export type StartWorkerSession = typeof StartWorkerSessionSchema.Type;

export const CancelSessionSchema = Schema.TaggedStruct("CancelSession", {
  sessionId: SessionIdSchema,
  effectId: EffectIdSchema,
  reason: NonEmptyStringSchema,
});
export type CancelSession = typeof CancelSessionSchema.Type;

export const ReportSessionStartedSchema = Schema.TaggedStruct("ReportSessionStarted", {
  sessionId: SessionIdSchema,
  workspaceViewId: WorkspaceViewIdSchema,
  startedAt: TimestampSchema,
  effectId: optional(EffectIdSchema),
});
export type ReportSessionStarted = typeof ReportSessionStartedSchema.Type;

export const ReportSessionTerminalSchema = Schema.TaggedStruct("ReportSessionTerminal", {
  sessionId: SessionIdSchema,
  status: Schema.Literals(["completed", "failed", "interrupted"] as const),
  reason: NonEmptyStringSchema,
  terminalAt: TimestampSchema,
  effectId: optional(EffectIdSchema),
});
export type ReportSessionTerminal = typeof ReportSessionTerminalSchema.Type;

export const RecordHandoffSchema = Schema.TaggedStruct("RecordHandoff", {
  handoff: HandoffSchema,
});
export type RecordHandoff = typeof RecordHandoffSchema.Type;

export const RecordEvidenceSchema = Schema.TaggedStruct("RecordEvidence", {
  evidence: EvidenceSchema,
});
export type RecordEvidence = typeof RecordEvidenceSchema.Type;

export const SubmitProposalSchema = Schema.TaggedStruct("SubmitProposal", {
  proposal: ProposalSchema,
});
export type SubmitProposal = typeof SubmitProposalSchema.Type;

export const ApproveProposalSchema = Schema.TaggedStruct("ApproveProposal", {
  proposalId: ProposalIdSchema,
  evidence: EvidenceSchema,
});
export type ApproveProposal = typeof ApproveProposalSchema.Type;

export const RejectProposalSchema = Schema.TaggedStruct("RejectProposal", {
  proposalId: ProposalIdSchema,
  reason: NonEmptyStringSchema,
});
export type RejectProposal = typeof RejectProposalSchema.Type;

export const MergeProposalSchema = Schema.TaggedStruct("MergeProposal", {
  mergeId: MergeIdSchema,
  proposalId: ProposalIdSchema,
  grantId: GrantIdSchema,
  candidateDigest: Sha256DigestSchema,
});
export type MergeProposal = typeof MergeProposalSchema.Type;

export const AcquireWorkspaceLeaseSchema = Schema.TaggedStruct("AcquireWorkspaceLease", {
  lease: WorkspaceLeaseSchema,
});
export type AcquireWorkspaceLease = typeof AcquireWorkspaceLeaseSchema.Type;

export const RenewWorkspaceLeaseSchema = Schema.TaggedStruct("RenewWorkspaceLease", {
  resourceId: ResourceIdSchema,
  sessionId: SessionIdSchema,
  expiresAt: TimestampSchema,
});
export type RenewWorkspaceLease = typeof RenewWorkspaceLeaseSchema.Type;

export const ReleaseWorkspaceLeaseSchema = Schema.TaggedStruct("ReleaseWorkspaceLease", {
  resourceId: ResourceIdSchema,
  sessionId: SessionIdSchema,
});
export type ReleaseWorkspaceLease = typeof ReleaseWorkspaceLeaseSchema.Type;

export const ProjectCommandSchema = Schema.Union([
  CreateProjectSchema,
  SubmitWorkSchema,
  OpenManagerSessionSchema,
  StartWorkerSessionSchema,
  CancelSessionSchema,
  ReportSessionStartedSchema,
  ReportSessionTerminalSchema,
  RecordHandoffSchema,
  RecordEvidenceSchema,
  SubmitProposalSchema,
  ApproveProposalSchema,
  RejectProposalSchema,
  MergeProposalSchema,
  AcquireWorkspaceLeaseSchema,
  RenewWorkspaceLeaseSchema,
  ReleaseWorkspaceLeaseSchema,
]);
export type ProjectCommand = typeof ProjectCommandSchema.Type;

export const CreateProjectRequestSchema = Schema.Struct({
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
  command: CreateProjectSchema,
});
export type CreateProjectRequest = typeof CreateProjectRequestSchema.Type;

export const CommandEnvelopeSchema = Schema.Struct({
  schemaVersion: SchemaVersionSchema,
  commandId: CommandIdSchema,
  projectId: ProjectIdSchema,
  expectedRevision: EventRevisionSchema,
  actor: AuthenticatedActorSchema,
  command: ProjectCommandSchema,
});
export type CommandEnvelope = typeof CommandEnvelopeSchema.Type;

export const AcceptedReceiptSchema = Schema.TaggedStruct("Accepted", {
  eventRevision: EventRevisionSchema,
  eventIds: Schema.Array(CommandIdSchema),
  effectRequests: Schema.Array(EffectRequestSchema),
});
export type AcceptedReceipt = typeof AcceptedReceiptSchema.Type;

export const RejectedReceiptSchema = Schema.TaggedStruct("Rejected", {
  eventRevision: EventRevisionSchema,
  code: RejectionCodeSchema,
  details: JsonRecordSchema,
});
export type RejectedReceipt = typeof RejectedReceiptSchema.Type;

export const CommandReceiptSchema = Schema.Union([AcceptedReceiptSchema, RejectedReceiptSchema]);
export type CommandReceipt = typeof CommandReceiptSchema.Type;

export const AlreadyAppliedSchema = Schema.TaggedStruct("AlreadyApplied", {
  originalReceipt: CommandReceiptSchema,
});
export type AlreadyApplied = typeof AlreadyAppliedSchema.Type;

export const CommandResultSchema = Schema.Union([AcceptedReceiptSchema, RejectedReceiptSchema, AlreadyAppliedSchema]);
export type CommandResult = typeof CommandResultSchema.Type;

export const ProjectEventSchema = Schema.Union([
  Schema.TaggedStruct("ProjectCreated", {
    projectId: ProjectIdSchema,
    policy: PolicySchema,
  }),
  Schema.TaggedStruct("WorkSubmitted", { work: WorkSchema }),
  Schema.TaggedStruct("SessionRequested", { session: SessionSchema, effect: EffectRequestSchema }),
  Schema.TaggedStruct("SessionStarted", {
    sessionId: SessionIdSchema,
    workspaceViewId: WorkspaceViewIdSchema,
    startedAt: TimestampSchema,
  }),
  Schema.TaggedStruct("SessionCancellationRequested", { sessionId: SessionIdSchema, effect: EffectRequestSchema }),
  Schema.TaggedStruct("SessionInterrupted", {
    sessionId: SessionIdSchema,
    reason: NonEmptyStringSchema,
    terminalAt: TimestampSchema,
  }),
  Schema.TaggedStruct("SessionFailed", {
    sessionId: SessionIdSchema,
    reason: NonEmptyStringSchema,
    terminalAt: TimestampSchema,
  }),
  Schema.TaggedStruct("SessionCompleted", { sessionId: SessionIdSchema, terminalAt: TimestampSchema }),
  Schema.TaggedStruct("HandoffRecorded", { handoff: HandoffSchema }),
  Schema.TaggedStruct("EvidenceRecorded", { evidence: EvidenceSchema }),
  Schema.TaggedStruct("ProposalSubmitted", { proposal: ProposalSchema }),
  Schema.TaggedStruct("ApprovalRecorded", { proposalId: ProposalIdSchema, evidence: EvidenceSchema }),
  Schema.TaggedStruct("ProposalRejected", { proposalId: ProposalIdSchema, reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("GatesEvaluated", {
    proposalId: ProposalIdSchema,
    policyId: PolicyIdSchema,
    policyRevision: EventRevisionSchema,
    gateKeys: Schema.Array(GateKeySchema),
    satisfied: Schema.Boolean,
    evidenceIds: Schema.Array(EvidenceIdSchema),
  }),
  Schema.TaggedStruct("ProposalMerged", { receipt: MergeReceiptSchema }),
  Schema.TaggedStruct("WorkspaceLeaseAcquired", { lease: WorkspaceLeaseSchema }),
  Schema.TaggedStruct("WorkspaceLeaseRenewed", {
    resourceId: ResourceIdSchema,
    sessionId: SessionIdSchema,
    expiresAt: TimestampSchema,
  }),
  Schema.TaggedStruct("WorkspaceLeaseReleased", {
    resourceId: ResourceIdSchema,
    sessionId: SessionIdSchema,
  }),
]);
export type ProjectEvent = typeof ProjectEventSchema.Type;

export const EventEnvelopeSchema = Schema.TaggedStruct("EventEnvelope", {
  eventRevision: EventRevisionSchema,
  commandId: CommandIdSchema,
  event: ProjectEventSchema,
});
export type EventEnvelope = typeof EventEnvelopeSchema.Type;

export const ProjectObservationSchema = Schema.TaggedStruct("ProjectObservation", {
  projectId: ProjectIdSchema,
  eventRevision: EventRevisionSchema,
  contentRevision: ContentRevisionSchema,
  policy: PolicySchema,
  canonicalContent: optional(ContentManifestSchema),
  history: Schema.Array(EventEnvelopeSchema),
  activeWorkIds: Schema.Array(WorkIdSchema),
  activeSessionIds: Schema.Array(SessionIdSchema),
  sourceDigest: Sha256DigestSchema,
});
export type ProjectObservation = typeof ProjectObservationSchema.Type;

export const decodeUnknownStrict = <S extends Schema.Top>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);

export const decodeCommand = (input: unknown): ProjectCommand =>
  decodeUnknownStrict(ProjectCommandSchema, input);
export const decodeCommandEnvelope = (input: unknown): CommandEnvelope =>
  decodeUnknownStrict(CommandEnvelopeSchema, input);
export const decodeCreateProjectRequest = (input: unknown): CreateProjectRequest =>
  decodeUnknownStrict(CreateProjectRequestSchema, input);
export const decodeCommandResult = (input: unknown): CommandResult =>
  decodeUnknownStrict(CommandResultSchema, input);
export const decodeProjectObservation = (input: unknown): ProjectObservation =>
  decodeUnknownStrict(ProjectObservationSchema, input);
export const decodeProjectEvent = (input: unknown): ProjectEvent =>
  decodeUnknownStrict(ProjectEventSchema, input);

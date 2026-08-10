import { Schema } from "effect";
import {
  AgentProfileIdSchema,
  CommandIdSchema,
  ContentRevisionSchema,
  EventRevisionSchema,
  EvidenceIdSchema,
  GateIdSchema,
  GrantIdSchema,
  HandoffIdSchema,
  MergeIdSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  ProposalIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  WorkIdSchema,
} from "./identifiers.ts";
import { CommandResultSchema, ProjectObservationSchema } from "./schema.ts";

const NonEmptyStringSchema = Schema.NonEmptyString;
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);
export const TracerFixtureEntrySchema = Schema.Struct({
  path: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
  bytes: Schema.Natural,
});
export type TracerFixtureEntry = typeof TracerFixtureEntrySchema.Type;

export const TracerFixtureSnapshotSchema = Schema.Struct({
  digest: Sha256DigestSchema,
  bytes: Schema.Natural,
  entries: Schema.Array(TracerFixtureEntrySchema),
});
export type TracerFixtureSnapshot = typeof TracerFixtureSnapshotSchema.Type;

export const TracerFixtureManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal("work-engine/tracer-0001"),
  objective: Schema.Literal(
    'Make `greeting("Ada")` return `Hello, Ada!`. Modify only `src/greeting.ts`. Run `bun run check`.',
  ),
  check: Schema.Literal("bun run check"),
  writableScope: Schema.Tuple([Schema.Literal("src/greeting.ts")]),
  base: TracerFixtureSnapshotSchema,
  candidate: TracerFixtureSnapshotSchema,
  patch: Schema.Struct({
    digest: Sha256DigestSchema,
    bytes: Schema.Natural,
  }),
});
export type TracerFixtureManifest = typeof TracerFixtureManifestSchema.Type;

export const TracerToolVersionsSchema = Schema.Struct({
  bun: NonEmptyStringSchema,
  git: NonEmptyStringSchema,
  herdr: Schema.Literal("0.8.0"),
  omp: Schema.Literal("17.2.3"),
  herdrOmpIntegration: NonEmptyStringSchema,
  work: Schema.Literal("0.0.0"),
});
export type TracerToolVersions = typeof TracerToolVersionsSchema.Type;

export const TracerRuntimeEvidenceSchema = Schema.Struct({
  workerVersion: NonEmptyStringSchema,
  compatibilityDate: Schema.Literal("2026-08-10"),
  compatibilityFlags: Schema.Array(NonEmptyStringSchema),
  containerImageDigest: Sha256DigestSchema,
  containerGenerationBefore: NonEmptyStringSchema,
  containerGenerationAfter: NonEmptyStringSchema,
  toolVersions: TracerToolVersionsSchema,
  herdrConfigDigest: Sha256DigestSchema,
});
export type TracerRuntimeEvidence = typeof TracerRuntimeEvidenceSchema.Type;

export const TracerIdentityEvidenceSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  workId: WorkIdSchema,
  profileId: AgentProfileIdSchema,
  managerSessionId: SessionIdSchema,
  workerSessionId: SessionIdSchema,
  retrySessionId: optional(SessionIdSchema),
  handoffId: HandoffIdSchema,
  proposalId: ProposalIdSchema,
  policyId: PolicyIdSchema,
  gateIds: Schema.Array(GateIdSchema),
  grantId: GrantIdSchema,
  mergeId: MergeIdSchema,
});
export type TracerIdentityEvidence = typeof TracerIdentityEvidenceSchema.Type;

export const TracerAttachEvidenceSchema = Schema.Struct({
  resolutionId: NonEmptyStringSchema,
  projectId: ProjectIdSchema,
  workId: WorkIdSchema,
  containerInstanceId: NonEmptyStringSchema,
  sshHost: NonEmptyStringSchema,
  sshPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  sshUser: NonEmptyStringSchema,
  proxyCommand: Schema.Literal("wrangler containers ssh %h"),
  herdrSessionName: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  plainSshProbe: Schema.Boolean,
  localHerdrVersion: Schema.Literal("0.8.0"),
  remoteHerdrVersion: Schema.Literal("0.8.0"),
});
export type TracerAttachEvidence = typeof TracerAttachEvidenceSchema.Type;

export const TracerArtifactEvidenceSchema = Schema.Struct({
  baseManifestDigest: Sha256DigestSchema,
  candidateManifestDigest: Sha256DigestSchema,
  patchDigest: Sha256DigestSchema,
  stdoutDigest: Sha256DigestSchema,
  stderrDigest: Sha256DigestSchema,
  changedPaths: Schema.Array(NonEmptyStringSchema),
  checkCommand: Schema.Literal("bun run check"),
  checkExitCode: Schema.Literal(0),
});
export type TracerArtifactEvidence = typeof TracerArtifactEvidenceSchema.Type;

export const TracerWhyReferenceSchema = Schema.Struct({
  eventRevision: EventRevisionSchema,
  commandId: CommandIdSchema,
  eventTag: NonEmptyStringSchema,
});
export type TracerWhyReference = typeof TracerWhyReferenceSchema.Type;

export const TracerNegativeControlsSchema = Schema.Struct({
  replayStable: Schema.Boolean,
  staleRevisionCode: Schema.Literal("revision_mismatch"),
  preApprovalMergeCode: Schema.Literal("gate_unsatisfied"),
  managerMergeCode: Schema.Literal("unauthorized"),
  wrongCandidateCheckRejected: Schema.Boolean,
  workspaceConflictCode: Schema.Literal("resource_conflict"),
  outOfScopeCandidateRejected: Schema.Boolean,
  frozenSnapshotImmutable: Schema.Boolean,
  sessionIsolationEnforced: Schema.Boolean,
  duplicateStartStable: Schema.Boolean,
  herdrRestartInterrupted: Schema.Boolean,
  replacementPreservedCandidate: Schema.Boolean,
});
export type TracerNegativeControls = typeof TracerNegativeControlsSchema.Type;

export const TracerSourceDigestSchema = Schema.Struct({
  path: NonEmptyStringSchema,
  digest: Sha256DigestSchema,
});
export type TracerSourceDigest = typeof TracerSourceDigestSchema.Type;

const TracerAcceptanceFields = {
  schemaVersion: Schema.Literal("work-engine/tracer-0001-evidence"),
  observedAt: TimestampSchema,
  runtime: TracerRuntimeEvidenceSchema,
  identities: TracerIdentityEvidenceSchema,
  commandReceipts: Schema.Array(CommandResultSchema),
  attach: TracerAttachEvidenceSchema,
  artifacts: TracerArtifactEvidenceSchema,
  evidenceIds: Schema.Array(EvidenceIdSchema),
  whyReferences: Schema.Array(TracerWhyReferenceSchema),
  controls: TracerNegativeControlsSchema,
  preRestart: ProjectObservationSchema,
  postRestart: ProjectObservationSchema,
  postReplacement: ProjectObservationSchema,
  acceptedCandidateDigest: Sha256DigestSchema,
  finalEventRevision: EventRevisionSchema,
  finalContentRevision: ContentRevisionSchema,
  foundingSources: Schema.Array(TracerSourceDigestSchema),
} as const;

export const LocalTracerEvidenceSchema = Schema.TaggedStruct("LocalTracerEvidence", {
  ...TracerAcceptanceFields,
  mode: Schema.Literal("local"),
});
export type LocalTracerEvidence = typeof LocalTracerEvidenceSchema.Type;

export const CloudTracerEvidenceSchema = Schema.TaggedStruct("CloudTracerEvidence", {
  ...TracerAcceptanceFields,
  mode: Schema.Literal("cloud"),
  deployedUrl: NonEmptyStringSchema,
});
export type CloudTracerEvidence = typeof CloudTracerEvidenceSchema.Type;

export const TracerAcceptanceEvidenceSchema = Schema.Union([
  LocalTracerEvidenceSchema,
  CloudTracerEvidenceSchema,
]);
export type TracerAcceptanceEvidence = typeof TracerAcceptanceEvidenceSchema.Type;

export const TracerAcceptanceUnavailableSchema = Schema.TaggedStruct(
  "TracerAcceptanceUnavailable",
  {
    schemaVersion: Schema.Literal("work-engine/tracer-0001-evidence"),
    observedAt: TimestampSchema,
    reason: NonEmptyStringSchema,
    missingPrerequisites: Schema.Array(NonEmptyStringSchema),
    completedChecks: Schema.Array(NonEmptyStringSchema),
  },
);
export type TracerAcceptanceUnavailable = typeof TracerAcceptanceUnavailableSchema.Type;

export const TracerAcceptanceRecordSchema = Schema.Union([
  TracerAcceptanceEvidenceSchema,
  TracerAcceptanceUnavailableSchema,
]);
export type TracerAcceptanceRecord = typeof TracerAcceptanceRecordSchema.Type;

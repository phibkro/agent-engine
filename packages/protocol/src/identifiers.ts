import { Schema } from "effect";

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uuidId = (prefix: string, semanticSuffixes: readonly string[] = []) => {
  const semantic = semanticSuffixes.length === 0 ? "" : `|(?:${semanticSuffixes.join("|")})`;
  return Schema.String.pipe(
    Schema.check(Schema.isPattern(new RegExp(`^${prefix}(?:${UUID_V4}${semantic})$`))),
  );
};

export const ProjectIdSchema = uuidId("prj_").pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectIdSchema.Type;

export const WorkIdSchema = uuidId("wrk_").pipe(Schema.brand("WorkId"));
export type WorkId = typeof WorkIdSchema.Type;

export const WorkProcessIdSchema = uuidId("wpr_").pipe(Schema.brand("WorkProcessId"));
export type WorkProcessId = typeof WorkProcessIdSchema.Type;

export const AgentProfileIdSchema = uuidId("prf_").pipe(Schema.brand("AgentProfileId"));
export type AgentProfileId = typeof AgentProfileIdSchema.Type;

export const SessionIdSchema = uuidId("ses_").pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionIdSchema.Type;

export const WorkspaceViewIdSchema = uuidId("wsv_").pipe(Schema.brand("WorkspaceViewId"));
export type WorkspaceViewId = typeof WorkspaceViewIdSchema.Type;

export const ResourceIdSchema = uuidId("res_").pipe(Schema.brand("ResourceId"));
export type ResourceId = typeof ResourceIdSchema.Type;

export const HandoffIdSchema = uuidId("hnd_").pipe(Schema.brand("HandoffId"));
export type HandoffId = typeof HandoffIdSchema.Type;

export const EvidenceIdSchema = uuidId("evd_").pipe(Schema.brand("EvidenceId"));
export type EvidenceId = typeof EvidenceIdSchema.Type;

export const ProposalIdSchema = uuidId("prp_").pipe(Schema.brand("ProposalId"));
export type ProposalId = typeof ProposalIdSchema.Type;

export const MergeIdSchema = uuidId("mrg_").pipe(Schema.brand("MergeId"));
export type MergeId = typeof MergeIdSchema.Type;

export const GateIdSchema = uuidId("gat_", [
  "session_completed",
  "candidate_present",
  "scope_valid",
  "check_passed",
  "human_approved",
]).pipe(Schema.brand("GateId"));
export type GateId = typeof GateIdSchema.Type;

export const GrantIdSchema = uuidId("grt_").pipe(Schema.brand("GrantId"));
export type GrantId = typeof GrantIdSchema.Type;

export const PolicyIdSchema = uuidId("pol_", ["tracer_0001_v1"]).pipe(Schema.brand("PolicyId"));
export type PolicyId = typeof PolicyIdSchema.Type;

export const CommandIdSchema = uuidId("cmd_").pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandIdSchema.Type;

export const EffectIdSchema = uuidId("efx_").pipe(Schema.brand("EffectId"));
export type EffectId = typeof EffectIdSchema.Type;

export const ActorIdSchema = Schema.NonEmptyString.pipe(Schema.brand("ActorId"));
export type ActorId = typeof ActorIdSchema.Type;

export const Sha256DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  Schema.brand("Sha256Digest"),
);
export type Sha256Digest = typeof Sha256DigestSchema.Type;

export const EventRevisionSchema = Schema.Natural.pipe(Schema.brand("EventRevision"));
export type EventRevision = typeof EventRevisionSchema.Type;
export type ProjectRevision = EventRevision;

export const ContentRevisionSchema = Schema.Natural.pipe(Schema.brand("ContentRevision"));
export type ContentRevision = typeof ContentRevisionSchema.Type;

export const AttemptNumberSchema = Schema.Natural.pipe(Schema.brand("AttemptNumber"));
export type AttemptNumber = typeof AttemptNumberSchema.Type;

export const MillisSchema = Schema.Natural.pipe(Schema.brand("Millis"));
export type Millis = typeof MillisSchema.Type;

export const TimestampSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)),
  Schema.brand("Timestamp"),
);
export type Timestamp = typeof TimestampSchema.Type;

export const SchemaVersionSchema = Schema.Literal("work-engine/v1");
export type SchemaVersion = typeof SchemaVersionSchema.Type;

export const makeId = <T extends string>(prefix: T): `${T}${string}` =>
  `${prefix}${globalThis.crypto.randomUUID().toLowerCase()}` as `${T}${string}`;

export const makeProjectId = (): ProjectId => ProjectIdSchema.make(makeId("prj_"));
export const makeWorkId = (): WorkId => WorkIdSchema.make(makeId("wrk_"));
export const makeWorkProcessId = (): WorkProcessId => WorkProcessIdSchema.make(makeId("wpr_"));
export const makeAgentProfileId = (): AgentProfileId => AgentProfileIdSchema.make(makeId("prf_"));
export const makeSessionId = (): SessionId => SessionIdSchema.make(makeId("ses_"));
export const makeWorkspaceViewId = (): WorkspaceViewId =>
  WorkspaceViewIdSchema.make(makeId("wsv_"));
export const makeResourceId = (): ResourceId => ResourceIdSchema.make(makeId("res_"));
export const makeHandoffId = (): HandoffId => HandoffIdSchema.make(makeId("hnd_"));
export const makeEvidenceId = (): EvidenceId => EvidenceIdSchema.make(makeId("evd_"));
export const makeProposalId = (): ProposalId => ProposalIdSchema.make(makeId("prp_"));
export const makeMergeId = (): MergeId => MergeIdSchema.make(makeId("mrg_"));
export const makeCommandId = (): CommandId => CommandIdSchema.make(makeId("cmd_"));
export const makeEffectId = (): EffectId => EffectIdSchema.make(makeId("efx_"));

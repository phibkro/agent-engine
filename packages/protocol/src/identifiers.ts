import { Schema } from "effect";

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const uuidId = (prefix: string) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(`^${prefix}${UUID_V4}$`))));

const brandedUuid = <Brand extends string>(prefix: string, brand: Brand) =>
  uuidId(prefix).pipe(Schema.brand(brand));

export const ProjectIdSchema = brandedUuid("prj_", "ProjectId");
export type ProjectId = typeof ProjectIdSchema.Type;

export const TaskIdSchema = brandedUuid("tsk_", "TaskId");
export type TaskId = typeof TaskIdSchema.Type;

export const ProfileIdSchema = brandedUuid("prf_", "ProfileId");
export type ProfileId = typeof ProfileIdSchema.Type;

export const ProfileRevisionSchema = Schema.Natural.pipe(Schema.brand("ProfileRevision"));
export type ProfileRevision = typeof ProfileRevisionSchema.Type;

export const SessionIdSchema = brandedUuid("ses_", "SessionId");
export type SessionId = typeof SessionIdSchema.Type;

export const MessageIdSchema = brandedUuid("msg_", "MessageId");
export type MessageId = typeof MessageIdSchema.Type;

export const MemoryRevisionSchema = Schema.Natural.pipe(Schema.brand("MemoryRevision"));
export type MemoryRevision = typeof MemoryRevisionSchema.Type;

export const MemoryProposalIdSchema = brandedUuid("mpp_", "MemoryProposalId");
export type MemoryProposalId = typeof MemoryProposalIdSchema.Type;

export const GrantIdSchema = brandedUuid("grt_", "GrantId");
export type GrantId = typeof GrantIdSchema.Type;

export const CommitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  Schema.brand("CommitSha"),
);
export type CommitSha = typeof CommitShaSchema.Type;

export const Sha256DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  Schema.brand("Sha256Digest"),
);
export type Sha256Digest = typeof Sha256DigestSchema.Type;

export const TimestampSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)),
  Schema.brand("Timestamp"),
);
export type Timestamp = typeof TimestampSchema.Type;

export const NonEmptyStringSchema = Schema.NonEmptyString;
export const SchemaVersionSchema = Schema.Literal("work-engine/v2");
export type SchemaVersion = typeof SchemaVersionSchema.Type;

export const makeId = <Prefix extends string>(prefix: Prefix): `${Prefix}${string}` =>
  `${prefix}${globalThis.crypto.randomUUID().toLowerCase()}` as `${Prefix}${string}`;

export const makeProjectId = (): ProjectId => ProjectIdSchema.make(makeId("prj_"));
export const makeTaskId = (): TaskId => TaskIdSchema.make(makeId("tsk_"));
export const makeProfileId = (): ProfileId => ProfileIdSchema.make(makeId("prf_"));
export const makeSessionId = (): SessionId => SessionIdSchema.make(makeId("ses_"));
export const makeMessageId = (): MessageId => MessageIdSchema.make(makeId("msg_"));
export const makeMemoryProposalId = (): MemoryProposalId =>
  MemoryProposalIdSchema.make(makeId("mpp_"));
export const makeGrantId = (): GrantId => GrantIdSchema.make(makeId("grt_"));

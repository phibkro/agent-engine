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

const CANONICAL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
};

const isCanonicalTimestamp = (value: string): boolean => {
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    millisecond <= 999
  );
};

export const TimestampSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(CANONICAL_TIMESTAMP)),
  Schema.check(
    Schema.makeFilter(
      (value) => isCanonicalTimestamp(value) || "timestamp must be a canonical UTC instant",
    ),
  ),
  Schema.brand("Timestamp"),
);
export type Timestamp = typeof TimestampSchema.Type;

export const NonEmptyStringSchema = Schema.NonEmptyString;
export const SchemaVersionSchema = Schema.Literal("work-engine/v2");
export type SchemaVersion = typeof SchemaVersionSchema.Type;


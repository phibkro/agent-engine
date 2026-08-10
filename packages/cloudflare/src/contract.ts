import * as Schema from "effect/Schema";
import {
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  CommitShaSchema,
  DependencyCacheManifestSchema,
  MemoryRevisionSchema,
  MessageIdSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProfileSchema,
  ProductDecisionSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProposalSchema,
  ProjectMemoryProvenanceSchema,
  ProjectMemoryRevisionSchema,
  RepositoryGrantSchema,
  RepositoryIdentitySchema,
  SessionAdmissionSchema,
  SessionIdSchema,
  SessionObservationSchema,
  SessionResultSchema,
  TrialManifestSchema,
  TrialRecordSchema,
  VerifiedWorkspaceSchema,
  type CandidateReceipt,
  type CheckpointReceipt,
  type CloudTask,
  type CommitSha,
  type DependencyCacheManifest,
  type MemoryRevision,
  type MessageId,
  type Profile,
  type ProfileId,
  type ProfileRevision,
  type ProductDecision,
  type ProjectMemoryFact,
  type ProjectMemoryProposal,
  type ProjectMemoryProvenance,
  type ProjectMemoryRevision,
  type RepositoryGrant,
  type RepositoryIdentity,
  type SessionAdmission,
  type SessionId,
  type SessionObservation,
  type SessionResult,
  type TrialManifest,
  type TrialRecord,
  type VerifiedWorkspace,
} from "@work-engine/protocol";
import type {
  CloudTaskClient,
  DependencyCache,
  ProfileRegistry as RuntimeProfileRegistry,
  ProjectMemory as RuntimeProjectMemory,
  RepositoryPublisher,
} from "@work-engine/runtime";

export {
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CloudTaskRequestSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  CommitShaSchema,
  DependencyCacheManifestSchema,
  MemoryRevisionSchema,
  MessageIdSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProfileSchema,
  ProductDecisionSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProposalSchema,
  ProjectMemoryProvenanceSchema,
  ProjectMemoryRevisionSchema,
  RepositoryGrantSchema,
  RepositoryIdentitySchema,
  SessionAdmissionSchema,
  SessionIdSchema,
  SessionObservationSchema,
  SessionResultSchema,
  TrialManifestSchema,
  TrialRecordSchema,
  VerifiedWorkspaceSchema,
};

export type {
  CandidateReceipt,
  CheckpointReceipt,
  CloudTask,
  CommitSha,
  DependencyCacheManifest,
  MemoryRevision,
  MessageId,
  Profile,
  ProfileId,
  ProfileRevision,
  ProductDecision,
  ProjectMemoryFact,
  ProjectMemoryProposal,
  ProjectMemoryProvenance,
  ProjectMemoryRevision,
  RepositoryGrant,
  RepositoryIdentity,
  SessionAdmission,
  SessionId,
  SessionObservation,
  SessionResult,
  TrialManifest,
  TrialRecord,
  VerifiedWorkspace,
};

export type {
  CloudTaskClient,
  DependencyCache,
  RuntimeProfileRegistry,
  RuntimeProjectMemory,
  RepositoryPublisher,
};

/** Decode every public/persisted boundary with strict excess-property rejection. */
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

export const encode = <S extends Schema.ConstraintEncoder<unknown>>(schema: S, value: S["Type"]): unknown =>
  Schema.encodeSync(schema)(value);

export const json = (value: unknown): string => JSON.stringify(value);

export const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a record");
  }
  return value as Record<string, unknown>;
};

export const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const requiredString = (value: unknown, field: string): string => {
  const result = optionalString(value);
  if (result === undefined || result.length === 0) throw new TypeError(`Missing ${field}`);
  return result;
};

export const tagOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const tag = (value as Record<string, unknown>)["_tag"];
  return typeof tag === "string" ? tag : undefined;
};

export const nowIso = (): string => new Date().toISOString();

export const newId = (prefix: string): string => `${prefix}${crypto.randomUUID()}`;

export const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

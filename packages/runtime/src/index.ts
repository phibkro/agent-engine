import type * as Effect from "effect/Effect";
import type {
  ArtifactReceipt,
  CommandEnvelope,
  CommandResult,
  EventRevision,
  ProjectId,
  ProjectObservation,
  SessionHostReceipt,
  SessionId,
  SessionStartSpec,
  Sha256Digest,
  WorkspaceLease,
  WorkspaceReady,
} from "@work-engine/protocol";

export type ProjectAuthorityError =
  | { readonly _tag: "ProjectNotFound"; readonly projectId: ProjectId }
  | {
      readonly _tag: "RevisionMismatch";
      readonly expectedRevision: EventRevision;
      readonly observedRevision: EventRevision;
    }
  | { readonly _tag: "Unauthorized"; readonly reason: string }
  | { readonly _tag: "DecodeFailure"; readonly reason: string }
  | { readonly _tag: "AuthorityUnavailable"; readonly reason: string }
  | { readonly _tag: "StorageUnavailable"; readonly reason: string }
  | { readonly _tag: "AuthorityRejected"; readonly result: CommandResult };

export type ArtifactError =
  | { readonly _tag: "ArtifactMissing"; readonly digest: Sha256Digest }
  | { readonly _tag: "ArtifactConflict"; readonly digest: Sha256Digest; readonly reason: string }
  | { readonly _tag: "ArtifactDigestMismatch"; readonly expected: Sha256Digest; readonly observed: Sha256Digest }
  | { readonly _tag: "ArtifactUnavailable"; readonly reason: string };

export type SessionHostError =
  | { readonly _tag: "LeaseExpired"; readonly resourceId: WorkspaceLease["resourceId"] }
  | { readonly _tag: "WorkspaceUnavailable"; readonly reason: string }
  | { readonly _tag: "ReadinessFailed"; readonly reason: string }
  | { readonly _tag: "VersionMismatch"; readonly reason: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: SessionId }
  | { readonly _tag: "SessionAlreadyStarted"; readonly sessionId: SessionId }
  | { readonly _tag: "ProcessUnavailable"; readonly reason: string }
  | { readonly _tag: "ModelUnavailable"; readonly reason: string }
  | { readonly _tag: "HostUnavailable"; readonly reason: string };

export interface ProjectAuthority {
  dispatch(command: CommandEnvelope): Effect.Effect<CommandResult, ProjectAuthorityError>;
  observe(
    projectId: ProjectId,
    eventRevision?: EventRevision,
  ): Effect.Effect<ProjectObservation, ProjectAuthorityError>;
}

export interface ArtifactStore {
  put(content: Uint8Array, mediaType: string): Effect.Effect<ArtifactReceipt, ArtifactError>;
  get(digest: Sha256Digest): Effect.Effect<Uint8Array, ArtifactError>;
  head(digest: Sha256Digest): Effect.Effect<ArtifactReceipt, ArtifactError>;
}

export interface SessionHost {
  ensureReady(lease: WorkspaceLease): Effect.Effect<WorkspaceReady, SessionHostError>;
  start(spec: SessionStartSpec): Effect.Effect<SessionHostReceipt, SessionHostError>;
  cancel(sessionId: SessionId, reason: string): Effect.Effect<SessionHostReceipt, SessionHostError>;
}

import type { SessionHostError } from "@work-engine/runtime";
import type { SessionId, WorkspaceViewId } from "@work-engine/protocol";

export type SessionHostFailure = SessionHostError | CandidateFinalizeFailure | CustodyFailure;

export type CandidateFinalizeFailure =
  | { readonly _tag: "CandidateFinalizeBeforeExit"; readonly sessionId: SessionId }
  | { readonly _tag: "CandidateAlreadyFinalized"; readonly sessionId: SessionId }
  | { readonly _tag: "CandidateScopeViolation"; readonly changedPaths: readonly string[] }
  | { readonly _tag: "CandidateImmutable"; readonly sessionId: SessionId };

export type CustodyFailure =
  | { readonly _tag: "BaseArtifactUnavailable"; readonly reason: string }
  | { readonly _tag: "WorkspaceCommandFailed"; readonly command: readonly string[]; readonly reason: string }
  | { readonly _tag: "ArtifactUploadFailed"; readonly reason: string }
  | { readonly _tag: "ArtifactVerificationFailed"; readonly digest: string; readonly reason: string }
  | { readonly _tag: "WorkspacePathRejected"; readonly path: string }
  | { readonly _tag: "SnapshotUnavailable"; readonly reason: string };

export class HostFailure extends Error {
  readonly name = "HostFailure";
  constructor(readonly failure: SessionHostFailure) {
    super(failureReason(failure));
  }
}

export class CustodyFailureError extends Error {
  readonly name = "CustodyFailureError";
  constructor(readonly failure: CandidateFinalizeFailure | CustodyFailure) {
    super(failureReason(failure));
  }
}

export const failureReason = (failure: SessionHostFailure): string => {
  switch (failure._tag) {
    case "LeaseExpired":
      return `workspace lease expired: ${failure.resourceId}`;
    case "WorkspaceUnavailable":
      return failure.reason;
    case "ReadinessFailed":
      return failure.reason;
    case "VersionMismatch":
      return failure.reason;
    case "SessionNotFound":
      return `session not found: ${failure.sessionId}`;
    case "SessionAlreadyStarted":
      return `session already started: ${failure.sessionId}`;
    case "ProcessUnavailable":
      return failure.reason;
    case "ModelUnavailable":
      return failure.reason;
    case "HostUnavailable":
      return failure.reason;
    case "CandidateFinalizeBeforeExit":
      return `candidate.finalize requires an exited worker: ${failure.sessionId}`;
    case "CandidateAlreadyFinalized":
      return `candidate already finalized: ${failure.sessionId}`;
    case "CandidateScopeViolation":
      return `candidate changed paths outside writable scope: ${failure.changedPaths.join(", ")}`;
    case "CandidateImmutable":
      return `candidate snapshot is immutable: ${failure.sessionId}`;
    case "BaseArtifactUnavailable":
      return failure.reason;
    case "WorkspaceCommandFailed":
      return `${failure.command.join(" ")}: ${failure.reason}`;
    case "ArtifactUploadFailed":
      return failure.reason;
    case "ArtifactVerificationFailed":
      return `${failure.digest}: ${failure.reason}`;
    case "WorkspacePathRejected":
      return `workspace path rejected: ${failure.path}`;
    case "SnapshotUnavailable":
      return failure.reason;
  }
};

export const isSessionHostFailure = (value: unknown): value is SessionHostFailure =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof value._tag === "string";

export const workspaceViewId = (sessionId: SessionId): WorkspaceViewId =>
  `${sessionId.replace(/^ses_/, "wsv_")}` as WorkspaceViewId;

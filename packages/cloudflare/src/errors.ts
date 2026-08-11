import type { TerminalSessionState } from "@work-engine/protocol";
import type { Json } from "effect/Schema";

export type CloudErrorTag =
  | "Unauthenticated"
  | "Unauthorized"
  | "InvalidRequest"
  | "SessionNotFound"
  | "SessionConflict"
  | "SessionTerminal"
  | "MemoryRevisionUnavailable"
  | "MemoryRevisionMismatch"
  | "MemoryProposalNotFound"
  | "MemoryUnauthorized"
  | "RepositoryGrantInvalid"
  | "RepositoryConflict"
  | "RepositoryScopeViolation"
  | "RepositoryAncestryViolation"
  | "CacheMiss"
  | "CacheDigestMismatch"
  | "ProviderUnavailable";

export class CloudRuntimeError extends Error {
  readonly _tag: CloudErrorTag;
  readonly details: Readonly<Record<string, Json>>;

  constructor(
    tag: CloudErrorTag,
    message: string,
    details: Readonly<Record<string, Json>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = tag;
    this._tag = tag;
    this.details = details;
  }
}

export class UnauthenticatedError extends CloudRuntimeError {
  constructor() {
    super("Unauthenticated", "Cloud-task authentication is required");
  }
}

export class UnauthorizedError extends CloudRuntimeError {
  constructor(reason = "Caller is not authorized for this Session") {
    super("Unauthorized", reason);
  }
}

export class InvalidRequestError extends CloudRuntimeError {
  constructor(reason: string, cause?: unknown) {
    super("InvalidRequest", reason, {}, cause === undefined ? undefined : { cause });
  }
}

export class SessionNotFoundError extends CloudRuntimeError {
  constructor(sessionId: string) {
    super("SessionNotFound", `Session ${sessionId} does not exist`, { sessionId });
  }
}

export class SessionConflictError extends CloudRuntimeError {
  constructor(reason: string) {
    super("SessionConflict", reason);
  }
}

export class SessionTerminalError extends CloudRuntimeError {
  constructor(state: TerminalSessionState, reason = "Session is terminal") {
    super("SessionTerminal", reason, { sessionId: state.sessionId, state });
  }
}

export class MemoryRevisionUnavailableError extends CloudRuntimeError {
  constructor(projectId: string, revision: number) {
    super("MemoryRevisionUnavailable", `Project Memory revision ${revision} is unavailable`, {
      projectId,
      revision,
    });
  }
}

export class MemoryRevisionMismatchError extends CloudRuntimeError {
  constructor(expected: number, observed: number) {
    super("MemoryRevisionMismatch", `Expected memory revision ${expected}, observed ${observed}`, {
      expected,
      observed,
    });
  }
}

export class MemoryProposalNotFoundError extends CloudRuntimeError {
  constructor(proposalId: string) {
    super("MemoryProposalNotFound", `Memory proposal ${proposalId} does not exist`, { proposalId });
  }
}

export class MemoryUnauthorizedError extends CloudRuntimeError {
  constructor() {
    super("MemoryUnauthorized", "This binding cannot accept Project Memory proposals");
  }
}

export class RepositoryGrantInvalidError extends CloudRuntimeError {
  constructor(reason: string) {
    super("RepositoryGrantInvalid", reason);
  }
}

export class RepositoryConflictError extends CloudRuntimeError {
  constructor(reason: string) {
    super("RepositoryConflict", reason);
  }
}

export class RepositoryScopeViolationError extends CloudRuntimeError {
  constructor(paths: readonly string[]) {
    super(
      "RepositoryScopeViolation",
      `Candidate changes exceed the granted scope: ${paths.join(", ")}`,
      {
        paths,
      },
    );
  }
}

export class RepositoryAncestryViolationError extends CloudRuntimeError {
  constructor(commit: string, base: string) {
    super("RepositoryAncestryViolation", `Commit ${commit} is not descended from ${base}`, {
      commit,
      base,
    });
  }
}

export class CacheMissError extends CloudRuntimeError {
  constructor(cacheKey: string, reason = `Dependency cache ${cacheKey} is unavailable`) {
    super("CacheMiss", reason, { cacheKey });
  }
}

export class CacheDigestMismatchError extends CloudRuntimeError {
  constructor(expected: string, observed: string) {
    super(
      "CacheDigestMismatch",
      `Dependency cache digest mismatch: expected ${expected}, observed ${observed}`,
      {
        expected,
        observed,
      },
    );
  }
}

export class ProviderUnavailableError extends CloudRuntimeError {
  constructor(
    provider: string,
    reason = "Required provider binding is unavailable",
    cause?: unknown,
  ) {
    super(
      "ProviderUnavailable",
      `${provider}: ${reason}`,
      { provider },
      cause === undefined ? undefined : { cause },
    );
  }
}

export const isCloudRuntimeError = (cause: unknown): cause is CloudRuntimeError =>
  cause instanceof CloudRuntimeError;

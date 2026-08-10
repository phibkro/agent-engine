import {
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CommitShaSchema,
  RepositoryGrantSchema,
  VerifiedWorkspaceSchema,
  decode,
  nowIso,
  type CandidateReceipt,
  type CheckpointReceipt,
  type RepositoryGrant,
  type RepositoryIdentity,
  type VerifiedWorkspace,
} from "./contract.ts";
import {
  RepositoryCandidateVerificationSchema,
  RepositoryRefStateSchema,
} from "@work-engine/protocol";
import {
  ProviderUnavailableError,
  RepositoryAncestryViolationError,
  RepositoryConflictError,
  RepositoryGrantInvalidError,
  RepositoryScopeViolationError,
} from "./errors.ts";

export interface GitRefState {
  readonly sha: string | undefined;
}

export interface GitCandidateVerification {
  readonly descendedFromBase: boolean;
  readonly changedPaths: readonly string[];
  readonly commitMetadata: Readonly<Record<string, unknown>>;
}

export interface RepositoryTransport {
  readRef(ref: string): Promise<GitRefState>;
  verifyCandidate(input: {
    readonly baseCommit: string;
    readonly candidateCommit: string;
    readonly repository: RepositoryIdentity;
  }): Promise<GitCandidateVerification>;
  updateRef(input: {
    readonly ref: string;
    readonly expectedSha: string | undefined;
    readonly nextSha: string;
    readonly force: false;
  }): Promise<GitRefState>;
}

export interface RepositoryPublisherOptions {
  readonly now?: () => string;
}

export interface SessionRefs {
  readonly wip: string;
  readonly candidate: string;
}

const pathMatches = (path: string, pattern: string): boolean => {
  const normalizedPath = path.replace(/^\/+/, "");
  const normalizedPattern = pattern.replace(/^\/+/, "");
  let source = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      if (normalizedPattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u").test(normalizedPath);
};

const allowedPath = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => pathMatches(path, pattern));

export const sessionRefs = (
  projectId: string,
  sessionId: string,
  projectSlug = projectId,
): SessionRefs => {
  const slug =
    projectSlug
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "project";
  const identity = sessionId.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  const prefix = `agent/${slug}/${identity}`;
  return { wip: `${prefix}/wip`, candidate: `${prefix}/candidate` };
};

export const refsAreDistinct = (refs: SessionRefs): boolean => refs.wip !== refs.candidate;

export interface RepositoryGrantInput {
  readonly grantId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly repository: RepositoryIdentity;
  readonly baseCommit: string;
  readonly writablePaths: readonly string[];
  readonly expiresAt: string;
  readonly issuedAt?: string;
}

export const makeRepositoryGrant = (input: RepositoryGrantInput): RepositoryGrant => {
  const refs = sessionRefs(input.projectId, input.sessionId);
  return decode(RepositoryGrantSchema, {
    _tag: "RepositoryGrant",
    grantId: input.grantId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    repository: input.repository,
    baseCommit: input.baseCommit,
    writablePaths: [...input.writablePaths],
    wipRef: refs.wip,
    candidateRef: refs.candidate,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt ?? nowIso(),
  });
};

const grantIsValid = (grant: RepositoryGrant, sessionId: string, now: string): boolean =>
  grant.sessionId === sessionId && grant.expiresAt >= now;

const scopeOf = (grant: RepositoryGrant): readonly string[] => grant.writablePaths;

const repositoryOf = (grant: RepositoryGrant): RepositoryIdentity => grant.repository;

const baseOf = (grant: RepositoryGrant): string => grant.baseCommit;

/** Trusted publisher. All refs are derived from the grant; callers cannot select arbitrary refs. */
export class TrustedRepositoryPublisher {
  #transport: RepositoryTransport | undefined;
  #now: () => string;
  #published = new Map<string, CandidateReceipt>();
  #checkpoints = new Map<string, CheckpointReceipt>();

  constructor(
    transport: RepositoryTransport | undefined,
    options: RepositoryPublisherOptions = {},
  ) {
    this.#transport = transport;
    this.#now = options.now ?? nowIso;
  }

  #requireTransport(): RepositoryTransport {
    if (this.#transport === undefined)
      throw new ProviderUnavailableError("GitHub repository transport");
    return this.#transport;
  }

  #validateGrant(grant: RepositoryGrant, sessionId: string): RepositoryGrant {
    const decoded = decode(RepositoryGrantSchema, grant);
    if (!grantIsValid(decoded, sessionId, this.#now())) {
      throw new RepositoryGrantInvalidError(
        "Repository grant is expired or belongs to another Session",
      );
    }
    const refs = sessionRefs(decoded.projectId, sessionId);
    if (
      decoded.wipRef !== refs.wip ||
      decoded.candidateRef !== refs.candidate ||
      !refsAreDistinct(refs)
    ) {
      throw new RepositoryGrantInvalidError("Repository refs are not trusted derivations");
    }
    return decoded;
  }

  async checkout(
    grant: RepositoryGrant,
    sessionId: string,
    baseOrCheckpointCommit?: string,
  ): Promise<VerifiedWorkspace> {
    const value = this.#validateGrant(grant, sessionId);
    const commit = decode(CommitShaSchema, baseOrCheckpointCommit ?? baseOf(value));
    const transport = this.#requireTransport();
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(value),
      candidateCommit: commit,
      repository: repositoryOf(value),
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(commit, baseOf(value));
    return decode(VerifiedWorkspaceSchema, {
      _tag: "VerifiedWorkspace",
      grantId: value.grantId,
      sessionId,
      commit,
      workspaceRoot: "/workspace",
      verifiedAt: this.#now(),
    });
  }

  async checkpoint(
    grant: RepositoryGrant,
    sessionId: string,
    commit: string,
    expectedRemoteCommit: string,
  ): Promise<CheckpointReceipt> {
    const value = this.#validateGrant(grant, sessionId);
    const nextCommit = decode(CommitShaSchema, commit);
    const expectedCommit = decode(CommitShaSchema, expectedRemoteCommit);
    const key = `${value.grantId}\u0000${nextCommit}\u0000${expectedCommit}`;
    const existing = this.#checkpoints.get(key);
    if (existing !== undefined) return existing;
    const transport = this.#requireTransport();
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(value),
      candidateCommit: nextCommit,
      repository: repositoryOf(value),
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(nextCommit, baseOf(value));
    const outOfScope = verification.changedPaths.filter(
      (path) => !allowedPath(path, scopeOf(value)),
    );
    if (outOfScope.length > 0) throw new RepositoryScopeViolationError(outOfScope);
    const wipRef = value.wipRef;
    const observed = await transport.readRef(wipRef);
    const expectedObserved =
      observed.sha === undefined && expectedCommit === baseOf(value) ? undefined : expectedCommit;
    if (observed.sha !== expectedObserved) {
      throw new RepositoryConflictError(
        `WIP ref changed from ${expectedCommit} to ${observed.sha ?? "<absent>"}`,
      );
    }
    const updated = await transport.updateRef({
      ref: wipRef,
      expectedSha: observed.sha,
      nextSha: nextCommit,
      force: false,
    });
    if (updated.sha !== nextCommit)
      throw new RepositoryConflictError("GitHub did not acknowledge the checkpoint commit");
    const receipt = decode(CheckpointReceiptSchema, {
      _tag: "CheckpointReceipt",
      grantId: value.grantId,
      sessionId,
      commit: nextCommit,
      wipRef,
      expectedRemoteCommit: expectedCommit,
      acknowledgedAt: this.#now(),
    });
    this.#checkpoints.set(key, receipt);
    return receipt;
  }

  async publishCandidate(
    grant: RepositoryGrant,
    sessionId: string,
    candidateCommit: string,
  ): Promise<CandidateReceipt> {
    const value = this.#validateGrant(grant, sessionId);
    const nextCommit = decode(CommitShaSchema, candidateCommit);
    const key = `${value.grantId}\u0000${nextCommit}`;
    const existing = this.#published.get(key);
    if (existing !== undefined) return existing;
    const transport = this.#requireTransport();
    const repository = repositoryOf(value);
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(value),
      candidateCommit: nextCommit,
      repository,
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(nextCommit, baseOf(value));
    const outOfScope = verification.changedPaths.filter(
      (path) => !allowedPath(path, scopeOf(value)),
    );
    if (outOfScope.length > 0) throw new RepositoryScopeViolationError(outOfScope);
    const candidateRef = value.candidateRef;
    const observed = await transport.readRef(candidateRef);
    if (observed.sha !== undefined && observed.sha !== nextCommit) {
      throw new RepositoryConflictError(`Candidate ref already points to ${observed.sha}`);
    }
    const updated =
      observed.sha === nextCommit
        ? observed
        : await transport.updateRef({
            ref: candidateRef,
            expectedSha: observed.sha,
            nextSha: nextCommit,
            force: false,
          });
    if (updated.sha !== nextCommit)
      throw new RepositoryConflictError("GitHub did not acknowledge candidate commit");
    const candidateBranch = candidateRef;
    const candidateUrl = `https://github.com/${repository.owner}/${repository.name}/tree/${candidateRef}`;
    const receipt = decode(CandidateReceiptSchema, {
      _tag: "CandidateReceipt",
      grantId: value.grantId,
      sessionId,
      candidateCommit: nextCommit,
      candidateRef,
      candidateBranch,
      candidateUrl,
      publishedAt: this.#now(),
    });
    this.#published.set(key, receipt);
    return receipt;
  }
}

/** Fetcher-backed adapter. It never claims success when the Outbound Worker is absent. */
export class CloudflareRepositoryPublisher {
  #binding: Fetcher | undefined;
  #transport: TrustedRepositoryPublisher;

  constructor(binding: Fetcher | undefined, options: RepositoryPublisherOptions = {}) {
    this.#binding = binding;
    this.#transport = new TrustedRepositoryPublisher(
      binding === undefined ? undefined : new FetcherRepositoryTransport(binding),
      options,
    );
  }

  checkout(grant: RepositoryGrant, sessionId: string, baseOrCheckpointCommit?: string) {
    return this.#transport.checkout(grant, sessionId, baseOrCheckpointCommit);
  }

  checkpoint(
    grant: RepositoryGrant,
    sessionId: string,
    commit: string,
    expectedRemoteCommit: string,
  ) {
    return this.#transport.checkpoint(grant, sessionId, commit, expectedRemoteCommit);
  }

  publishCandidate(grant: RepositoryGrant, sessionId: string, candidateCommit: string) {
    return this.#transport.publishCandidate(grant, sessionId, candidateCommit);
  }

  get providerAvailable(): boolean {
    return this.#binding !== undefined;
  }
}

const providerResponseFailure = (operation: string): ProviderUnavailableError =>
  new ProviderUnavailableError(
    "GitHub repository transport",
    `Outbound Worker returned an invalid ${operation} response`,
  );

const decodeRefState = (value: unknown): GitRefState => {
  try {
    const decoded = decode(RepositoryRefStateSchema, value);
    return { sha: decoded.sha };
  } catch {
    throw providerResponseFailure("ref state");
  }
};

const decodeCandidateVerification = (value: unknown): GitCandidateVerification => {
  try {
    return decode(RepositoryCandidateVerificationSchema, value);
  } catch {
    throw providerResponseFailure("candidate verification");
  }
};

class FetcherRepositoryTransport implements RepositoryTransport {
  #binding: Fetcher;
  constructor(binding: Fetcher) {
    this.#binding = binding;
  }

  async #call(path: string, payload: unknown): Promise<unknown> {
    try {
      const response = await this.#binding.fetch(`https://outbound-git${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        throw new RepositoryConflictError(`Outbound Worker returned ${response.status}`);
      return await response.json();
    } catch (cause) {
      if (cause instanceof RepositoryConflictError) throw cause;
      throw new ProviderUnavailableError("GitHub repository transport");
    }
  }

  async readRef(ref: string): Promise<GitRefState> {
    return decodeRefState(await this.#call("/read-ref", { ref }));
  }

  async verifyCandidate(input: {
    readonly baseCommit: string;
    readonly candidateCommit: string;
    readonly repository: RepositoryIdentity;
  }): Promise<GitCandidateVerification> {
    return decodeCandidateVerification(await this.#call("/verify", input));
  }

  async updateRef(input: {
    readonly ref: string;
    readonly expectedSha: string | undefined;
    readonly nextSha: string;
    readonly force: false;
  }): Promise<GitRefState> {
    const state = decodeRefState(await this.#call("/update-ref", input));
    if (state.sha === undefined) throw providerResponseFailure("ref update");
    return state;
  }
}

export type { RepositoryPublisher } from "./contract.ts";
export type { CommitSha } from "./contract.ts";

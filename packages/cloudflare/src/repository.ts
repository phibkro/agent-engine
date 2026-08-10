import {
  RepositoryGrantSchema,
  decode,
  nowIso,
  record,
  requiredString,
  type CandidateReceipt,
  type CheckpointReceipt,
  type RepositoryGrant,
  type RepositoryIdentity,
  type VerifiedWorkspace,
} from "./contract.ts";
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

const asGrantRecord = (grant: RepositoryGrant): Record<string, unknown> => record(grant);

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

const grantIsValid = (grant: RepositoryGrant, sessionId: string, now: string): boolean => {
  const value = asGrantRecord(grant);
  return (
    value["sessionId"] === sessionId &&
    typeof value["expiresAt"] === "string" &&
    String(value["expiresAt"]) >= now
  );
};

const scopeOf = (grant: RepositoryGrant): readonly string[] => {
  const value = asGrantRecord(grant);
  const paths = value["writablePaths"];
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string")) {
    throw new RepositoryGrantInvalidError("Repository grant has no valid writable path scope");
  }
  return paths;
};

const repositoryOf = (grant: RepositoryGrant): RepositoryIdentity => {
  const value = asGrantRecord(grant)["repository"];
  const repository = record(value);
  return {
    owner: requiredString(repository["owner"], "grant.repository.owner"),
    name: requiredString(repository["name"], "grant.repository.name"),
  } as RepositoryIdentity;
};

const baseOf = (grant: RepositoryGrant): string =>
  requiredString(asGrantRecord(grant)["baseCommit"], "grant.baseCommit");

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

  #validateGrant(grant: RepositoryGrant, sessionId: string): Record<string, unknown> {
    const decoded = decode(RepositoryGrantSchema, grant);
    const value = asGrantRecord(decoded);
    if (!grantIsValid(decoded, sessionId, this.#now())) {
      throw new RepositoryGrantInvalidError(
        "Repository grant is expired or belongs to another Session",
      );
    }
    const refs = sessionRefs(requiredString(value["projectId"], "grant.projectId"), sessionId);
    if (
      value["wipRef"] !== refs.wip ||
      value["candidateRef"] !== refs.candidate ||
      !refsAreDistinct(refs)
    ) {
      throw new RepositoryGrantInvalidError("Repository refs are not trusted derivations");
    }
    return value;
  }

  async checkout(
    grant: RepositoryGrant,
    sessionId: string,
    baseOrCheckpointCommit?: string,
  ): Promise<VerifiedWorkspace> {
    const value = this.#validateGrant(grant, sessionId);
    const commit = baseOrCheckpointCommit ?? baseOf(grant);
    const transport = this.#requireTransport();
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(grant),
      candidateCommit: commit,
      repository: repositoryOf(grant),
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(commit, baseOf(grant));
    return {
      _tag: "VerifiedWorkspace",
      grantId: value["grantId"],
      sessionId,
      commit,
      workspaceRoot: "/workspace",
      verifiedAt: this.#now(),
    } as VerifiedWorkspace;
  }

  async checkpoint(
    grant: RepositoryGrant,
    sessionId: string,
    commit: string,
    expectedRemoteCommit: string,
  ): Promise<CheckpointReceipt> {
    const value = this.#validateGrant(grant, sessionId);
    const key = `${requiredString(value["grantId"], "grant.grantId")}\u0000${commit}\u0000${expectedRemoteCommit}`;
    const existing = this.#checkpoints.get(key);
    if (existing !== undefined) return existing;
    const transport = this.#requireTransport();
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(grant),
      candidateCommit: commit,
      repository: repositoryOf(grant),
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(commit, baseOf(grant));
    const outOfScope = verification.changedPaths.filter(
      (path) => !allowedPath(path, scopeOf(grant)),
    );
    if (outOfScope.length > 0) throw new RepositoryScopeViolationError(outOfScope);
    const wipRef = requiredString(value["wipRef"], "grant.wipRef");
    const observed = await transport.readRef(wipRef);
    const expectedObserved =
      observed.sha === undefined && expectedRemoteCommit === baseOf(grant)
        ? undefined
        : expectedRemoteCommit;
    if (observed.sha !== expectedObserved) {
      throw new RepositoryConflictError(
        `WIP ref changed from ${expectedRemoteCommit} to ${observed.sha ?? "<absent>"}`,
      );
    }
    const updated = await transport.updateRef({
      ref: wipRef,
      expectedSha: observed.sha,
      nextSha: commit,
      force: false,
    });
    const receipt = {
      _tag: "CheckpointReceipt",
      grantId: value["grantId"],
      sessionId,
      commit,
      wipRef,
      expectedRemoteCommit,
      acknowledgedAt: this.#now(),
    } as CheckpointReceipt;
    if (updated.sha !== commit)
      throw new RepositoryConflictError("GitHub did not acknowledge the checkpoint commit");
    this.#checkpoints.set(key, receipt);
    return receipt;
  }

  async publishCandidate(
    grant: RepositoryGrant,
    sessionId: string,
    candidateCommit: string,
  ): Promise<CandidateReceipt> {
    const value = this.#validateGrant(grant, sessionId);
    const grantId = requiredString(value["grantId"], "grant.grantId");
    const existing = this.#published.get(`${grantId}\u0000${candidateCommit}`);
    if (existing !== undefined) return existing;
    const transport = this.#requireTransport();
    const repository = repositoryOf(grant);
    const verification = await transport.verifyCandidate({
      baseCommit: baseOf(grant),
      candidateCommit,
      repository,
    });
    if (!verification.descendedFromBase)
      throw new RepositoryAncestryViolationError(candidateCommit, baseOf(grant));
    const outOfScope = verification.changedPaths.filter(
      (path) => !allowedPath(path, scopeOf(grant)),
    );
    if (outOfScope.length > 0) throw new RepositoryScopeViolationError(outOfScope);
    const candidateRef = requiredString(value["candidateRef"], "grant.candidateRef");
    const observed = await transport.readRef(candidateRef);
    if (observed.sha !== undefined && observed.sha !== candidateCommit) {
      throw new RepositoryConflictError(`Candidate ref already points to ${observed.sha}`);
    }
    const updated =
      observed.sha === candidateCommit
        ? observed
        : await transport.updateRef({
            ref: candidateRef,
            expectedSha: observed.sha,
            nextSha: candidateCommit,
            force: false,
          });
    if (updated.sha !== candidateCommit)
      throw new RepositoryConflictError("GitHub did not acknowledge candidate commit");
    const candidateBranch = candidateRef;
    const candidateUrl = `https://github.com/${repository.owner}/${repository.name}/tree/${candidateRef}`;
    const receipt = {
      _tag: "CandidateReceipt",
      grantId,
      sessionId,
      candidateCommit,
      candidateRef,
      candidateBranch,
      candidateUrl,
      publishedAt: this.#now(),
    } as CandidateReceipt;
    this.#published.set(`${grantId}\u0000${candidateCommit}`, receipt);
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

class FetcherRepositoryTransport implements RepositoryTransport {
  #binding: Fetcher;
  constructor(binding: Fetcher) {
    this.#binding = binding;
  }

  async #call(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.#binding.fetch(`https://outbound-git${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new RepositoryConflictError(`Outbound Worker returned ${response.status}`);
    return record(body);
  }

  async readRef(ref: string): Promise<GitRefState> {
    const body = await this.#call("/read-ref", { ref });
    return { sha: typeof body["sha"] === "string" ? body["sha"] : undefined };
  }

  async verifyCandidate(input: {
    readonly baseCommit: string;
    readonly candidateCommit: string;
    readonly repository: RepositoryIdentity;
  }): Promise<GitCandidateVerification> {
    const body = await this.#call("/verify", input);
    const paths = body["changedPaths"];
    return {
      descendedFromBase: body["descendedFromBase"] === true,
      changedPaths: Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === "string")
        : [],
      commitMetadata:
        typeof body["commitMetadata"] === "object" && body["commitMetadata"] !== null
          ? (body["commitMetadata"] as Record<string, unknown>)
          : {},
    };
  }

  async updateRef(input: {
    readonly ref: string;
    readonly expectedSha: string | undefined;
    readonly nextSha: string;
    readonly force: false;
  }): Promise<GitRefState> {
    const body = await this.#call("/update-ref", input);
    return { sha: typeof body["sha"] === "string" ? body["sha"] : input.nextSha };
  }
}

export type { RepositoryPublisher } from "./contract.ts";
export type { CommitSha } from "./contract.ts";

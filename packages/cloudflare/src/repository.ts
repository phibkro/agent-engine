import * as Schema from "effect/Schema";
import {
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CommitShaSchema,
  RepositoryGrantSchema,
  VerifiedWorkspaceSchema,
  decode,
  type CandidateReceipt,
  type CheckpointReceipt,
  type CommitSha,
  type RepositoryGrant,
  type RepositoryIdentity,
  type VerifiedWorkspace,
} from "./contract.ts";
import {
  CommitMetadataSchema,
  RepositoryIdentitySchema,
  RepositoryPathSchema,
  type CommitMetadata,
  type RepositoryPath,
} from "@work-engine/protocol";
import {
  ProviderUnavailableError,
  RepositoryAncestryViolationError,
  RepositoryConflictError,
  RepositoryGrantInvalidError,
  RepositoryScopeViolationError,
} from "./errors.ts";

const ProviderFailureCodeSchema = Schema.Literals(["conflict", "unavailable"] as const);
type ProviderFailureCode = typeof ProviderFailureCodeSchema.Type;

const ProviderFailureSchema = Schema.TaggedStruct("ProviderFailure", {
  code: ProviderFailureCodeSchema,
  reason: Schema.NonEmptyString,
});

const ReadRefRequestSchema = Schema.Struct({
  ref: Schema.NonEmptyString,
});
const ReadRefSucceededSchema = Schema.TaggedStruct("ReadRefSucceeded", {
  sha: Schema.optionalKey(CommitShaSchema),
});
const ReadRefResponseSchema = ReadRefSucceededSchema;

const VerifyCandidateRequestSchema = Schema.Struct({
  baseCommit: CommitShaSchema,
  candidateCommit: CommitShaSchema,
  repository: RepositoryIdentitySchema,
});
const VerifyCandidateSucceededSchema = Schema.TaggedStruct("VerifyCandidateSucceeded", {
  descendedFromBase: Schema.Boolean,
  changedPaths: Schema.Array(RepositoryPathSchema),
  commitMetadata: CommitMetadataSchema,
});

const UpdateRefRequestSchema = Schema.Struct({
  ref: Schema.NonEmptyString,
  expectedSha: Schema.optionalKey(CommitShaSchema),
  nextSha: CommitShaSchema,
  force: Schema.Literal(false),
});
const UpdateRefSucceededSchema = Schema.TaggedStruct("UpdateRefSucceeded", {
  sha: CommitShaSchema,
});

const ProviderFailureJsonSchema = Schema.fromJsonString(ProviderFailureSchema);
const ReadRefResponseJsonSchema = Schema.fromJsonString(ReadRefResponseSchema);
const VerifyCandidateSucceededJsonSchema = Schema.fromJsonString(VerifyCandidateSucceededSchema);
const UpdateRefSucceededJsonSchema = Schema.fromJsonString(UpdateRefSucceededSchema);

export interface GitRefState {
  readonly sha: CommitSha | undefined;
}

export interface GitCandidateVerification {
  readonly descendedFromBase: boolean;
  readonly changedPaths: readonly RepositoryPath[];
  readonly commitMetadata: CommitMetadata;
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
  readonly now: () => string;
}
export interface SessionRefs {
  readonly wip: string;
  readonly candidate: string;
}

const pathMatches = (path: string, pattern: string): boolean => {
  const normalizedPath = path.replace(/^\/+/u, "");
  const normalizedPattern = pattern.replace(/^\/+/u, "");
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
  return new RegExp(`${source}(?![\\s\\S])`, "u").test(normalizedPath);
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
  readonly issuedAt: string;
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
    issuedAt: input.issuedAt,
  });
};

const grantIsValid = (grant: RepositoryGrant, sessionId: string, now: string): boolean =>
  grant.sessionId === sessionId && grant.expiresAt >= now;

const scopeOf = (grant: RepositoryGrant): readonly string[] => grant.writablePaths;

const repositoryOf = (grant: RepositoryGrant): RepositoryIdentity => grant.repository;

const baseOf = (grant: RepositoryGrant): string => grant.baseCommit;
const verifiedCandidate = (
  candidateCommit: string,
  verification: GitCandidateVerification,
): GitCandidateVerification => {
  try {
    const commitMetadata = decode(CommitMetadataSchema, verification.commitMetadata);
    if (commitMetadata.sha !== candidateCommit) {
      throw new ProviderUnavailableError(
        "GitHub repository transport",
        "Outbound Worker returned an invalid candidate verification response",
      );
    }
    return {
      ...verification,
      changedPaths: verification.changedPaths.map((path) => decode(RepositoryPathSchema, path)),
      commitMetadata,
    };
  } catch (cause) {
    if (cause instanceof ProviderUnavailableError) throw cause;
    throw new ProviderUnavailableError(
      "GitHub repository transport",
      "Outbound Worker returned an invalid candidate verification response",
      cause,
    );
  }
};

/** Trusted publisher. All refs are derived from the grant; callers cannot select arbitrary refs. */
export class TrustedRepositoryPublisher {
  #transport: RepositoryTransport | undefined;
  #now: () => string;
  #published = new Map<string, CandidateReceipt>();
  #checkpoints = new Map<string, CheckpointReceipt>();

  constructor(transport: RepositoryTransport | undefined, options: RepositoryPublisherOptions) {
    this.#transport = transport;
    this.#now = options.now;
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
    const verification = verifiedCandidate(
      commit,
      await transport.verifyCandidate({
        baseCommit: baseOf(value),
        candidateCommit: commit,
        repository: repositoryOf(value),
      }),
    );
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
    const verification = verifiedCandidate(
      nextCommit,
      await transport.verifyCandidate({
        baseCommit: baseOf(value),
        candidateCommit: nextCommit,
        repository: repositoryOf(value),
      }),
    );
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
    const verification = verifiedCandidate(
      nextCommit,
      await transport.verifyCandidate({
        baseCommit: baseOf(value),
        candidateCommit: nextCommit,
        repository,
      }),
    );
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

  constructor(binding: Fetcher | undefined, options: RepositoryPublisherOptions) {
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

const providerResponseFailure = (operation: string, cause?: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError(
    "GitHub repository transport",
    `Outbound Worker returned an invalid ${operation} response`,
    cause,
  );

const unhandledProviderFailureCode = (_code: never): never => {
  throw new ProviderUnavailableError(
    "GitHub repository transport",
    "Outbound Worker returned an unsupported provider failure code",
  );
};

const mapProviderFailure = (code: ProviderFailureCode): never => {
  switch (code) {
    case "conflict":
      throw new RepositoryConflictError("Outbound repository operation conflicted");
    case "unavailable":
      throw new ProviderUnavailableError("GitHub repository transport");
    default:
      return unhandledProviderFailureCode(code);
  }
};

class FetcherRepositoryTransport implements RepositoryTransport {
  #binding: Fetcher;

  constructor(binding: Fetcher) {
    this.#binding = binding;
  }

  #decode<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    value: unknown,
    operation: string,
  ): S["Type"] {
    try {
      return decode(schema, value);
    } catch (cause) {
      throw providerResponseFailure(operation, cause);
    }
  }

  async #call<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    payload: string,
    schema: S,
    operation: string,
  ): Promise<S["Type"]> {
    let response: Response;
    try {
      response = await this.#binding.fetch(`https://outbound-git${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    } catch (cause) {
      throw new ProviderUnavailableError(
        "GitHub repository transport",
        "Outbound Worker request failed",
        cause,
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw providerResponseFailure("response", cause);
    }

    if (!response.ok) {
      const failure = this.#decode(ProviderFailureJsonSchema, body, "failure");
      return mapProviderFailure(failure.code);
    }
    return this.#decode(schema, body, operation);
  }

  async readRef(ref: string): Promise<GitRefState> {
    const request = decode(ReadRefRequestSchema, { ref });
    const payload = Schema.encodeSync(Schema.fromJsonString(ReadRefRequestSchema), {
      onExcessProperty: "error",
    })(request);
    const response = await this.#call("/read-ref", payload, ReadRefResponseJsonSchema, "read-ref");
    return { sha: response.sha };
  }

  async verifyCandidate(input: {
    readonly baseCommit: string;
    readonly candidateCommit: string;
    readonly repository: RepositoryIdentity;
  }): Promise<GitCandidateVerification> {
    const request = decode(VerifyCandidateRequestSchema, input);
    const payload = Schema.encodeSync(Schema.fromJsonString(VerifyCandidateRequestSchema), {
      onExcessProperty: "error",
    })(request);
    const response = await this.#call(
      "/verify",
      payload,
      VerifyCandidateSucceededJsonSchema,
      "candidate verification",
    );
    return verifiedCandidate(input.candidateCommit, {
      descendedFromBase: response.descendedFromBase,
      changedPaths: response.changedPaths,
      commitMetadata: response.commitMetadata,
    });
  }

  async updateRef(input: {
    readonly ref: string;
    readonly expectedSha: string | undefined;
    readonly nextSha: string;
    readonly force: false;
  }): Promise<GitRefState> {
    const request = decode(UpdateRefRequestSchema, {
      ref: input.ref,
      ...(input.expectedSha === undefined ? {} : { expectedSha: input.expectedSha }),
      nextSha: input.nextSha,
      force: input.force,
    });
    const payload = Schema.encodeSync(Schema.fromJsonString(UpdateRefRequestSchema), {
      onExcessProperty: "error",
    })(request);
    const response = await this.#call(
      "/update-ref",
      payload,
      UpdateRefSucceededJsonSchema,
      "ref update",
    );
    return { sha: response.sha };
  }
}

export type { RepositoryPublisher } from "./contract.ts";
export type { CommitSha } from "./contract.ts";

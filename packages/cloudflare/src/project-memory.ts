import type { DurableObjectState } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";
import {
  MemoryProposalIdSchema,
  NonEmptyStringSchema,
  ProjectIdSchema,
  ProjectMemoryAcceptRequestSchema,
  ProjectMemoryProposeRequestSchema,
  ProjectMemoryProposalModel,
  ProjectMemoryReadRequestSchema,
  ProjectMemoryReadResponseSchema,
  SchemaVersionSchema,
  SessionIdSchema,
  TimestampSchema,
} from "@work-engine/protocol";
import {
  MemoryRevisionSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProvenanceSchema,
  ProjectMemoryProposalSchema,
  ProjectMemoryRevisionSchema,
  decode,
  encode,
  type MemoryRevision,
  type PlatformCapabilities,
  type ProjectMemoryFact,
  type ProjectMemoryProposal,
  type ProjectMemoryProvenance,
  type ProjectMemoryRevision,
} from "./contract.ts";
import {
  CloudRuntimeError,
  InvalidRequestError,
  MemoryProposalNotFoundError,
  MemoryRevisionMismatchError,
  MemoryRevisionUnavailableError,
  MemoryUnauthorizedError,
  ProviderUnavailableError,
} from "./errors.ts";
import { cloudflarePlatformCapabilities } from "./platform-capabilities.ts";
const ProjectMemoryFailureSchema = Schema.Union([
  Schema.TaggedStruct("InvalidRequest", { reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("MemoryRevisionUnavailable", { reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("MemoryRevisionMismatch", { reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("MemoryProposalNotFound", { reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("MemoryUnauthorized", { reason: NonEmptyStringSchema }),
  Schema.TaggedStruct("ProviderUnavailable", { reason: NonEmptyStringSchema }),
]);

const MemoryRevisionRecordSchema = Schema.Struct({
  revision: MemoryRevisionSchema,
  facts: Schema.Array(ProjectMemoryFactSchema),
  acceptedAt: TimestampSchema,
});

const MemoryProposalRecordSchema = Schema.Struct({
  ...ProjectMemoryProposalModel.select.fields,
});
type MemoryProposalRecord = typeof MemoryProposalRecordSchema.Type;

type MemoryCapabilities = Pick<PlatformCapabilities, "now" | "uuid">;

const memoryProposalId = (capabilities: MemoryCapabilities): MemoryProposalRecord["proposalId"] =>
  decode(MemoryProposalIdSchema, `mpp_${capabilities.uuid().toLowerCase()}`);

const factId = (capabilities: MemoryCapabilities): string =>
  decode(NonEmptyStringSchema, `fact_${capabilities.uuid().toLowerCase()}`);

export const ProjectMemorySnapshotSchema = Schema.TaggedStruct("ProjectMemorySnapshot", {
  schemaVersion: SchemaVersionSchema,
  projectId: ProjectIdSchema,
  currentRevision: MemoryRevisionSchema,
  revisions: Schema.Array(MemoryRevisionRecordSchema),
  proposals: Schema.Array(MemoryProposalRecordSchema),
}).check(
  Schema.makeFilter((snapshot) => {
    const first = snapshot.revisions[0];
    const last = snapshot.revisions[snapshot.revisions.length - 1];
    if (first === undefined || first.revision !== 0) {
      return "Project Memory snapshots must start at revision zero";
    }
    if (last === undefined || last.revision !== snapshot.currentRevision) {
      return "Project Memory currentRevision must match the latest revision";
    }
    for (const [index, revision] of snapshot.revisions.entries()) {
      if (revision.revision !== index) return "Project Memory revisions must be contiguous";
    }
    if (
      snapshot.proposals.some((proposal) => proposal.expectedRevision > snapshot.currentRevision)
    ) {
      return "Project Memory proposals cannot target a future revision";
    }
    return true;
  }),
);
export type ProjectMemorySnapshot = typeof ProjectMemorySnapshotSchema.Type;

const clone = (snapshot: ProjectMemorySnapshot): ProjectMemorySnapshot =>
  decode(ProjectMemorySnapshotSchema, {
    ...snapshot,
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      facts: revision.facts.map((fact) => ({ ...fact })),
    })),
    proposals: snapshot.proposals.map((proposal) => ({
      ...proposal,
      provenance: { ...proposal.provenance },
    })),
  });

const initialSnapshot = (
  projectId: string,
  capabilities: MemoryCapabilities,
): ProjectMemorySnapshot =>
  decode(ProjectMemorySnapshotSchema, {
    _tag: "ProjectMemorySnapshot",
    schemaVersion: "work-engine/v2",
    projectId,
    currentRevision: 0,
    revisions: [{ revision: 0, facts: [], acceptedAt: capabilities.now() }],
    proposals: [],
  });

const makeFact = (
  claim: string,
  provenance: ProjectMemoryProvenance,
  capabilities: MemoryCapabilities,
): ProjectMemoryFact =>
  decode(ProjectMemoryFactSchema, {
    _tag: "ProjectMemoryFact",
    factId: factId(capabilities),
    claim,
    provenance,
    acceptedAt: capabilities.now(),
  });

const makeProposal = (
  proposalId: MemoryProposalRecord["proposalId"],
  expectedRevision: MemoryRevision,
  claim: string,
  provenance: ProjectMemoryProvenance,
  capabilities: MemoryCapabilities,
): ProjectMemoryProposal =>
  decode(ProjectMemoryProposalSchema, {
    _tag: "ProjectMemoryProposal",
    proposalId,
    expectedRevision,
    claim,
    provenance,
    proposedAt: capabilities.now(),
  });

const makeRevision = (
  projectId: ProjectMemorySnapshot["projectId"],
  revision: MemoryRevision,
  previousRevision: MemoryRevision | undefined,
  facts: readonly ProjectMemoryFact[],
  acceptedProposalId: MemoryProposalRecord["proposalId"],
  capabilities: MemoryCapabilities,
): ProjectMemoryRevision =>
  decode(ProjectMemoryRevisionSchema, {
    _tag: "ProjectMemoryRevision",
    projectId,
    memoryRevision: revision,
    facts,
    acceptedProposalId,
    acceptedAt: capabilities.now(),
    ...(previousRevision === undefined ? {} : { previousRevision }),
  });

/** Single authority for accepted Project facts. It intentionally has no session identity in reads. */
export class ProjectMemoryState {
  #snapshot: ProjectMemorySnapshot;
  #capabilities: MemoryCapabilities;

  constructor(
    projectId: string,
    capabilities: MemoryCapabilities,
    snapshot?: ProjectMemorySnapshot,
  ) {
    const decodedProjectId = decode(ProjectIdSchema, projectId);
    const decodedSnapshot =
      snapshot === undefined ? undefined : decode(ProjectMemorySnapshotSchema, snapshot);
    this.#capabilities = capabilities;
    if (decodedSnapshot !== undefined && decodedSnapshot.projectId !== decodedProjectId) {
      throw new InvalidRequestError("Project Memory snapshot belongs to another project");
    }
    this.#snapshot =
      decodedSnapshot === undefined
        ? initialSnapshot(decodedProjectId, capabilities)
        : clone(decodedSnapshot);
  }

  get snapshot(): ProjectMemorySnapshot {
    return clone(this.#snapshot);
  }

  get projectId(): ProjectMemorySnapshot["projectId"] {
    return this.#snapshot.projectId;
  }

  get currentRevision(): MemoryRevision {
    return this.#snapshot.currentRevision;
  }

  readContext(atRevision: MemoryRevision, query = ""): readonly ProjectMemoryFact[] {
    const requested = atRevision;
    const revision = this.#snapshot.revisions.find((entry) => entry.revision === requested);
    if (revision === undefined) throw new MemoryRevisionUnavailableError(this.projectId, requested);
    const normalizedQuery = query.trim().toLowerCase();
    return revision.facts.filter(
      (fact) => normalizedQuery.length === 0 || fact.claim.toLowerCase().includes(normalizedQuery),
    );
  }

  proposeMemory(
    sessionId: string,
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: ProjectMemoryProvenance,
  ): ProjectMemoryProposal {
    const decodedSessionId = decode(SessionIdSchema, sessionId);
    const decodedClaim = decode(NonEmptyStringSchema, claim);
    const expected = expectedRevision;
    if (expected > this.#snapshot.currentRevision) {
      throw new MemoryRevisionUnavailableError(this.projectId, expected);
    }
    const decodedProvenance = decode(ProjectMemoryProvenanceSchema, provenance);
    const proposal = decode(MemoryProposalRecordSchema, {
      _tag: "ProjectMemoryProposal",
      proposalId: memoryProposalId(this.#capabilities),
      expectedRevision: expected,
      claim: decodedClaim,
      provenance: decodedProvenance,
      proposedAt: this.#capabilities.now(),
      sessionId: decodedSessionId,
    });
    const nextSnapshot = decode(ProjectMemorySnapshotSchema, {
      ...this.#snapshot,
      proposals: [...this.#snapshot.proposals, proposal],
    });
    this.#snapshot = nextSnapshot;
    return makeProposal(
      proposal.proposalId,
      proposal.expectedRevision,
      proposal.claim,
      proposal.provenance,
      this.#capabilities,
    );
  }

  acceptMemory(proposalId: string, expectedRevision: MemoryRevision): ProjectMemoryRevision {
    const expected = expectedRevision;
    const proposal = this.#snapshot.proposals.find((entry) => entry.proposalId === proposalId);
    if (proposal === undefined) throw new MemoryProposalNotFoundError(proposalId);
    if (expected !== this.#snapshot.currentRevision || proposal.expectedRevision !== expected) {
      throw new MemoryRevisionMismatchError(expected, this.#snapshot.currentRevision);
    }
    const nextRevision = decode(MemoryRevisionSchema, this.#snapshot.currentRevision + 1);
    const fact = makeFact(proposal.claim, proposal.provenance, this.#capabilities);
    const prior = this.#snapshot.revisions[this.#snapshot.revisions.length - 1];
    const nextFacts = [...(prior?.facts ?? []), fact];
    const nextRevisionRecord = decode(MemoryRevisionRecordSchema, {
      revision: nextRevision,
      facts: nextFacts,
      acceptedAt: this.#capabilities.now(),
    });
    const previousRevision =
      this.#snapshot.revisions.length > 1
        ? decode(MemoryRevisionSchema, nextRevision - 1)
        : undefined;
    const nextSnapshot = decode(ProjectMemorySnapshotSchema, {
      ...this.#snapshot,
      currentRevision: nextRevision,
      revisions: [...this.#snapshot.revisions, nextRevisionRecord],
      proposals: this.#snapshot.proposals.filter((entry) => entry.proposalId !== proposalId),
    });
    this.#snapshot = nextSnapshot;
    return makeRevision(
      this.projectId,
      nextRevision,
      previousRevision,
      nextFacts,
      proposal.proposalId,
      this.#capabilities,
    );
  }
}

export interface ProjectMemoryStore {
  load(): Promise<ProjectMemorySnapshot | undefined>;
  save(snapshot: ProjectMemorySnapshot): Promise<void>;
}

export class DurableObjectProjectMemoryStore implements ProjectMemoryStore {
  #state: DurableObjectState;
  #projectId: string;

  constructor(state: DurableObjectState, projectId: string) {
    this.#state = state;
    this.#projectId = projectId;
  }

  async load(): Promise<ProjectMemorySnapshot | undefined> {
    const stored: unknown = await this.#state.storage.get("memory");
    return stored === undefined ? undefined : decode(ProjectMemorySnapshotSchema, stored);
  }

  async save(snapshot: ProjectMemorySnapshot): Promise<void> {
    const decoded = decode(ProjectMemorySnapshotSchema, snapshot);
    await this.#state.storage.put("memory", encode(ProjectMemorySnapshotSchema, decoded));
  }

  get projectId(): string {
    return this.#projectId;
  }
}

export class ProjectMemoryDurableObject implements DurableObject {
  #state: DurableObjectState;
  #memory: ProjectMemoryState | undefined;
  #capabilities: MemoryCapabilities;

  #coordinatorSecret: string | undefined;

  constructor(
    state: DurableObjectState,
    env: { readonly PROJECT_MEMORY_COORDINATOR_SECRET?: string },
    capabilities: MemoryCapabilities = cloudflarePlatformCapabilities,
  ) {
    this.#state = state;
    this.#capabilities = capabilities;
    this.#coordinatorSecret = env.PROJECT_MEMORY_COORDINATOR_SECRET;
  }

  async #load(projectId: string): Promise<ProjectMemoryState> {
    const decodedProjectId = decode(ProjectIdSchema, projectId);
    if (this.#memory !== undefined) {
      if (this.#memory.projectId !== decodedProjectId) throw new MemoryUnauthorizedError();
      return this.#memory;
    }
    const stored: unknown = await this.#state.storage.get("memory");
    const snapshot = stored === undefined ? undefined : decode(ProjectMemorySnapshotSchema, stored);
    this.#memory = new ProjectMemoryState(decodedProjectId, this.#capabilities, snapshot);
    return this.#memory;
  }

  async #save(memory: ProjectMemoryState): Promise<void> {
    const snapshot = decode(ProjectMemorySnapshotSchema, memory.snapshot);
    await this.#state.storage.put("memory", encode(ProjectMemorySnapshotSchema, snapshot));
    this.#memory = memory;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const projectIdHeader = request.headers.get("X-Project-Identity");
      if (projectIdHeader === null) throw new MemoryUnauthorizedError();
      const projectId = decode(ProjectIdSchema, projectIdHeader);
      const memory = await this.#load(projectId);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/read")) {
        const raw: unknown = await request.json();
        const input = decode(ProjectMemoryReadRequestSchema, raw);
        const response = decode(ProjectMemoryReadResponseSchema, {
          _tag: "ProjectMemoryRead",
          facts: memory.readContext(input.atRevision, input.query),
        });
        return Response.json(response);
      }
      const raw: unknown = await request.json();
      if (url.pathname.endsWith("/propose")) {
        const input = decode(ProjectMemoryProposeRequestSchema, raw);
        const sessionHeader = request.headers.get("X-Cloud-Task-Session");
        if (sessionHeader === null) throw new MemoryUnauthorizedError();
        const sessionId = decode(SessionIdSchema, sessionHeader);
        const nextMemory = new ProjectMemoryState(projectId, this.#capabilities, memory.snapshot);
        const proposal = nextMemory.proposeMemory(
          sessionId,
          input.expectedRevision,
          input.claim,
          input.provenance,
        );
        await this.#save(nextMemory);
        return Response.json(proposal);
      }
      if (url.pathname.endsWith("/accept")) {
        const input = decode(ProjectMemoryAcceptRequestSchema, raw);
        const presented = request.headers.get("X-Project-Memory-Coordinator");
        if (
          this.#coordinatorSecret === undefined ||
          presented === null ||
          presented !== this.#coordinatorSecret
        ) {
          throw new MemoryUnauthorizedError();
        }
        const nextMemory = new ProjectMemoryState(projectId, this.#capabilities, memory.snapshot);
        const revision = nextMemory.acceptMemory(input.proposalId, input.expectedRevision);
        await this.#save(nextMemory);
        return Response.json(revision);
      }
      throw new InvalidRequestError("Unknown Project Memory operation");
    } catch (cause) {
      return projectMemoryErrorResponse(cause);
    }
  }
}

const projectMemoryErrorResponse = (cause: unknown): Response => {
  const status =
    cause instanceof MemoryRevisionMismatchError || cause instanceof MemoryRevisionUnavailableError
      ? 409
      : cause instanceof MemoryUnauthorizedError
        ? 403
        : cause instanceof ProviderUnavailableError
          ? 503
          : 400;
  const tag =
    cause instanceof MemoryRevisionMismatchError
      ? "MemoryRevisionMismatch"
      : cause instanceof MemoryRevisionUnavailableError
        ? "MemoryRevisionUnavailable"
        : cause instanceof MemoryProposalNotFoundError
          ? "MemoryProposalNotFound"
          : cause instanceof MemoryUnauthorizedError
            ? "MemoryUnauthorized"
            : cause instanceof ProviderUnavailableError
              ? "ProviderUnavailable"
              : "InvalidRequest";
  const body = decode(ProjectMemoryFailureSchema, {
    _tag: tag,
    reason: "Project Memory request failed",
  });
  return Response.json(body, { status });
};

/** Session-facing binding; projectId/sessionId are constructor authority, never request fields. */
export class SessionProjectMemoryBinding {
  #memory: ProjectMemoryState;
  #sessionId: string;

  constructor(memory: ProjectMemoryState, sessionId: string) {
    this.#memory = memory;
    this.#sessionId = sessionId;
  }

  readContext(atRevision: MemoryRevision, query = ""): readonly ProjectMemoryFact[] {
    return this.#memory.readContext(atRevision, query);
  }

  proposeMemory(
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: ProjectMemoryProvenance,
  ): ProjectMemoryProposal {
    return this.#memory.proposeMemory(this.#sessionId, expectedRevision, claim, provenance);
  }

  acceptMemory(): ProjectMemoryRevision {
    throw new MemoryUnauthorizedError();
  }
}

/** Coordinator-only binding. It does not expose Session-facing proposal attribution. */
export class CoordinatorProjectMemoryBinding {
  #memory: ProjectMemoryState;

  constructor(memory: ProjectMemoryState) {
    this.#memory = memory;
  }

  acceptMemory(proposalId: string, expectedRevision: MemoryRevision): ProjectMemoryRevision {
    return this.#memory.acceptMemory(proposalId, expectedRevision);
  }
}

/** Production adapter; missing Durable Object binding is an explicit typed failure. */
export class CloudflareProjectMemory {
  #namespace: DurableObjectNamespace | undefined;
  #projectId: typeof ProjectIdSchema.Type;
  #sessionId: string | undefined;
  #coordinatorSecret: string | undefined;

  constructor(
    namespace: DurableObjectNamespace | undefined,
    projectId: string,
    options: {
      readonly sessionId?: string;
      readonly coordinatorSecret?: string;
    } = {},
  ) {
    this.#namespace = namespace;
    this.#projectId = decode(ProjectIdSchema, projectId);
    this.#sessionId =
      options.sessionId === undefined ? undefined : decode(SessionIdSchema, options.sessionId);
    this.#coordinatorSecret = options.coordinatorSecret;
  }

  async #call<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    body: object,
    responseSchema: S,
  ): Promise<S["Type"]> {
    if (this.#namespace === undefined)
      throw new ProviderUnavailableError("Project Memory Durable Object");
    const stub = this.#namespace.getByName(this.#projectId);
    const headers = new Headers({
      "content-type": "application/json",
      "X-Project-Identity": this.#projectId,
    });
    if (this.#sessionId !== undefined) headers.set("X-Cloud-Task-Session", this.#sessionId);
    if (this.#coordinatorSecret !== undefined) {
      headers.set("X-Project-Memory-Coordinator", this.#coordinatorSecret);
    }
    const response = await stub.fetch(`https://project-memory${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      let failure: typeof ProjectMemoryFailureSchema.Type;
      try {
        failure = decode(ProjectMemoryFailureSchema, value);
      } catch {
        throw new ProviderUnavailableError(
          "Project Memory Durable Object",
          "invalid failure response",
        );
      }
      if (failure._tag === "ProviderUnavailable") {
        throw new ProviderUnavailableError("Project Memory Durable Object", failure.reason);
      }
      if (failure._tag === "InvalidRequest") throw new InvalidRequestError(failure.reason);
      throw new CloudRuntimeError(failure._tag, failure.reason);
    }
    return decode(responseSchema, value);
  }

  async readContext(atRevision: MemoryRevision, query = ""): Promise<readonly ProjectMemoryFact[]> {
    const request = decode(ProjectMemoryReadRequestSchema, { atRevision, query });
    const response = await this.#call("/read", request, ProjectMemoryReadResponseSchema);
    return response.facts;
  }

  async proposeMemory(
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: ProjectMemoryProvenance,
  ): Promise<ProjectMemoryProposal> {
    if (this.#sessionId === undefined || this.#coordinatorSecret !== undefined) {
      throw new MemoryUnauthorizedError();
    }
    const request = decode(ProjectMemoryProposeRequestSchema, {
      expectedRevision,
      claim,
      provenance,
    });
    return this.#call("/propose", request, ProjectMemoryProposalSchema);
  }

  async acceptMemory(
    proposalId: string,
    expectedRevision: MemoryRevision,
  ): Promise<ProjectMemoryRevision> {
    if (this.#coordinatorSecret === undefined) throw new MemoryUnauthorizedError();
    const request = decode(ProjectMemoryAcceptRequestSchema, { proposalId, expectedRevision });
    return this.#call("/accept", request, ProjectMemoryRevisionSchema);
  }
}

export type { RuntimeProjectMemory } from "./contract.ts";

import type { DurableObjectState } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";
import {
  NonEmptyStringSchema,
  ProjectIdSchema,
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
  newId,
  nowIso,
  record,
  requiredString,
  type MemoryRevision,
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

const MemoryRevisionRecordSchema = Schema.Struct({
  revision: MemoryRevisionSchema,
  facts: Schema.Array(ProjectMemoryFactSchema),
  acceptedAt: TimestampSchema,
});

const MemoryProposalRecordSchema = Schema.Struct({
  ...ProjectMemoryProposalSchema.fields,
  sessionId: SessionIdSchema,
  createdAt: TimestampSchema,
});
type MemoryProposalRecord = typeof MemoryProposalRecordSchema.Type;

export const ProjectMemorySnapshotSchema = Schema.Struct({
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

const initialSnapshot = (projectId: string): ProjectMemorySnapshot =>
  decode(ProjectMemorySnapshotSchema, {
    projectId,
    currentRevision: 0,
    revisions: [{ revision: 0, facts: [], acceptedAt: nowIso() }],
    proposals: [],
  });

const revisionValue = (revision: unknown): MemoryRevision => decode(MemoryRevisionSchema, revision);

const makeFact = (claim: string, provenance: ProjectMemoryProvenance): ProjectMemoryFact =>
  decode(ProjectMemoryFactSchema, {
    _tag: "ProjectMemoryFact",
    factId: newId("fact_"),
    claim,
    provenance,
    acceptedAt: nowIso(),
  });

const makeProposal = (
  proposalId: MemoryProposalRecord["proposalId"],
  expectedRevision: MemoryRevision,
  claim: string,
  provenance: ProjectMemoryProvenance,
): ProjectMemoryProposal =>
  decode(ProjectMemoryProposalSchema, {
    _tag: "ProjectMemoryProposal",
    proposalId,
    expectedRevision,
    claim,
    provenance,
    proposedAt: nowIso(),
  });

const makeRevision = (
  projectId: ProjectMemorySnapshot["projectId"],
  revision: MemoryRevision,
  previousRevision: MemoryRevision | undefined,
  facts: readonly ProjectMemoryFact[],
  acceptedProposalId: MemoryProposalRecord["proposalId"],
): ProjectMemoryRevision =>
  decode(ProjectMemoryRevisionSchema, {
    _tag: "ProjectMemoryRevision",
    projectId,
    memoryRevision: revision,
    facts,
    acceptedProposalId,
    acceptedAt: nowIso(),
    ...(previousRevision === undefined ? {} : { previousRevision }),
  });

/** Single authority for accepted Project facts. It intentionally has no session identity in reads. */
export class ProjectMemoryState {
  #snapshot: ProjectMemorySnapshot;

  constructor(projectId: string, snapshot?: ProjectMemorySnapshot) {
    const decodedProjectId = decode(ProjectIdSchema, projectId);
    const decodedSnapshot =
      snapshot === undefined ? undefined : decode(ProjectMemorySnapshotSchema, snapshot);
    if (decodedSnapshot !== undefined && decodedSnapshot.projectId !== decodedProjectId) {
      throw new InvalidRequestError("Project Memory snapshot belongs to another project");
    }
    this.#snapshot =
      decodedSnapshot === undefined ? initialSnapshot(decodedProjectId) : clone(decodedSnapshot);
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
    const requested = revisionValue(atRevision);
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
    provenance: unknown,
  ): ProjectMemoryProposal {
    const decodedSessionId = decode(SessionIdSchema, sessionId);
    const decodedClaim = decode(NonEmptyStringSchema, claim);
    const expected = revisionValue(expectedRevision);
    if (expected > this.#snapshot.currentRevision) {
      throw new MemoryRevisionUnavailableError(this.projectId, expected);
    }
    const decodedProvenance = decode(ProjectMemoryProvenanceSchema, provenance);
    const proposal = decode(MemoryProposalRecordSchema, {
      _tag: "ProjectMemoryProposal",
      proposalId: newId("mpp_"),
      expectedRevision: expected,
      claim: decodedClaim,
      provenance: decodedProvenance,
      proposedAt: nowIso(),
      sessionId: decodedSessionId,
      createdAt: nowIso(),
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
    );
  }

  acceptMemory(proposalId: string, expectedRevision: MemoryRevision): ProjectMemoryRevision {
    const expected = revisionValue(expectedRevision);
    const proposal = this.#snapshot.proposals.find((entry) => entry.proposalId === proposalId);
    if (proposal === undefined) throw new MemoryProposalNotFoundError(proposalId);
    if (expected !== this.#snapshot.currentRevision || proposal.expectedRevision !== expected) {
      throw new MemoryRevisionMismatchError(expected, this.#snapshot.currentRevision);
    }
    const nextRevision = decode(MemoryRevisionSchema, this.#snapshot.currentRevision + 1);
    const fact = makeFact(proposal.claim, proposal.provenance);
    const prior = this.#snapshot.revisions[this.#snapshot.revisions.length - 1];
    const nextFacts = [...(prior?.facts ?? []), fact];
    const nextRevisionRecord = decode(MemoryRevisionRecordSchema, {
      revision: nextRevision,
      facts: nextFacts,
      acceptedAt: nowIso(),
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

  #coordinatorSecret: string | undefined;

  constructor(
    state: DurableObjectState,
    env: { readonly PROJECT_MEMORY_COORDINATOR_SECRET?: string },
  ) {
    this.#state = state;
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
    this.#memory = new ProjectMemoryState(decodedProjectId, snapshot);
    return this.#memory;
  }

  async #save(memory: ProjectMemoryState): Promise<void> {
    const snapshot = decode(ProjectMemorySnapshotSchema, memory.snapshot);
    await this.#state.storage.put("memory", encode(ProjectMemorySnapshotSchema, snapshot));
    this.#memory = memory;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const projectId = request.headers.get("X-Project-Identity");
      if (projectId === null || projectId.length === 0) throw new MemoryUnauthorizedError();
      const memory = await this.#load(projectId);
      const url = new URL(request.url);
      const payload: unknown = request.method === "GET" ? undefined : await request.json();
      const body = payload === undefined ? {} : record(payload);
      if (url.pathname.endsWith("/read")) {
        const facts = memory.readContext(
          revisionValue(body["atRevision"]),
          typeof body["query"] === "string" ? body["query"] : "",
        );
        return Response.json({ _tag: "ProjectMemoryRead", facts });
      }
      if (url.pathname.endsWith("/propose")) {
        const sessionId = request.headers.get("X-Cloud-Task-Session");
        if (sessionId === null || sessionId.length === 0) throw new MemoryUnauthorizedError();
        const nextMemory = new ProjectMemoryState(projectId, memory.snapshot);
        const proposal = nextMemory.proposeMemory(
          sessionId,
          revisionValue(body["expectedRevision"]),
          requiredString(body["claim"], "claim"),
          body["provenance"],
        );
        await this.#save(nextMemory);
        return Response.json(proposal);
      }
      if (url.pathname.endsWith("/accept")) {
        const presented = request.headers.get("X-Project-Memory-Coordinator");
        if (
          this.#coordinatorSecret === undefined ||
          presented === null ||
          presented !== this.#coordinatorSecret
        ) {
          throw new MemoryUnauthorizedError();
        }
        const nextMemory = new ProjectMemoryState(projectId, memory.snapshot);
        const revision = nextMemory.acceptMemory(
          requiredString(body["proposalId"], "proposalId"),
          revisionValue(body["expectedRevision"]),
        );
        await this.#save(nextMemory);
        return Response.json(revision);
      }
      return Response.json(
        { _tag: "InvalidRequest", reason: "Unknown Project Memory operation" },
        { status: 400 },
      );
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
        : 400;
  const body =
    cause instanceof CloudRuntimeError
      ? { _tag: cause._tag, reason: cause.message, details: cause.details }
      : { _tag: "UnknownError", reason: String(cause) };
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
    provenance: unknown,
  ): ProjectMemoryProposal {
    return this.#memory.proposeMemory(this.#sessionId, expectedRevision, claim, provenance);
  }

  acceptMemory(): never {
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
  #projectId: string;
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
    this.#projectId = projectId;
    this.#sessionId = options.sessionId;
    this.#coordinatorSecret = options.coordinatorSecret;
  }

  async #call(path: string, body: Record<string, unknown>): Promise<unknown> {
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
      const details = record(value);
      const tag = details["_tag"];
      const reason = String(details["reason"] ?? response.status);
      const errorDetails =
        typeof details["details"] === "object" && details["details"] !== null
          ? record(details["details"])
          : {};
      if (
        tag === "MemoryRevisionMismatch" ||
        tag === "MemoryRevisionUnavailable" ||
        tag === "MemoryProposalNotFound" ||
        tag === "MemoryUnauthorized"
      ) {
        throw new CloudRuntimeError(tag, reason, errorDetails);
      }
      throw new ProviderUnavailableError("Project Memory Durable Object", reason);
    }
    return value;
  }

  readContext(atRevision: MemoryRevision, query = ""): Promise<unknown> {
    return this.#call("/read", { atRevision, query });
  }

  proposeMemory(
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: unknown,
  ): Promise<unknown> {
    if (this.#sessionId === undefined || this.#coordinatorSecret !== undefined) {
      throw new MemoryUnauthorizedError();
    }
    return this.#call("/propose", { expectedRevision, claim, provenance });
  }

  acceptMemory(proposalId: string, expectedRevision: MemoryRevision): Promise<unknown> {
    if (this.#coordinatorSecret === undefined) throw new MemoryUnauthorizedError();
    return this.#call("/accept", { proposalId, expectedRevision });
  }
}

export type { RuntimeProjectMemory } from "./contract.ts";

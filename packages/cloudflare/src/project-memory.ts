import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  MemoryRevisionSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProvenanceSchema,
  ProjectMemoryProposalSchema,
  ProjectMemoryRevisionSchema,
  decode,
  newId,
  nowIso,
  record,
  requiredString,
  type MemoryRevision,
  type ProjectMemoryFact,
  type ProjectMemoryProposal,
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

interface MemoryRevisionRecord {
  readonly revision: number;
  readonly facts: readonly Record<string, unknown>[];
  readonly acceptedAt: string;
}

interface MemoryProposalRecord {
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly claim: string;
  readonly provenance: Record<string, unknown>;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface ProjectMemorySnapshot {
  readonly projectId: string;
  readonly currentRevision: number;
  readonly revisions: readonly MemoryRevisionRecord[];
  readonly proposals: readonly MemoryProposalRecord[];
}

const clone = (snapshot: ProjectMemorySnapshot): ProjectMemorySnapshot => ({
  projectId: snapshot.projectId,
  currentRevision: snapshot.currentRevision,
  revisions: snapshot.revisions.map((revision) => ({
    ...revision,
    facts: revision.facts.map((fact) => ({ ...fact })),
  })),
  proposals: snapshot.proposals.map((proposal) => ({
    ...proposal,
    provenance: { ...proposal.provenance },
  })),
});

const initialSnapshot = (projectId: string): ProjectMemorySnapshot => ({
  projectId,
  currentRevision: 0,
  revisions: [{ revision: 0, facts: [], acceptedAt: nowIso() }],
  proposals: [],
});

const revisionValue = (revision: unknown): number => {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new InvalidRequestError("memoryRevision must be a non-negative integer");
  }
  return revision;
};

const makeFact = (claim: string, provenance: Record<string, unknown>): Record<string, unknown> => ({
  _tag: "ProjectMemoryFact",
  factId: newId("fact_"),
  claim,
  provenance,
  acceptedAt: nowIso(),
});

const makeProposal = (
  proposalId: string,
  expectedRevision: number,
  claim: string,
  provenance: Record<string, unknown>,
): Record<string, unknown> => ({
  _tag: "ProjectMemoryProposal",
  proposalId,
  expectedRevision,
  claim,
  provenance,
  proposedAt: nowIso(),
});

const makeRevision = (
  projectId: string,
  revision: number,
  previousRevision: number | undefined,
  facts: readonly Record<string, unknown>[],
  acceptedProposalId: string,
): Record<string, unknown> => {
  const value: Record<string, unknown> = {
    _tag: "ProjectMemoryRevision",
    projectId,
    memoryRevision: revision,
    facts,
    acceptedProposalId,
    acceptedAt: nowIso(),
  };
  if (previousRevision !== undefined) value["previousRevision"] = previousRevision;
  return value;
};

/** Single authority for accepted Project facts. It intentionally has no session identity in reads. */
export class ProjectMemoryState {
  #snapshot: ProjectMemorySnapshot;

  constructor(projectId: string, snapshot?: ProjectMemorySnapshot) {
    if (projectId.length === 0) throw new InvalidRequestError("projectId cannot be empty");
    this.#snapshot = snapshot === undefined ? initialSnapshot(projectId) : clone(snapshot);
    if (this.#snapshot.projectId !== projectId) {
      throw new InvalidRequestError("Project Memory snapshot belongs to another project");
    }
  }

  get snapshot(): ProjectMemorySnapshot {
    return clone(this.#snapshot);
  }

  get projectId(): string {
    return this.#snapshot.projectId;
  }

  get currentRevision(): MemoryRevision {
    return this.#snapshot.currentRevision as MemoryRevision;
  }

  readContext(atRevision: MemoryRevision, query = ""): readonly ProjectMemoryFact[] {
    const requested = revisionValue(atRevision);
    const revision = this.#snapshot.revisions.find((entry) => entry.revision === requested);
    if (revision === undefined) throw new MemoryRevisionUnavailableError(this.projectId, requested);
    const normalizedQuery = query.trim().toLowerCase();
    return revision.facts
      .filter((fact) => {
        if (normalizedQuery.length === 0) return true;
        const claim = typeof fact["claim"] === "string" ? fact["claim"].toLowerCase() : "";
        return claim.includes(normalizedQuery);
      })
      .map((fact) => decode(ProjectMemoryFactSchema, fact));
  }

  proposeMemory(
    sessionId: string,
    expectedRevision: MemoryRevision,
    claim: string,
    provenance: unknown,
  ): ProjectMemoryProposal {
    if (sessionId.length === 0) throw new InvalidRequestError("sessionId cannot be empty");
    if (claim.trim().length === 0) throw new InvalidRequestError("claim cannot be empty");
    const expected = revisionValue(expectedRevision);
    if (expected > this.#snapshot.currentRevision) {
      throw new MemoryRevisionUnavailableError(this.projectId, expected);
    }
    const decodedProvenance = decode(ProjectMemoryProvenanceSchema, provenance);
    const proposal: MemoryProposalRecord = {
      proposalId: newId("mpp_"),
      expectedRevision: expected,
      claim,
      provenance: record(decodedProvenance),
      sessionId,
      createdAt: nowIso(),
    };
    this.#snapshot = {
      ...this.#snapshot,
      proposals: [...this.#snapshot.proposals, proposal],
    };
    return decode(
      ProjectMemoryProposalSchema,
      makeProposal(
        proposal.proposalId,
        proposal.expectedRevision,
        proposal.claim,
        proposal.provenance,
      ),
    );
  }

  acceptMemory(proposalId: string, expectedRevision: MemoryRevision): ProjectMemoryRevision {
    const expected = revisionValue(expectedRevision);
    const proposal = this.#snapshot.proposals.find((entry) => entry.proposalId === proposalId);
    if (proposal === undefined) throw new MemoryProposalNotFoundError(proposalId);
    if (expected !== this.#snapshot.currentRevision || proposal.expectedRevision !== expected) {
      throw new MemoryRevisionMismatchError(expected, this.#snapshot.currentRevision);
    }
    const nextRevision = this.#snapshot.currentRevision + 1;
    const fact = makeFact(proposal.claim, proposal.provenance);
    const prior = this.#snapshot.revisions[this.#snapshot.revisions.length - 1];
    const nextFacts = [...(prior?.facts ?? []), fact];
    const nextRevisionRecord: MemoryRevisionRecord = {
      revision: nextRevision,
      facts: nextFacts,
      acceptedAt: nowIso(),
    };
    this.#snapshot = {
      ...this.#snapshot,
      currentRevision: nextRevision,
      revisions: [...this.#snapshot.revisions, nextRevisionRecord],
      proposals: this.#snapshot.proposals.filter((entry) => entry.proposalId !== proposalId),
    };
    return decode(
      ProjectMemoryRevisionSchema,
      makeRevision(
        this.projectId,
        nextRevision,
        this.#snapshot.revisions.length > 1 ? nextRevision - 1 : undefined,
        nextFacts,
        proposal.proposalId,
      ),
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
    const snapshot = await this.#state.storage.get<ProjectMemorySnapshot>("memory");
    return snapshot === undefined ? undefined : clone(snapshot);
  }

  async save(snapshot: ProjectMemorySnapshot): Promise<void> {
    await this.#state.storage.put("memory", clone(snapshot));
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
    if (this.#memory !== undefined) {
      if (this.#memory.projectId !== projectId) throw new MemoryUnauthorizedError();
      return this.#memory;
    }
    const snapshot = await this.#state.storage.get<ProjectMemorySnapshot>("memory");
    this.#memory = new ProjectMemoryState(projectId, snapshot);
    return this.#memory;
  }

  async #save(memory: ProjectMemoryState): Promise<void> {
    this.#memory = memory;
    await this.#state.storage.put("memory", memory.snapshot);
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
          MemoryRevisionSchema.make(revisionValue(body["atRevision"])),
          typeof body["query"] === "string" ? body["query"] : "",
        );
        return Response.json({ _tag: "ProjectMemoryRead", facts });
      }
      if (url.pathname.endsWith("/propose")) {
        const sessionId = request.headers.get("X-Cloud-Task-Session");
        if (sessionId === null || sessionId.length === 0) throw new MemoryUnauthorizedError();
        const proposal = memory.proposeMemory(
          sessionId,
          MemoryRevisionSchema.make(revisionValue(body["expectedRevision"])),
          requiredString(body["claim"], "claim"),
          body["provenance"],
        );
        await this.#save(memory);
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
        const revision = memory.acceptMemory(
          requiredString(body["proposalId"], "proposalId"),
          MemoryRevisionSchema.make(revisionValue(body["expectedRevision"])),
        );
        await this.#save(memory);
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

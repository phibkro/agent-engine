import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AuthenticatedActorSchema,
  CommandEnvelopeSchema,
  CommandResultSchema,
  ContentManifestSchema,
  CreateProjectRequestSchema,
  EventRevisionSchema,
  GrantIdSchema,
  ProjectIdSchema,
  ProjectObservationSchema,
  Sha256DigestSchema,
  TimestampSchema,
  digestManifest,
  makeProjectId,
  projectObservation,
  transition,
  type AuthenticatedActor,
  type CommandEnvelope,
  type CommandResult,
  type ContentManifest,
  type CreateProjectRequest,
  type EventRevision,
  type Grant,
  type ProjectCommand,
  type ProjectId,
  type ProjectObservation,
  type ProjectState,
  type Sha256Digest,
  type Timestamp,
} from "@work-engine/protocol";
import {
  AttachResolutionRequestSchema,
  AttachResolutionSchema,
  ProjectCreateResultSchema,
  WorkEngineHeader,
  type AttachResolution,
  type AttachResolutionRequest,
  type ProjectAuthority,
  type ProjectAuthorityError,
  type ProjectCreateResult,
} from "@work-engine/runtime";
import { R2ArtifactStore } from "./artifact.ts";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { CloudflareSessionHost, sessionHostErrorFromCause } from "./session-host.ts";
import {
  ModelAuthorizationRequestSchema,
  ModelAuthorizationSchema,
  OutboxMessageSchema,
  WorkflowStartReceiptRequestSchema,
  type ModelAuthorization,
  type ProjectSnapshot,
} from "./schemas.ts";
import {
  ensureProjectStateTable,
  encodeSnapshot,
  loadSnapshot,
  persistSnapshot,
} from "./persistence.ts";

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const now = (): Timestamp => TimestampSchema.make(new Date().toISOString());
const json = (value: unknown): string => JSON.stringify(value);

const apiFailure = (code: string, reason: string, status: number): Response =>
  new Response(json({ _tag: "ApiFailure", code, reason }), {
    status,
    headers: { "content-type": "application/json" },
  });

const encodedResponse = <S extends Schema.Top>(
  schema: S,
  value: S["Type"],
  status = 200,
): Response =>
  new Response(json(Schema.encodeSync(schema)(value)), {
    status,
    headers: { "content-type": "application/json" },
  });

const body = async (request: Request): Promise<unknown> => {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("request body is not valid JSON");
  }
};

const projectFromName = (name: string | undefined): ProjectId => {
  if (name !== undefined) {
    try {
      return ProjectIdSchema.make(name);
    } catch {
      // A DO name is only a routing hint. The authority still mints a valid Project identity.
    }
  }
  return makeProjectId();
};

const actorFromRequest = (request: Request, candidate?: AuthenticatedActor): AuthenticatedActor => {
  const actorId = request.headers.get(WorkEngineHeader.actorId);
  if (actorId === null || actorId.length === 0)
    throw new Error("authenticated actor header is required");
  if (candidate !== undefined && candidate.actorId !== actorId)
    throw new Error("command actor does not match authenticated actor");
  const rawGrants = request.headers.get(WorkEngineHeader.grantIds) ?? "";
  const presentedGrants =
    rawGrants.length === 0
      ? []
      : rawGrants.split(",").map((id) => decode(GrantIdSchema, id.trim()));
  return decode(AuthenticatedActorSchema, {
    ...(candidate ?? { _tag: "AuthenticatedActor", kind: "operator" }),
    actorId,
    presentedGrants,
  });
};

const hasGrant = (
  state: ProjectState,
  actor: AuthenticatedActor,
  capability: Grant["capability"],
  at: Timestamp,
  workId?: string,
  sessionId?: string,
): boolean =>
  Object.values(state.grants).some(
    (grant) =>
      actor.presentedGrants.includes(grant.grantId) &&
      grant.subjectActorId === actor.actorId &&
      grant.capability === capability &&
      grant.scope.projectId === state.projectId &&
      (grant.scope.workId === undefined || grant.scope.workId === workId) &&
      (grant.scope.sessionId === undefined || grant.scope.sessionId === sessionId) &&
      grant.validFrom <= at &&
      at <= grant.validUntil,
  );

const rejected = (
  state: ProjectState | undefined,
  code: "artifact_missing" | "invalid_transition",
  reason: string,
): CommandResult => ({
  _tag: "Rejected",
  eventRevision: state?.eventRevision ?? EventRevisionSchema.make(0),
  code,
  details: { reason },
});

export const observationReferencesDigest = (
  observation: ProjectObservation,
  digest: Sha256Digest,
): boolean =>
  observation.history.some(({ event }) => {
    switch (event._tag) {
      case "EvidenceRecorded":
        return event.evidence.payloadDigest === digest || event.evidence.candidateDigest === digest;
      case "HandoffRecorded":
        return event.handoff.payloadDigest === digest;
      case "ProposalSubmitted":
        return (
          event.proposal.candidate.digest === digest ||
          event.proposal.candidate.entries.some((entry) => entry.digest === digest)
        );
      case "ProposalMerged":
        return event.receipt.candidateDigest === digest;
      default:
        return false;
    }
  });

const verifyManifest = async (manifest: ContentManifest): Promise<void> => {
  if ((await digestManifest(manifest.entries)) !== manifest.digest)
    throw new Error("candidate manifest digest mismatch");
};

const ContentManifestJsonSchema = Schema.fromJsonString(ContentManifestSchema);

const artifactManifest = (bytes: Uint8Array): ContentManifest =>
  decode(ContentManifestJsonSchema, new TextDecoder().decode(bytes));


export interface ProjectDurableObjectState extends DurableObjectState {
  readonly id: DurableObjectId;
}

export class ProjectDurableObject implements DurableObject {
  readonly #ctx: ProjectDurableObjectState;
  readonly #env: CloudflareRuntimeEnv;
  readonly #projectId: ProjectId;
  readonly #ready: Promise<void>;
  #tail: Promise<void> = Promise.resolve();

  constructor(ctx: ProjectDurableObjectState, env: CloudflareRuntimeEnv) {
    this.#ctx = ctx;
    this.#env = env;
    this.#projectId = projectFromName(ctx.id.name);
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => ensureProjectStateTable(ctx.storage.sql));
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const operation = this.#tail.then(
      () => this.#route(request),
      () => this.#route(request),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async alarm(): Promise<void> {
    await this.#ready;
    const operation = this.#tail.then(
      () => this.#reconcile(),
      () => this.#reconcile(),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/create" || url.pathname === "/v1/projects")
      )
        return this.#create(request);
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/commands" || url.pathname === "/v1/projects/commands")
      )
        return this.#command(request);
      if (
        request.method === "GET" &&
        (url.pathname === "/v1/observe" || url.pathname === "/v1/projects/observations/current")
      )
        return this.#observe(request, url.searchParams.get("eventRevision"));
      if (request.method === "POST" && url.pathname === "/v1/attach-resolutions")
        return this.#attachCreate(request);
      if (request.method === "GET" && url.pathname.startsWith("/v1/attach-resolutions/"))
        return this.#attachGet(request, decodeURIComponent(url.pathname.slice(25)));
      if (request.method === "POST" && url.pathname === "/v1/outbox/workflow-started")
        return this.#workflowStarted(request);
      if (request.method === "POST" && url.pathname === "/v1/model/authorize")
        return this.#modelAuthorize(request);
      return apiFailure("not_found", "Project route does not exist", 404);
    } catch (cause) {
      return apiFailure(
        "internal_failure",
        cause instanceof Error ? cause.message : "Project authority failure",
        500,
      );
    }
  }

  async #create(request: Request): Promise<Response> {
    let input: CreateProjectRequest;
    let actor: AuthenticatedActor;
    try {
      input = decode(CreateProjectRequestSchema, await body(request));
      actor = actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Invalid create request",
        400,
      );
    }
    const result = this.#ctx.storage.transactionSync(() => {
      ensureProjectStateTable(this.#ctx.storage.sql);
      const prior = loadSnapshot(this.#ctx.storage.sql);
      const outcome = transition(prior?.state as ProjectState | undefined, input, {
        projectId: this.#projectId,
        actor,
        now: now(),
      });
      if (outcome.state === undefined)
        return { projectId: this.#projectId, result: outcome.result, snapshot: prior };
      const snapshot = this.#snapshot(prior, outcome.state);
      persistSnapshot(this.#ctx.storage.sql, snapshot);
      return { projectId: this.#projectId, result: outcome.result, snapshot };
    });
    this.#scheduleAlarm(result.snapshot);
    return encodedResponse(
      ProjectCreateResultSchema,
      decode(ProjectCreateResultSchema, {
        _tag: "ProjectCreateResult",
        projectId: result.projectId,
        result: result.result,
      }),
    );
  }

  async #command(request: Request): Promise<Response> {
    let input: CommandEnvelope;
    try {
      const decoded = decode(CommandEnvelopeSchema, await body(request));
      input = { ...decoded, actor: actorFromRequest(request, decoded.actor) };
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Invalid command envelope",
        400,
      );
    }
    const preflight = await this.#preflight(input.command);
    const result = this.#ctx.storage.transactionSync(() => {
      ensureProjectStateTable(this.#ctx.storage.sql);
      const prior = loadSnapshot(this.#ctx.storage.sql);
      const state = prior?.state as ProjectState | undefined;
      if (preflight !== undefined) {
        const rejectedResult = rejected(state, preflight.code, preflight.reason);
        if (state === undefined) return { result: rejectedResult, snapshot: prior };
        const snapshot = this.#snapshot(prior, {
          ...state,
          commandReceipts: { ...state.commandReceipts, [input.commandId]: rejectedResult },
        } as ProjectState);
        persistSnapshot(this.#ctx.storage.sql, snapshot);
        return { result: rejectedResult, snapshot };
      }
      const outcome = transition(state, input, { now: now() });
      if (outcome.state === undefined) return { result: outcome.result, snapshot: prior };
      const snapshot = this.#snapshot(prior, outcome.state);
      persistSnapshot(this.#ctx.storage.sql, snapshot);
      return { result: outcome.result, snapshot };
    });
    this.#scheduleAlarm(result.snapshot);
    return encodedResponse(CommandResultSchema, result.result);
  }

  async #preflight(
    command: ProjectCommand,
  ): Promise<
    | { readonly code: "artifact_missing" | "invalid_transition"; readonly reason: string }
    | undefined
  > {
    try {
      if (command._tag === "SubmitProposal") await verifyManifest(command.proposal.candidate);
      if (command._tag === "RecordEvidence" && command.evidence.candidateDigest !== undefined) {
        if (this.#env.ARTIFACTS === undefined)
          return { code: "artifact_missing", reason: "artifact store is unavailable" };
        const artifact = new R2ArtifactStore(this.#env.ARTIFACTS);
        const candidate = artifactManifest(
          await artifact.getVerified(command.evidence.candidateDigest),
        );
        await verifyManifest(candidate);
        if (candidate.digest !== command.evidence.candidateDigest)
          return {
            code: "invalid_transition",
            reason: "evidence candidate digest does not match manifest",
          };
      }
      return undefined;
    } catch (cause) {
      return {
        code: command._tag === "RecordEvidence" ? "artifact_missing" : "invalid_transition",
        reason: cause instanceof Error ? cause.message : "candidate manifest verification failed",
      };
    }
  }

  async #observe(request: Request, revisionValue: string | null): Promise<Response> {
    let actor: AuthenticatedActor;
    try {
      actor = actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Actor binding failed",
        400,
      );
    }
    const snapshot = this.#readSnapshot();
    if (snapshot === undefined)
      return apiFailure("project_not_found", "Project does not exist", 404);
    const state = snapshot.state as ProjectState;
    if (!hasGrant(state, actor, "project.read", now()))
      return apiFailure("unauthorized", "actor lacks project.read", 403);
    let revision: EventRevision | undefined;
    if (revisionValue !== null) {
      const value = Number(revisionValue);
      if (!Number.isSafeInteger(value) || value < 0)
        return apiFailure("decode_failure", "invalid eventRevision", 400);
      revision = EventRevisionSchema.make(value);
    }
    if (revision !== undefined && revision > state.eventRevision)
      return apiFailure("revision_mismatch", "requested revision is newer", 409);
    const source = await this.#sourceDigest(snapshot);
    const observedState =
      revision === undefined
        ? state
        : ({
            ...state,
            history: state.history.filter((event) => event.eventRevision <= revision),
          } as ProjectState);
    return encodedResponse(
      ProjectObservationSchema,
      decode(ProjectObservationSchema, projectObservation(observedState, source)),
    );
  }

  async #attachCreate(request: Request): Promise<Response> {
    let input: AttachResolutionRequest;
    let actor: AuthenticatedActor;
    try {
      input = decode(AttachResolutionRequestSchema, await body(request));
      actor = actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Invalid attach request",
        400,
      );
    }
    const snapshot = this.#readSnapshot();
    if (snapshot === undefined)
      return apiFailure("project_not_found", "Project does not exist", 404);
    const state = snapshot.state as ProjectState;
    if (!hasGrant(state, actor, "project.read", now(), input.workId))
      return apiFailure("unauthorized", "actor lacks project.read", 403);
    const work = state.works[input.workId];
    if (work === undefined) return apiFailure("invalid_transition", "work does not exist", 409);
    const manager = Object.values(state.sessions).find(
      (session) =>
        session.workId === work.workId &&
        !["completed", "failed", "interrupted"].includes(session.status),
    );
    if (manager === undefined)
      return apiFailure("workspace_unavailable", "no manager Session is available", 503);
    const effect = state.outbox.find(
      (candidate) =>
        candidate._tag === "StartSessionEffect" && candidate.sessionId === manager.sessionId,
    );
    if (effect === undefined || effect._tag !== "StartSessionEffect")
      return apiFailure("workspace_unavailable", "manager host effect is unavailable", 503);
    const existing = Object.values(snapshot.attachResolutions).find(
      (record) => record.resolution.workId === work.workId && record.resolution.expiresAt > now(),
    );
    if (existing !== undefined) return encodedResponse(AttachResolutionSchema, existing.resolution);
    if (this.#env.SESSION_HOST === undefined)
      return apiFailure("host_unavailable", "Session host binding is unavailable", 503);
    const host = new CloudflareSessionHost(this.#env.SESSION_HOST, {
      "CF-Access-Client-Id": this.#env.ACCESS_CLIENT_ID ?? "",
      "CF-Access-Client-Secret": this.#env.ACCESS_CLIENT_SECRET ?? "",
    });
    let ready;
    try {
      ready = await host.ensureReadyPromise(effect.spec.workspaceLease);
    } catch (cause) {
      const failure = sessionHostErrorFromCause(cause);
      return apiFailure(
        failure._tag,
        "reason" in failure ? failure.reason : "workspace readiness failed",
        503,
      );
    }
    const resolution = decode(AttachResolutionSchema, {
      _tag: "AttachResolution",
      resolutionId: `ar_${crypto.randomUUID().toLowerCase()}`,
      projectId: state.projectId,
      workId: work.workId,
      containerInstanceId: ready.instanceId,
      sshHost: ready.instanceId,
      sshPort: 22,
      sshUser: "cloudchamber",
      proxyCommand: "wrangler containers ssh %h",
      herdrSessionName: `work-engine-${state.projectId}`,
      expiresAt: TimestampSchema.make(new Date(Date.now() + 300_000).toISOString()),
    });
    const updated = this.#ctx.storage.transactionSync(() => {
      ensureProjectStateTable(this.#ctx.storage.sql);
      const current = loadSnapshot(this.#ctx.storage.sql);
      if (current === undefined) return undefined;
      const next: ProjectSnapshot = {
        ...current,
        attachResolutions: {
          ...current.attachResolutions,
          [resolution.resolutionId]: {
            resolution,
            containerGeneration: ready.containerGeneration,
            managerSessionId: manager.sessionId,
            authorizedSshKeyName: this.#env.AUTHORIZED_SSH_KEY_NAME ?? "",
          },
        },
      };
      persistSnapshot(this.#ctx.storage.sql, next);
      return next;
    });
    if (updated === undefined)
      return apiFailure("project_not_found", "Project disappeared during attach", 404);
    this.#scheduleAlarm(updated);
    return encodedResponse(AttachResolutionSchema, resolution);
  }

  async #attachGet(request: Request, resolutionId: string): Promise<Response> {
    let actor: AuthenticatedActor;
    try {
      actor = actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Actor binding failed",
        400,
      );
    }
    const snapshot = this.#readSnapshot();
    if (snapshot === undefined)
      return apiFailure("project_not_found", "Project does not exist", 404);
    const state = snapshot.state as ProjectState;
    const record = snapshot.attachResolutions[resolutionId];
    if (!hasGrant(state, actor, "project.read", now(), record?.resolution.workId))
      return apiFailure("unauthorized", "actor lacks project.read", 403);
    if (record === undefined)
      return apiFailure("not_found", "attach resolution does not exist", 404);
    if (record.resolution.expiresAt <= now())
      return apiFailure("lease_expired", "attach resolution has expired", 410);
    return encodedResponse(AttachResolutionSchema, record.resolution);
  }

  async #workflowStarted(request: Request): Promise<Response> {
    let effectId: string;
    try {
      effectId = decode(WorkflowStartReceiptRequestSchema, await body(request)).effectId;
      actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Invalid Workflow receipt",
        400,
      );
    }
    const started = this.#ctx.storage.transactionSync(() => {
      ensureProjectStateTable(this.#ctx.storage.sql);
      const current = loadSnapshot(this.#ctx.storage.sql);
      if (current === undefined || current.workflowStarts[effectId] === true) return true;
      persistSnapshot(this.#ctx.storage.sql, {
        ...current,
        workflowStarts: { ...current.workflowStarts, [effectId]: true },
      });
      return true;
    });
    return new Response(json({ started }), { headers: { "content-type": "application/json" } });
  }

  async #modelAuthorize(request: Request): Promise<Response> {
    let input: { readonly sessionId: string; readonly requestedTokens: number };
    let actor: AuthenticatedActor;
    try {
      input = decode(ModelAuthorizationRequestSchema, await body(request));
      actor = actorFromRequest(request);
    } catch (cause) {
      return apiFailure(
        "decode_failure",
        cause instanceof Error ? cause.message : "Invalid model authorization",
        400,
      );
    }
    const snapshot = this.#readSnapshot();
    if (snapshot === undefined)
      return apiFailure("project_not_found", "Project does not exist", 404);
    const state = snapshot.state as ProjectState;
    const session = state.sessions[input.sessionId];
    if (session === undefined)
      return apiFailure("session_not_found", "Session does not exist", 404);
    if (!hasGrant(state, actor, "workspace.read", now(), session.workId, session.sessionId))
      return apiFailure("unauthorized", "actor lacks workspace.read", 403);
    const used = snapshot.modelUsage[input.sessionId] ?? 0;
    const remaining = 32_000 - used;
    if (input.requestedTokens > remaining)
      return apiFailure("budget_exhausted", "Session model output budget exhausted", 429);
    const next = {
      ...snapshot,
      modelUsage: { ...snapshot.modelUsage, [input.sessionId]: used + input.requestedTokens },
    };
    this.#ctx.storage.transactionSync(() => {
      ensureProjectStateTable(this.#ctx.storage.sql);
      persistSnapshot(this.#ctx.storage.sql, next);
    });
    const response: ModelAuthorization = decode(ModelAuthorizationSchema, {
      _tag: "ModelAuthorization",
      sessionId: input.sessionId,
      remainingTokens: remaining - input.requestedTokens,
    });
    return encodedResponse(ModelAuthorizationSchema, response);
  }

  #snapshot(prior: ProjectSnapshot | undefined, state: ProjectState): ProjectSnapshot {
    return {
      state: state as ProjectSnapshot["state"],
      dispatchedEffects: prior?.dispatchedEffects ?? {},
      workflowStarts: prior?.workflowStarts ?? {},
      attachResolutions: prior?.attachResolutions ?? {},
      modelUsage: prior?.modelUsage ?? {},
    };
  }

  #readSnapshot(): ProjectSnapshot | undefined {
    ensureProjectStateTable(this.#ctx.storage.sql);
    return loadSnapshot(this.#ctx.storage.sql);
  }

  async #sourceDigest(snapshot: ProjectSnapshot): Promise<Sha256Digest> {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encodeSnapshot(snapshot)),
    );
    return Sha256DigestSchema.make(
      `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    );
  }

  #scheduleAlarm(snapshot: ProjectSnapshot | undefined): void {
    if (snapshot !== undefined)
      this.#ctx.waitUntil(this.#ctx.storage.setAlarm(Date.now() + 60_000));
  }

  async #reconcile(): Promise<void> {
    const snapshot = this.#readSnapshot();
    if (snapshot !== undefined) await this.#flushOutbox(snapshot);
    this.#ctx.waitUntil(this.#ctx.storage.setAlarm(Date.now() + 60_000));
  }

  async #flushOutbox(snapshot: ProjectSnapshot): Promise<void> {
    if (this.#env.SESSION_EFFECTS === undefined) return;
    for (const effect of snapshot.state.outbox) {
      if (snapshot.dispatchedEffects[effect.effectId] === true) continue;
      const message = decode(OutboxMessageSchema, {
        _tag: "OutboxMessage",
        projectId: snapshot.state.projectId,
        effect,
      });
      // oxlint-disable-next-line eslint(no-await-in-loop) -- Sending and recording each effect must stay ordered for outbox idempotency.
      await this.#env.SESSION_EFFECTS.send(message, { contentType: "json" });
      this.#ctx.storage.transactionSync(() => {
        ensureProjectStateTable(this.#ctx.storage.sql);
        const current = loadSnapshot(this.#ctx.storage.sql);
        if (current !== undefined && current.dispatchedEffects[effect.effectId] !== true)
          persistSnapshot(this.#ctx.storage.sql, {
            ...current,
            dispatchedEffects: { ...current.dispatchedEffects, [effect.effectId]: true },
          });
      });
    }
  }
}

export class DurableObjectProjectAuthority implements ProjectAuthority {
  readonly #namespace: DurableObjectNamespace;
  readonly #actor: AuthenticatedActor;
  readonly #headers: HeadersInit;

  constructor(
    namespace: DurableObjectNamespace,
    actor: AuthenticatedActor,
    headers: HeadersInit = {},
  ) {
    this.#namespace = namespace;
    this.#actor = actor;
    this.#headers = headers;
  }

  #request(
    projectId: ProjectId,
    path: string,
    payload?: unknown,
    method = "POST",
  ): Effect.Effect<unknown, ProjectAuthorityError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await this.#namespace
          .getByName(projectId)
          .fetch(`https://project${path}`, {
            method,
            headers: {
              "content-type": "application/json",
              [WorkEngineHeader.actorId]: this.#actor.actorId,
              [WorkEngineHeader.grantIds]: this.#actor.presentedGrants.join(","),
              ...this.#headers,
            },
            ...(payload === undefined ? {} : { body: json(payload) }),
          });
        const value: unknown = await response.json();
        if (!response.ok)
          throw new Error(`Project authority returned ${response.status}`);
        return value;
      },
      catch: (cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause)
          return cause as ProjectAuthorityError;
        return {
          _tag: "AuthorityUnavailable",
          reason: cause instanceof Error ? cause.message : "Project authority request failed",
        };
      },
    });
  }

  dispatch(command: CommandEnvelope): Effect.Effect<CommandResult, ProjectAuthorityError> {
    return this.#request(command.projectId, "/v1/commands", command).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(CommandResultSchema, value),
          catch: (cause) => ({
            _tag: "DecodeFailure",
            reason:
              cause instanceof Error ? cause.message : "Project returned invalid CommandResult",
          }),
        }),
      ),
    );
  }

  observe(
    projectId: ProjectId,
    eventRevision?: EventRevision,
  ): Effect.Effect<ProjectObservation, ProjectAuthorityError> {
    const path =
      eventRevision === undefined ? "/v1/observe" : `/v1/observe?eventRevision=${eventRevision}`;
    return this.#request(projectId, path, undefined, "GET").pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(ProjectObservationSchema, value),
          catch: (cause) => ({
            _tag: "DecodeFailure",
            reason: cause instanceof Error ? cause.message : "Project returned invalid observation",
          }),
        }),
      ),
    );
  }

  create(request: CreateProjectRequest): Effect.Effect<ProjectCreateResult, ProjectAuthorityError> {
    const projectId = makeProjectId();
    return this.#request(projectId, "/v1/create", request).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(ProjectCreateResultSchema, value),
          catch: (cause) => ({
            _tag: "DecodeFailure",
            reason:
              cause instanceof Error
                ? cause.message
                : "Project returned invalid ProjectCreateResult",
          }),
        }),
      ),
    );
  }

  attach(
    projectId: ProjectId,
    request: AttachResolutionRequest,
  ): Effect.Effect<AttachResolution, ProjectAuthorityError> {
    return this.#request(projectId, "/v1/attach-resolutions", request).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(AttachResolutionSchema, value),
          catch: (cause) => ({
            _tag: "DecodeFailure",
            reason:
              cause instanceof Error ? cause.message : "Project returned invalid AttachResolution",
          }),
        }),
      ),
    );
  }

  attachQuery(
    projectId: ProjectId,
    resolutionId: string,
  ): Effect.Effect<AttachResolution, ProjectAuthorityError> {
    return this.#request(
      projectId,
      `/v1/attach-resolutions/${encodeURIComponent(resolutionId)}`,
      undefined,
      "GET",
    ).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decode(AttachResolutionSchema, value),
          catch: (cause) => ({
            _tag: "DecodeFailure",
            reason:
              cause instanceof Error ? cause.message : "Project returned invalid AttachResolution",
          }),
        }),
      ),
    );
  }
}

export const ProjectAuthorityService = Context.Service<ProjectAuthority>(
  "work-engine/ProjectAuthority",
);

export const ProjectAuthorityLive = (
  namespace: DurableObjectNamespace,
  actor: AuthenticatedActor,
  headers: HeadersInit = {},
): Layer.Layer<ProjectAuthority> =>
  Layer.succeed(
    ProjectAuthorityService,
    new DurableObjectProjectAuthority(namespace, actor, headers),
  );

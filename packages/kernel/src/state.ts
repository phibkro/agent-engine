import { ContentRevisionSchema, EventRevisionSchema, PolicyIdSchema } from "@work-engine/protocol";
import type {
  AcceptedReceipt,
  AgentProfile,
  AgentProfileId,
  AuthenticatedActor,
  CommandId,
  CommandReceipt,
  ContentManifest,
  ContentRevision,
  EffectId,
  EffectRequest,
  EventEnvelope,
  EventRevision,
  Evidence,
  EvidenceId,
  GateKey,
  Grant,
  Handoff,
  HandoffId,
  MergeId,
  MergeReceipt,
  Policy,
  Proposal,
  ProposalId,
  ProjectCommand,
  ProjectEvent,
  ProjectId,
  ResourceClaim,
  ResourceId,
  Session,
  SessionId,
  Work,
  WorkId,
  WorkProcessId,
} from "@work-engine/protocol";

export interface WorkProcess {
  readonly workProcessId: WorkProcessId;
  readonly workId: WorkId;
  readonly resourceIds: readonly ResourceId[];
  readonly requiredGates: readonly GateKey[];
}

export interface EffectReceipt {
  readonly effectId: EffectId;
  readonly receipt: AcceptedReceipt;
}

export type ResourceClaims = Readonly<Record<SessionId, ResourceClaim>>;

export interface ProjectState {
  readonly projectId: ProjectId;
  readonly eventRevision: EventRevision;
  readonly contentRevision: ContentRevision;
  readonly policy: Policy;
  readonly canonicalContent: ContentManifest | null;
  readonly works: Readonly<Record<WorkId, Work>>;
  readonly workProcesses: Readonly<Record<WorkProcessId, WorkProcess>>;
  readonly profiles: Readonly<Record<AgentProfileId, AgentProfile>>;
  readonly sessions: Readonly<Record<SessionId, Session>>;
  /** Claims are keyed by resource and owner Session so compatible owners coexist. */
  readonly resources: Readonly<Record<ResourceId, ResourceClaims>>;
  readonly handoffs: Readonly<Record<HandoffId, Handoff>>;
  readonly evidence: Readonly<Record<EvidenceId, Evidence>>;
  readonly proposals: Readonly<Record<ProposalId, Proposal>>;
  readonly grants: Readonly<Record<Grant["grantId"], Grant>>;
  readonly mergeReceipts: Readonly<Record<MergeId, MergeReceipt>>;
  readonly history: readonly EventEnvelope[];
  readonly commandReceipts: Readonly<Record<CommandId, CommandReceipt>>;
  readonly effectReceipts: Readonly<Record<EffectId, EffectReceipt>>;
  readonly outbox: readonly EffectRequest[];
}

const revision = (value: number): EventRevision => EventRevisionSchema.make(value);
const contentRevision = (value: number): ContentRevision => ContentRevisionSchema.make(value);

export const tracerPolicy = (): Policy => ({
  _tag: "Policy",
  policyId: PolicyIdSchema.make("pol_tracer_0001_v1"),
  revision: revision(1),
  requiredGates: [
    "gat_session_completed",
    "gat_candidate_present",
    "gat_scope_valid",
    "gat_check_passed",
    "gat_human_approved",
  ],
  mergeCapability: "proposal.merge",
  maxAttempts: 1,
});

export const emptyProjectState = (
  projectId: ProjectId,
  policy: Policy = tracerPolicy(),
  grants: readonly Grant[] = [],
): ProjectState => {
  const grantMap: Record<Grant["grantId"], Grant> = {};
  for (const grant of grants) grantMap[grant.grantId] = grant;
  return {
    projectId,
    eventRevision: revision(0),
    contentRevision: contentRevision(0),
    policy,
    canonicalContent: null,
    works: {},
    workProcesses: {},
    profiles: {},
    sessions: {},
    resources: {},
    handoffs: {},
    evidence: {},
    proposals: {},
    grants: grantMap,
    mergeReceipts: {},
    history: [],
    commandReceipts: {},
    effectReceipts: {},
    outbox: [],
  };
};

export const initialProjectState = emptyProjectState;

const copyWith = <K extends string, V>(
  values: Readonly<Record<K, V>>,
  key: K,
  value: V,
): Readonly<Record<K, V>> => ({ ...values, [key]: value });
const withResourceClaim = (
  resources: Readonly<Record<ResourceId, ResourceClaims>>,
  claim: ResourceClaim,
): Readonly<Record<ResourceId, ResourceClaims>> => ({
  ...resources,
  [claim.resourceId]: {
    ...resources[claim.resourceId],
    [claim.sessionId]: claim,
  },
});

const withoutResourceClaim = (
  resources: Readonly<Record<ResourceId, ResourceClaims>>,
  resourceId: ResourceId,
  sessionId: SessionId,
): Readonly<Record<ResourceId, ResourceClaims>> => {
  const claims = resources[resourceId];
  if (claims === undefined) return resources;
  const nextClaims = { ...claims };
  delete nextClaims[sessionId];
  if (Object.keys(nextClaims).length === 0) {
    const nextResources = { ...resources };
    delete nextResources[resourceId];
    return nextResources;
  }
  return { ...resources, [resourceId]: nextClaims };
};

const updateSession = (
  state: ProjectState,
  sessionId: SessionId,
  update: (session: Session) => Session,
): ProjectState => {
  const session = state.sessions[sessionId];
  if (session === undefined) return state;
  return { ...state, sessions: copyWith(state.sessions, sessionId, update(session)) };
};

const appendOutbox = (state: ProjectState, effect: EffectRequest): ProjectState => {
  if (state.outbox.some((candidate) => candidate.effectId === effect.effectId)) return state;
  return { ...state, outbox: [...state.outbox, effect] };
};

const applyEventBody = (state: ProjectState, event: ProjectEvent): ProjectState => {
  switch (event._tag) {
    case "ProjectCreated": {
      const grants: Record<Grant["grantId"], Grant> = {};
      for (const grant of event.grants) grants[grant.grantId] = grant;
      return { ...state, projectId: event.projectId, policy: event.policy, grants };
    }
    case "WorkSubmitted":
      return {
        ...state,
        works: copyWith(state.works, event.work.workId, event.work),
        workProcesses: copyWith(state.workProcesses, event.work.workProcessId, {
          workProcessId: event.work.workProcessId,
          workId: event.work.workId,
          resourceIds: [],
          requiredGates: state.policy.requiredGates,
        }),
      };
    case "SessionRequested": {
      const resources =
        event.effect._tag === "StartSessionEffect"
          ? withResourceClaim(state.resources, event.effect.spec.workspaceLease)
          : state.resources;
      const work = state.works[event.session.workId];
      return appendOutbox(
        {
          ...state,
          resources,
          works:
            work === undefined
              ? state.works
              : copyWith(state.works, work.workId, { ...work, lifecycle: "active" }),
          sessions: copyWith(state.sessions, event.session.sessionId, event.session),
        },
        event.effect,
      );
    }
    case "SessionStarted":
      return updateSession(state, event.sessionId, (session) => ({
        ...session,
        status: "started",
        workspaceViewId: event.workspaceViewId,
        startedAt: event.startedAt,
      }));
    case "SessionCancellationRequested":
      return appendOutbox(
        updateSession(state, event.sessionId, (session) => ({
          ...session,
          status: "cancellation_requested",
        })),
        event.effect,
      );
    case "SessionInterrupted":
      return updateSession(state, event.sessionId, (session) => ({
        ...session,
        status: "interrupted",
        terminalReason: event.reason,
        terminalAt: event.terminalAt,
      }));
    case "SessionFailed":
      return updateSession(state, event.sessionId, (session) => ({
        ...session,
        status: "failed",
        terminalReason: event.reason,
        terminalAt: event.terminalAt,
      }));
    case "SessionCompleted":
      return updateSession(state, event.sessionId, (session) => ({
        ...session,
        status: "completed",
        terminalAt: event.terminalAt,
      }));
    case "HandoffRecorded":
      return {
        ...state,
        handoffs: copyWith(state.handoffs, event.handoff.handoffId, event.handoff),
      };
    case "EvidenceRecorded":
      return {
        ...state,
        evidence: copyWith(state.evidence, event.evidence.evidenceId, event.evidence),
      };
    case "ProposalSubmitted":
      return {
        ...state,
        proposals: copyWith(state.proposals, event.proposal.proposalId, event.proposal),
      };
    case "ApprovalRecorded": {
      const proposal = state.proposals[event.proposalId];
      if (proposal === undefined) return state;
      return {
        ...state,
        evidence: copyWith(state.evidence, event.evidence.evidenceId, event.evidence),
        proposals: copyWith(state.proposals, event.proposalId, { ...proposal, status: "approved" }),
      };
    }
    case "ProposalRejected": {
      const proposal = state.proposals[event.proposalId];
      if (proposal === undefined) return state;
      return {
        ...state,
        proposals: copyWith(state.proposals, event.proposalId, {
          ...proposal,
          status: "rejected",
          rejectionReason: event.reason,
        }),
      };
    }
    case "GatesEvaluated":
      return state;
    case "ProposalMerged": {
      const proposal = state.proposals[event.receipt.proposalId];
      const proposerSession =
        proposal === undefined ? undefined : state.sessions[proposal.proposerSessionId];
      const work = proposerSession === undefined ? undefined : state.works[proposerSession.workId];
      return {
        ...state,
        canonicalContent: proposal?.candidate ?? state.canonicalContent,
        contentRevision: event.receipt.resultingContentRevision,
        works:
          work === undefined
            ? state.works
            : copyWith(state.works, work.workId, { ...work, lifecycle: "completed" }),
        proposals:
          proposal === undefined
            ? state.proposals
            : copyWith(state.proposals, proposal.proposalId, { ...proposal, status: "merged" }),
        mergeReceipts: copyWith(state.mergeReceipts, event.receipt.mergeId, event.receipt),
      };
    }
    case "WorkspaceLeaseAcquired":
      return {
        ...state,
        resources: withResourceClaim(state.resources, event.lease),
      };
    case "WorkspaceLeaseRenewed": {
      const claims = state.resources[event.resourceId];
      const lease = claims?.[event.sessionId];
      if (lease === undefined) return state;
      return {
        ...state,
        resources: withResourceClaim(state.resources, {
          ...lease,
          expiresAt: event.expiresAt,
        }),
      };
    }
    case "WorkspaceLeaseReleased":
      return {
        ...state,
        resources: withoutResourceClaim(state.resources, event.resourceId, event.sessionId),
      };
  }
};

/** Fold one accepted event. Decisions belong to the transition function; the fold is deterministic. */
export const foldEvent = (state: ProjectState, envelope: EventEnvelope): ProjectState => {
  const last = state.history[state.history.length - 1];
  const isFirstAtRevision = envelope.eventRevision === state.eventRevision + 1;
  const isCommandSibling =
    envelope.eventRevision === state.eventRevision &&
    last !== undefined &&
    last.commandId === envelope.commandId;
  if (!isFirstAtRevision && !isCommandSibling) return state;
  const next = applyEventBody(state, envelope.event);
  return {
    ...next,
    eventRevision: isFirstAtRevision ? envelope.eventRevision : state.eventRevision,
    history: [...state.history, envelope],
  };
};

export const replay = (state: ProjectState, events: readonly EventEnvelope[]): ProjectState =>
  events.reduce(foldEvent, state);

export const commandReceipt = (
  state: ProjectState,
  commandId: CommandId,
): CommandReceipt | undefined => state.commandReceipts[commandId];

export const hasActiveLease = (
  state: ProjectState,
  resourceId: ResourceId,
  at: string,
): ResourceClaim | undefined => {
  const claims = state.resources[resourceId];
  if (claims === undefined) return undefined;
  return Object.values(claims).find((claim) => claim.expiresAt > at);
};

export const activeSession = (state: ProjectState, sessionId: SessionId): Session | undefined =>
  state.sessions[sessionId];

export const projectCommandTag = (command: ProjectCommand): string => command._tag;
export type StateActor = AuthenticatedActor;

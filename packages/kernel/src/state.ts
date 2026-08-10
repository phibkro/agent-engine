import {
  ContentRevisionSchema,
  EventRevisionSchema,
  PolicyIdSchema,
} from "@work-engine/protocol";
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
  readonly resources: Readonly<Record<ResourceId, ResourceClaim>>;
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
    case "ProjectCreated":
      return { ...state, projectId: event.projectId, policy: event.policy };
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
          ? copyWith(
              state.resources,
              event.effect.spec.workspaceLease.resourceId,
              event.effect.spec.workspaceLease,
            )
          : state.resources;
      return appendOutbox(
        {
          ...state,
          resources,
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
      return {
        ...state,
        canonicalContent: proposal?.candidate ?? state.canonicalContent,
        contentRevision: event.receipt.resultingContentRevision,
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
        resources: copyWith(state.resources, event.lease.resourceId, event.lease),
      };
    case "WorkspaceLeaseRenewed": {
      const lease = state.resources[event.resourceId];
      if (lease === undefined) return state;
      return {
        ...state,
        resources: copyWith(state.resources, event.resourceId, {
          ...lease,
          expiresAt: event.expiresAt,
        }),
      };
    }
    case "WorkspaceLeaseReleased": {
      const resources = { ...state.resources };
      delete resources[event.resourceId];
      return { ...state, resources };
    }
  }
};

/** Fold one accepted event. Decisions belong to the transition function; the fold is deterministic. */
export const foldEvent = (state: ProjectState, envelope: EventEnvelope): ProjectState => {
  const next = applyEventBody(state, envelope.event);
  return {
    ...next,
    eventRevision: envelope.eventRevision,
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
  const claim = state.resources[resourceId];
  return claim !== undefined && claim.expiresAt > at ? claim : undefined;
};

export const activeSession = (state: ProjectState, sessionId: SessionId): Session | undefined =>
  state.sessions[sessionId];

export const projectCommandTag = (command: ProjectCommand): string => command._tag;
export type StateActor = AuthenticatedActor;

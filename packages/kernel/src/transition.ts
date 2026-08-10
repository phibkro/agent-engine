import type {
  AcceptedReceipt,
  AgentProfileId,
  AttemptNumber,
  AuthenticatedActor,
  CommandEnvelope,
  CommandId,
  CommandReceipt,
  CommandResult,
  ContentManifest,
  ContentRevision,
  CreateProjectRequest,
  EffectId,
  EffectRequest,
  EventEnvelope,
  EventRevision,
  Grant,
  ProjectCommand,
  ProjectEvent,
  ProjectId,
  ProposalId,
  RejectedReceipt,
  RejectionCode,
  ResourceId,
  Session,
  SessionId,
  Timestamp,
  WorkId,
} from "@work-engine/protocol";
import { deriveGates } from "./gates.ts";
import { emptyProjectState, foldEvent, hasActiveLease, type ProjectState } from "./state.ts";

export interface TransitionContext {
  /** Trusted authority-supplied identity for a CreateProject acceptance. */
  readonly projectId?: ProjectId;
  /** Trusted authenticated actor for a CreateProject acceptance. */
  readonly actor?: AuthenticatedActor;
  /** Trusted observation time used for Grant/lease validity checks. */
  readonly now?: Timestamp;
}

export interface TransitionOutcome {
  readonly state: ProjectState | undefined;
  readonly result: CommandResult;
}

const eventRevision = (value: number): EventRevision => value as EventRevision;
const contentRevision = (value: number): ContentRevision => value as ContentRevision;
const defaultActor: AuthenticatedActor = {
  _tag: "AuthenticatedActor",
  actorId: "operator" as AuthenticatedActor["actorId"],
  kind: "operator",
  presentedGrants: [],
};

const jsonDetails = (
  reason: string,
  extra: Readonly<Record<string, string | number | boolean | null>> = {},
): Readonly<Record<string, string | number | boolean | null>> => ({ reason, ...extra });

const reject = (
  state: ProjectState,
  commandId: CommandId,
  code: RejectionCode,
  reason: string,
  extra: Readonly<Record<string, string | number | boolean | null>> = {},
): TransitionOutcome => {
  const receipt: RejectedReceipt = {
    _tag: "Rejected",
    eventRevision: state.eventRevision,
    code,
    details: jsonDetails(reason, extra),
  };
  return {
    state: {
      ...state,
      commandReceipts: { ...state.commandReceipts, [commandId]: receipt },
    },
    result: receipt,
  };
};

const accepted = (
  state: ProjectState,
  commandId: CommandId,
  event: ProjectEvent,
  effectRequests: readonly EffectRequest[] = [],
): TransitionOutcome => {
  const nextRevision = eventRevision(state.eventRevision + 1);
  const envelope: EventEnvelope = { eventRevision: nextRevision, commandId, event };
  const receipt: AcceptedReceipt = {
    _tag: "Accepted",
    eventRevision: nextRevision,
    eventIds: [commandId],
    effectRequests,
  };
  let next = foldEvent(state, envelope);
  const effectReceipts = { ...next.effectReceipts };
  for (const effect of effectRequests)
    effectReceipts[effect.effectId] = { effectId: effect.effectId, receipt };
  next = {
    commandReceipts: { ...next.commandReceipts, [commandId]: receipt },
    effectReceipts,
  };
  return { state: next, result: receipt };
};

const alreadyAppliedWithState = (
  state: ProjectState,
  receipt: CommandReceipt,
): TransitionOutcome => ({
  state,
  result: { _tag: "AlreadyApplied", originalReceipt: receipt },
});

const commandEffectId = (command: ProjectCommand): EffectId | undefined => {
  switch (command._tag) {
    case "OpenManagerSession":
    case "StartWorkerSession":
    case "CancelSession":
      return command.effectId;
    case "AcquireWorkspaceLease":
      return command.lease.effectId;
    default:
      return undefined;
  }
};

const scopeMatches = (
  scope: Grant["scope"],
  projectId: ProjectId,
  workId?: WorkId,
  sessionId?: SessionId,
  proposalId?: ProposalId,
): boolean =>
  (scope.projectId === undefined || scope.projectId === projectId) &&
  (workId === undefined || scope.workId === undefined || scope.workId === workId) &&
  (sessionId === undefined || scope.sessionId === undefined || scope.sessionId === sessionId) &&
  (proposalId === undefined || scope.proposalId === undefined || scope.proposalId === proposalId);

const grantValidAt = (grant: Grant, now: Timestamp | undefined): boolean =>
  now === undefined || (grant.validFrom <= now && now <= grant.validUntil);

const authorized = (
  state: ProjectState,
  actor: AuthenticatedActor,
  capability: Grant["capability"],
  context: TransitionContext,
  scope: {
    readonly workId?: WorkId;
    readonly sessionId?: SessionId;
    readonly proposalId?: ProposalId;
  } = {},
): Grant | undefined => {
  for (const grantId of actor.presentedGrants) {
    const grant = state.grants[grantId];
    if (
      grant !== undefined &&
      grant.subjectActorId === actor.actorId &&
      grant.capability === capability &&
      scopeMatches(grant.scope, state.projectId, scope.workId, scope.sessionId, scope.proposalId) &&
      grantValidAt(grant, context.now)
    ) {
      return grant;
    }
  }
  return undefined;
};

const ensureExpectedRevision = (
  state: ProjectState,
  envelope: CommandEnvelope,
): TransitionOutcome | undefined => {
  if (envelope.projectId !== state.projectId) {
    return reject(
      state,
      envelope.commandId,
      "project_not_found",
      "project identity does not match authority",
    );
  }
  if (envelope.expectedRevision !== state.eventRevision) {
    return reject(
      state,
      envelope.commandId,
      "revision_mismatch",
      "expected event revision does not match current authority revision",
      { expectedRevision: envelope.expectedRevision, observedRevision: state.eventRevision },
    );
  }
  return undefined;
};

const duplicateCommand = (
  state: ProjectState,
  commandId: CommandId,
): TransitionOutcome | undefined => {
  const receipt = state.commandReceipts[commandId];
  return receipt === undefined ? undefined : alreadyAppliedWithState(state, receipt);
};

const duplicateEffect = (
  state: ProjectState,
  command: ProjectCommand,
): TransitionOutcome | undefined => {
  const effectId = commandEffectId(command);
  if (effectId === undefined) return undefined;
  const prior = state.effectReceipts[effectId];
  return prior === undefined ? undefined : alreadyAppliedWithState(state, prior.receipt);
};

const sessionBase = (
  projectId: ProjectId,
  sessionId: SessionId,
  workId: WorkId,
  profileId: AgentProfileId,
  attempt: AttemptNumber,
  contextReference: string,
  deadline: Timestamp,
  outputLimit: number,
  toolBudget: number,
  predecessorSessionId?: SessionId,
): Session => ({
  _tag: "Session",
  sessionId,
  projectId,
  workId,
  profileId,
  attempt,
  contextReference,
  deadline,
  outputLimit,
  toolBudget,
  status: "requested",
  ...(predecessorSessionId === undefined ? {} : { predecessorSessionId }),
});

const leaseConflicts = (state: ProjectState, resourceId: ResourceId, at: Timestamp): boolean =>
  hasActiveLease(state, resourceId, at) !== undefined;

const validManifest = (manifest: ContentManifest): boolean => {
  for (let index = 1; index < manifest.entries.length; index += 1) {
    if (manifest.entries[index - 1]!.path >= manifest.entries[index]!.path) return false;
  }
  return true;
};

const evidenceBelongsToProject = (state: ProjectState, evidence: Evidence): boolean =>
  evidence.projectId === state.projectId &&
  (evidence.producerSessionId === undefined ||
    state.sessions[evidence.producerSessionId] !== undefined);

const eventForTerminal = (
  command: Extract<ProjectCommand, { readonly _tag: "ReportSessionTerminal" }>,
): ProjectEvent => {
  switch (command.status) {
    case "completed":
      return {
        _tag: "SessionCompleted",
        sessionId: command.sessionId,
        terminalAt: command.terminalAt,
      };
    case "failed":
      return {
        _tag: "SessionFailed",
        sessionId: command.sessionId,
        reason: command.reason,
        terminalAt: command.terminalAt,
      };
    case "interrupted":
      return {
        _tag: "SessionInterrupted",
        sessionId: command.sessionId,
        reason: command.reason,
        terminalAt: command.terminalAt,
      };
  }
};

const dispatchCommand = (
  state: ProjectState,
  envelope: CommandEnvelope,
  context: TransitionContext,
): TransitionOutcome => {
  const duplicate = duplicateCommand(state, envelope.commandId);
  if (duplicate !== undefined) return duplicate;
  const revisionError = ensureExpectedRevision(state, envelope);
  if (revisionError !== undefined) return revisionError;
  const effectDuplicate = duplicateEffect(state, envelope.command);
  if (effectDuplicate !== undefined) return effectDuplicate;
  const command = envelope.command;
  const actor = envelope.actor;

  switch (command._tag) {
    case "CreateProject":
      return reject(
        state,
        envelope.commandId,
        "invalid_transition",
        "a Project cannot be created twice",
      );
    case "SubmitWork": {
      if (authorized(state, actor, "work.submit", context) === undefined) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks work.submit");
      }
      if (state.works[command.workId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "work identity already exists",
        );
      }
      const work = {
        _tag: "Work" as const,
        workId: command.workId,
        projectId: state.projectId,
        workProcessId: command.workProcessId,
        objective: command.objective,
        kind: command.kind,
        writableScope: command.writableScope,
        requiredCheck: command.requiredCheck,
        lifecycle: "submitted" as const,
        ...(command.title === undefined ? {} : { title: command.title }),
      };
      return accepted(state, envelope.commandId, { _tag: "WorkSubmitted", work });
    }
    case "OpenManagerSession": {
      if (
        authorized(state, actor, "manager.open", context, { workId: command.workId }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks manager.open");
      }
      const work = state.works[command.workId];
      if (work === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "work does not exist");
      if (state.sessions[command.sessionId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "session identity already exists",
        );
      }
      if (command.attempt > state.policy.maxAttempts) {
        return reject(state, envelope.commandId, "policy_rejected", "attempt exceeds policy limit");
      }
      if (leaseConflicts(state, command.resourceId, context.now ?? command.deadline)) {
        return reject(
          state,
          envelope.commandId,
          "resource_conflict",
          "workspace resource is already leased",
        );
      }
      const session = sessionBase(
        state.projectId,
        command.sessionId,
        work.workId,
        command.profileId,
        command.attempt,
        command.contextReference,
        command.deadline,
        command.outputLimit,
        command.toolBudget,
      );
      const lease = {
        _tag: "WorkspaceLease" as const,
        resourceId: command.resourceId,
        sessionId: command.sessionId,
        mode: "write" as const,
        acquiredAt: context.now ?? command.deadline,
        expiresAt: command.deadline,
        effectId: command.effectId,
      };
      const spec = {
        _tag: "SessionStartSpec" as const,
        sessionId: command.sessionId,
        effectId: command.effectId,
        projectId: state.projectId,
        workId: work.workId,
        profileId: command.profileId,
        attempt: command.attempt,
        deadline: command.deadline,
        outputLimit: command.outputLimit,
        toolBudget: command.toolBudget,
        workspaceLease: lease,
      };
      const effect = {
        _tag: "StartSessionEffect" as const,
        effectId: command.effectId,
        sessionId: command.sessionId,
        attempt: command.attempt,
        spec,
      };
      return accepted(state, envelope.commandId, { _tag: "SessionRequested", session, effect }, [
        effect,
      ]);
    }
    case "StartWorkerSession": {
      if (
        authorized(state, actor, "worker.start", context, { workId: command.workId }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks worker.start");
      }
      const work = state.works[command.workId];
      if (work === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "work does not exist");
      if (state.sessions[command.sessionId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "session identity already exists",
        );
      }
      if (command.predecessorSessionId !== undefined) {
        const predecessor = state.sessions[command.predecessorSessionId];
        if (
          predecessor === undefined ||
          predecessor.status === "started" ||
          predecessor.status === "requested"
        ) {
          return reject(
            state,
            envelope.commandId,
            "invalid_transition",
            "retry predecessor is not terminal",
          );
        }
        if (command.sessionId === command.predecessorSessionId) {
          return reject(
            state,
            envelope.commandId,
            "invalid_transition",
            "retry must allocate a new session identity",
          );
        }
        if (command.attempt !== predecessor.attempt + 1) {
          return reject(
            state,
            envelope.commandId,
            "policy_rejected",
            "retry attempt must immediately follow its predecessor",
          );
        }
      }
      if (command.attempt > state.policy.maxAttempts) {
        return reject(state, envelope.commandId, "policy_rejected", "attempt exceeds policy limit");
      }
      if (leaseConflicts(state, command.resourceId, context.now ?? command.deadline)) {
        return reject(
          state,
          envelope.commandId,
          "resource_conflict",
          "workspace resource is already leased",
        );
      }
      const session = sessionBase(
        state.projectId,
        command.sessionId,
        work.workId,
        command.profileId,
        command.attempt,
        command.contextReference,
        command.deadline,
        command.outputLimit,
        command.toolBudget,
        command.predecessorSessionId,
      );
      const lease = {
        _tag: "WorkspaceLease" as const,
        resourceId: command.resourceId,
        sessionId: command.sessionId,
        mode: "write" as const,
        acquiredAt: context.now ?? command.deadline,
        expiresAt: command.deadline,
        effectId: command.effectId,
      };
      const spec = {
        _tag: "SessionStartSpec" as const,
        sessionId: command.sessionId,
        effectId: command.effectId,
        projectId: state.projectId,
        workId: work.workId,
        profileId: command.profileId,
        attempt: command.attempt,
        ...(command.predecessorSessionId === undefined
          ? {}
          : { predecessorSessionId: command.predecessorSessionId }),
        deadline: command.deadline,
        outputLimit: command.outputLimit,
        toolBudget: command.toolBudget,
        workspaceLease: lease,
      };
      const effect = {
        _tag: "StartSessionEffect" as const,
        effectId: command.effectId,
        sessionId: command.sessionId,
        attempt: command.attempt,
        spec,
      };
      return accepted(state, envelope.commandId, { _tag: "SessionRequested", session, effect }, [
        effect,
      ]);
    }
    case "ReportSessionStarted": {
      if (
        authorized(state, actor, "session.started", context, { sessionId: command.sessionId }) ===
        undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks session.started");
      }
      const session = state.sessions[command.sessionId];
      if (session === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "session does not exist");
      if (session.status !== "requested") {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "only a requested session can start",
        );
      }
      return accepted(state, envelope.commandId, {
        _tag: "SessionStarted",
        sessionId: command.sessionId,
        workspaceViewId: command.workspaceViewId,
        startedAt: command.startedAt,
      });
    }
    case "CancelSession": {
      if (
        authorized(state, actor, "session.cancel", context, { sessionId: command.sessionId }) ===
        undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks session.cancel");
      }
      const session = state.sessions[command.sessionId];
      if (session === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "session does not exist");
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "interrupted"
      ) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "terminal session cannot be cancelled",
        );
      }
      const effect = {
        _tag: "CancelSessionEffect" as const,
        effectId: command.effectId,
        sessionId: command.sessionId,
        reason: command.reason,
      };
      return accepted(
        state,
        envelope.commandId,
        {
          _tag: "SessionCancellationRequested",
          sessionId: command.sessionId,
          effect,
        },
        [effect],
      );
    }
    case "ReportSessionTerminal": {
      if (
        authorized(state, actor, "session.terminal", context, { sessionId: command.sessionId }) ===
        undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks session.terminal");
      }
      const session = state.sessions[command.sessionId];
      if (session === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "session does not exist");
      if (
        session.status === "completed" ||
        session.status === "failed" ||
        session.status === "interrupted"
      ) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "first terminal event already won",
        );
      }
      if (command.status === "completed" && session.status !== "started") {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "only a started session can complete",
        );
      }
      return accepted(state, envelope.commandId, eventForTerminal(command));
    }
    case "RecordHandoff": {
      const handoff = command.handoff;
      if (
        authorized(state, actor, "handoff.record", context, {
          sessionId: handoff.producerSessionId,
        }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks handoff.record");
      }
      const session = state.sessions[handoff.producerSessionId];
      if (session === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "session does not exist");
      if (!["completed", "failed", "interrupted"].includes(session.status)) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "handoff requires a terminal session",
        );
      }
      if (state.handoffs[handoff.handoffId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "handoff identity already exists",
        );
      }
      if (handoff.projectId !== state.projectId)
        return reject(state, envelope.commandId, "project_not_found", "handoff project mismatch");
      return accepted(state, envelope.commandId, { _tag: "HandoffRecorded", handoff });
    }
    case "RecordEvidence": {
      const evidence = command.evidence;
      if (
        evidence.producerSessionId === undefined ||
        authorized(state, actor, "evidence.record", context, {
          sessionId: evidence.producerSessionId,
        }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks evidence.record");
      }
      if (!evidenceBelongsToProject(state, evidence)) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "evidence provenance is not in this project",
        );
      }
      if (evidence.producerSessionId === undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "recorded evidence needs a producer session",
        );
      }
      const evidenceShapeValid =
        (evidence.kind !== "machine_check" ||
          (evidence.check !== undefined && evidence.candidateDigest !== undefined)) &&
        (evidence.kind !== "scope_check" || evidence.scope !== undefined) &&
        (evidence.kind !== "session_terminal" || evidence.terminalStatus !== undefined) &&
        (evidence.kind !== "candidate_manifest" || evidence.candidateDigest !== undefined) &&
        (evidence.kind !== "human_approval" ||
          (evidence.producerActorId !== undefined && evidence.candidateDigest !== undefined));
      if (!evidenceShapeValid) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "evidence payload is incomplete for its declared kind",
        );
      }
      if (state.evidence[evidence.evidenceId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "evidence identity already exists",
        );
      }
      return accepted(state, envelope.commandId, { _tag: "EvidenceRecorded", evidence });
    }
    case "SubmitProposal": {
      const proposal = command.proposal;
      if (
        authorized(state, actor, "proposal.submit", context, {
          sessionId: proposal.proposerSessionId,
        }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks proposal.submit");
      }
      const session = state.sessions[proposal.proposerSessionId];
      if (session === undefined || session.status !== "completed") {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "proposal requires a completed producer session",
        );
      }
      if (proposal.projectId !== state.projectId) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "proposal provenance is invalid",
        );
      }
      if (!validManifest(proposal.candidate)) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "candidate manifest paths are not sorted",
        );
      }
      let candidateEvidence = false;
      for (const evidenceId of proposal.evidenceIds) {
        const evidence = state.evidence[evidenceId];
        if (evidence === undefined || evidence.projectId !== state.projectId) {
          return reject(
            state,
            envelope.commandId,
            "invalid_transition",
            "proposal references unaccepted evidence",
          );
        }
        if (
          evidence.kind === "candidate_manifest" &&
          evidence.role === "candidate_present" &&
          evidence.subject.subjectType === "proposal" &&
          evidence.subject.subjectId === proposal.proposalId &&
          evidence.candidateDigest === proposal.candidate.digest &&
          evidence.payloadDigest === proposal.candidate.digest
        ) {
          candidateEvidence = true;
        }
      }
      if (!candidateEvidence) {
        return reject(
          state,
          envelope.commandId,
          "artifact_missing",
          "proposal candidate manifest is not verified",
        );
      }
      if (state.proposals[proposal.proposalId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "proposal identity already exists",
        );
      }
      return accepted(state, envelope.commandId, { _tag: "ProposalSubmitted", proposal });
    }
    case "ApproveProposal": {
      const proposal = state.proposals[command.proposalId];
      if (proposal === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "proposal does not exist");
      if (proposal.status !== "submitted")
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "proposal is not awaiting approval",
        );
      if (
        actor.kind !== "operator" ||
        authorized(state, actor, "proposal.approve", context, {
          proposalId: proposal.proposalId,
        }) === undefined
      ) {
        return reject(
          state,
          envelope.commandId,
          "unauthorized",
          "only a granted operator may approve",
        );
      }
      const evidence = command.evidence;
      if (
        evidence.kind !== "human_approval" ||
        evidence.role !== "human_approval" ||
        evidence.producerActorId !== actor.actorId ||
        evidence.subject.subjectType !== "proposal" ||
        evidence.subject.subjectId !== proposal.proposalId ||
        evidence.candidateDigest !== proposal.candidate.digest ||
        evidence.projectId !== state.projectId
      ) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "approval evidence is not bound to this proposal",
        );
      }
      if (state.evidence[evidence.evidenceId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "approval evidence identity already exists",
        );
      }
      return accepted(state, envelope.commandId, {
        _tag: "ApprovalRecorded",
        proposalId: proposal.proposalId,
        evidence,
      });
    }
    case "RejectProposal": {
      const proposal = state.proposals[command.proposalId];
      if (proposal === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "proposal does not exist");
      if (proposal.status !== "submitted" && proposal.status !== "approved")
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "proposal is already terminal",
        );
      if (
        actor.kind !== "operator" ||
        authorized(state, actor, "proposal.reject", context, {
          proposalId: proposal.proposalId,
        }) === undefined
      ) {
        return reject(
          state,
          envelope.commandId,
          "unauthorized",
          "only a granted operator may reject",
        );
      }
      return accepted(state, envelope.commandId, {
        _tag: "ProposalRejected",
        proposalId: proposal.proposalId,
        reason: command.reason,
      });
    }
    case "MergeProposal": {
      const proposal = state.proposals[command.proposalId];
      if (proposal === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "proposal does not exist");
      if (proposal.status !== "submitted" && proposal.status !== "approved") {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "only a submitted or approved proposal can Merge",
        );
      }
      if (state.merges[command.mergeId] !== undefined) {
        return reject(
          state,
          envelope.commandId,
          "invalid_transition",
          "merge identity already exists",
        );
      }
      if (
        actor.kind === "project_manager" ||
        actor.kind === "worker_session" ||
        actor.kind === "session_host"
      ) {
        return reject(
          state,
          envelope.commandId,
          "unauthorized",
          "agent-scoped actors cannot Merge",
        );
      }
      const grant = authorized(state, actor, state.policy.mergeCapability, context, {
        proposalId: proposal.proposalId,
      });
      if (proposal.basisContentRevision !== state.contentRevision) {
        return reject(
          state,
          envelope.commandId,
          "proposal_stale",
          "proposal basis content revision is stale",
          {
            proposalContentRevision: proposal.basisContentRevision,
            observedContentRevision: state.contentRevision,
          },
        );
      }
      if (proposal.candidate.digest !== command.candidateDigest) {
        return reject(
          state,
          envelope.commandId,
          "proposal_stale",
          "Merge candidate digest differs from Proposal",
        );
      }
      if (actor.actorId === proposal.proposerSessionId) {
        return reject(
          state,
          envelope.commandId,
          "unauthorized",
          "the proposing Session cannot Merge itself",
        );
      }
      const decision = deriveGates(state, proposal);
      if (!decision.satisfied) {
        return reject(
          state,
          envelope.commandId,
          "gate_unsatisfied",
          "all five Merge Gates must be satisfied",
        );
      }
      const receipt = {
        _tag: "MergeReceipt" as const,
        mergeId: command.mergeId,
        proposalId: proposal.proposalId,
        actorId: actor.actorId,
        grantId: grant.grantId,
        policyId: state.policy.policyId,
        policyRevision: state.policy.revision,
        gateKeys: state.policy.requiredGates,
        evidenceIds: proposal.evidenceIds,
        priorEventRevision: state.eventRevision,
        resultingEventRevision: eventRevision(state.eventRevision + 1),
        priorContentRevision: state.contentRevision,
        resultingContentRevision: contentRevision(state.contentRevision + 1),
        candidateDigest: proposal.candidate.digest,
      };
      return accepted(state, envelope.commandId, { _tag: "ProposalMerged", receipt });
    }
    case "AcquireWorkspaceLease": {
      const lease = command.lease;
      if (
        authorized(state, actor, "workspace.lease", context, { sessionId: lease.sessionId }) ===
        undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks workspace.lease");
      }
      if (state.sessions[lease.sessionId] === undefined)
        return reject(state, envelope.commandId, "invalid_transition", "session does not exist");
      if (leaseConflicts(state, lease.resourceId, lease.acquiredAt)) {
        return reject(
          state,
          envelope.commandId,
          "resource_conflict",
          "workspace resource is already leased",
        );
      }
      return accepted(state, envelope.commandId, { _tag: "WorkspaceLeaseAcquired", lease });
    }
    case "RenewWorkspaceLease": {
      const lease = state.resources[command.resourceId];
      if (
        authorized(state, actor, "workspace.heartbeat", context, {
          sessionId: command.sessionId,
        }) === undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks workspace.heartbeat");
      }
      if (lease === undefined || lease.sessionId !== command.sessionId)
        return reject(state, envelope.commandId, "lease_expired", "workspace lease is missing");
      if (
        (context.now ?? lease.expiresAt) >= lease.expiresAt ||
        command.expiresAt <= lease.expiresAt
      ) {
        return reject(
          state,
          envelope.commandId,
          "lease_expired",
          "workspace lease is expired or renewal is not later",
        );
      }
      return accepted(state, envelope.commandId, {
        _tag: "WorkspaceLeaseRenewed",
        resourceId: command.resourceId,
        sessionId: command.sessionId,
        expiresAt: command.expiresAt,
      });
    }
    case "ReleaseWorkspaceLease": {
      const lease = state.resources[command.resourceId];
      if (
        authorized(state, actor, "workspace.lease", context, { sessionId: command.sessionId }) ===
        undefined
      ) {
        return reject(state, envelope.commandId, "unauthorized", "actor lacks workspace.lease");
      }
      if (lease === undefined || lease.sessionId !== command.sessionId)
        return reject(state, envelope.commandId, "lease_expired", "workspace lease is missing");
      return accepted(state, envelope.commandId, {
        _tag: "WorkspaceLeaseReleased",
        resourceId: command.resourceId,
        sessionId: command.sessionId,
      });
    }
  }
};

export const transition = (
  state: ProjectState | undefined,
  input: CommandEnvelope | CreateProjectRequest,
  context: TransitionContext = {},
): TransitionOutcome => {
  if (!("projectId" in input)) {
    if (state !== undefined) {
      const prior = state.commandReceipts[input.commandId];
      if (prior !== undefined) return alreadyAppliedWithState(state, prior);
      return reject(state, input.commandId, "invalid_transition", "a Project already exists");
    }
    const projectId = context.projectId;
    if (projectId === undefined) {
      return {
        state: undefined,
        result: {
          _tag: "Rejected",
          eventRevision: 0 as EventRevision,
          code: "invalid_transition",
          details: { reason: "trusted Project identity is required" },
        },
      };
    }
    const actor = context.actor ?? defaultActor;
    if (actor.kind !== "operator" && actor.kind !== "system") {
      return {
        state: undefined,
        result: {
          _tag: "Rejected",
          eventRevision: 0 as EventRevision,
          code: "unauthorized",
          details: { reason: "only trusted Project creators may bootstrap" },
        },
      };
    }
    const created = emptyProjectState(projectId, input.command.policy, input.command.grants ?? []);
    return accepted(created, input.commandId, {
      _tag: "ProjectCreated",
      projectId,
      policy: input.command.policy,
    });
  }
  if (state === undefined) {
    return {
      state: undefined,
      result: {
        _tag: "Rejected",
        eventRevision: 0 as EventRevision,
        code: "project_not_found",
        details: { reason: "Project authority has no state" },
      },
    };
  }
  return dispatchCommand(state, input, context);
};

export const applyCommand = transition;
export const reduceCommand = transition;

export const createProject = (
  request: CreateProjectRequest,
  projectId: ProjectId,
  actor?: AuthenticatedActor,
): TransitionOutcome => transition(undefined, request, { projectId, actor });

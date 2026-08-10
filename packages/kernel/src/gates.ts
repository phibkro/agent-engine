import type {
  ContentRevision,
  EventRevision,
  Evidence,
  EvidenceId,
  GateKey,
  PolicyId,
  Proposal,
  ProjectId,
} from "@work-engine/protocol";
import type { ProjectState } from "./state.ts";

export interface GateEvaluation {
  readonly gateKey: GateKey;
  readonly satisfied: boolean;
  readonly evidenceIds: readonly EvidenceId[];
  readonly sourceEventRevision: EventRevision;
  readonly sourceContentRevision: ContentRevision;
  readonly policyId: PolicyId;
  readonly reason: string;
}

export interface GateDecision {
  readonly proposalId: Proposal["proposalId"];
  readonly projectId: ProjectId;
  readonly policyId: PolicyId;
  readonly policyRevision: EventRevision;
  readonly evaluations: readonly GateEvaluation[];
  readonly satisfied: boolean;
}

const pathWithin = (path: string, scope: string): boolean => {
  const normalizedScope = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return path === normalizedScope || path.startsWith(`${normalizedScope}/`);
};

const evidenceFor = (state: ProjectState, proposal: Proposal): readonly Evidence[] =>
  proposal.evidenceIds.flatMap((id) => {
    const evidence = state.evidence[id];
    return evidence === undefined ? [] : [evidence];
  });

const evidenceMatchesSubject = (
  evidence: Evidence,
  proposal: Proposal,
  subjectType: "proposal" | "session" | "work",
  subjectId: string,
): boolean =>
  evidence.projectId === proposal.projectId &&
  evidence.subject.subjectType === subjectType &&
  evidence.subject.subjectId === subjectId &&
  (subjectType === "proposal" || evidence.producerSessionId === proposal.proposerSessionId);

const gateSatisfied = (
  state: ProjectState,
  proposal: Proposal,
  gate: GateKey,
  evidence: readonly Evidence[],
): {
  readonly satisfied: boolean;
  readonly evidenceIds: readonly EvidenceId[];
  readonly reason: string;
} => {
  const session = state.sessions[proposal.proposerSessionId];
  const work = session === undefined ? undefined : state.works[session.workId];
  switch (gate) {
    case "gat_session_completed": {
      const matches = evidence.filter(
        (candidate) =>
          candidate.kind === "session_terminal" &&
          candidate.role === "session_completion" &&
          candidate.terminalStatus === "completed" &&
          evidenceMatchesSubject(candidate, proposal, "session", proposal.proposerSessionId),
      );
      return {
        satisfied: session?.status === "completed" && matches.length > 0,
        evidenceIds: matches.map((item) => item.evidenceId),
        reason: session?.status === "completed" ? "completed" : "session_not_completed",
      };
    }
    case "gat_candidate_present": {
      const matches = evidence.filter(
        (candidate) =>
          candidate.kind === "candidate_manifest" &&
          candidate.role === "candidate_present" &&
          candidate.producerSessionId === proposal.proposerSessionId &&
          candidate.candidateDigest === proposal.candidate.digest &&
          candidate.payloadDigest === proposal.candidate.digest &&
          evidenceMatchesSubject(candidate, proposal, "proposal", proposal.proposalId),
      );
      return {
        satisfied: matches.length > 0,
        evidenceIds: matches.map((item) => item.evidenceId),
        reason: matches.length > 0 ? "candidate_present" : "candidate_missing",
      };
    }
    case "gat_scope_valid": {
      const matches = evidence.filter(
        (candidate) =>
          candidate.kind === "scope_check" &&
          candidate.role === "scope_valid" &&
          candidate.producerSessionId === proposal.proposerSessionId &&
          candidate.scope !== undefined &&
          evidenceMatchesSubject(candidate, proposal, "proposal", proposal.proposalId) &&
          work !== undefined &&
          candidate.scope.changedPaths.every((path) =>
            work.writableScope.some((scope) => pathWithin(path, scope)),
          ),
      );
      return {
        satisfied: matches.length > 0,
        evidenceIds: matches.map((item) => item.evidenceId),
        reason: matches.length > 0 ? "scope_valid" : "scope_outside_work_scope",
      };
    }
    case "gat_check_passed": {
      const matches = evidence.filter(
        (candidate) =>
          candidate.kind === "machine_check" &&
          candidate.role === "check_passed" &&
          candidate.producerSessionId === proposal.proposerSessionId &&
          candidate.check !== undefined &&
          candidate.check.exitCode === 0 &&
          candidate.check.command === work?.requiredCheck &&
          candidate.check.candidateDigest === proposal.candidate.digest &&
          candidate.candidateDigest === proposal.candidate.digest &&
          evidenceMatchesSubject(candidate, proposal, "proposal", proposal.proposalId),
      );
      return {
        satisfied: matches.length > 0,
        evidenceIds: matches.map((item) => item.evidenceId),
        reason: matches.length > 0 ? "check_passed" : "check_not_passed",
      };
    }
    case "gat_human_approved": {
      const matches = evidence.filter(
        (candidate) =>
          candidate.kind === "human_approval" &&
          candidate.role === "human_approval" &&
          candidate.producerActorId !== undefined &&
          candidate.candidateDigest === proposal.candidate.digest &&
          candidate.payloadDigest === proposal.candidate.digest &&
          evidenceMatchesSubject(candidate, proposal, "proposal", proposal.proposalId),
      );
      return {
        satisfied: matches.length > 0,
        evidenceIds: matches.map((item) => item.evidenceId),
        reason: matches.length > 0 ? "human_approved" : "human_approval_missing",
      };
    }
  }
};

export const deriveGates = (state: ProjectState, proposal: Proposal): GateDecision => {
  const evidence = evidenceFor(state, proposal);
  const evaluations = state.policy.requiredGates.map((gateKey) => {
    const result = gateSatisfied(state, proposal, gateKey, evidence);
    return {
      gateKey,
      ...result,
      sourceEventRevision: state.eventRevision,
      sourceContentRevision: state.contentRevision,
      policyId: state.policy.policyId,
    };
  });
  return {
    proposalId: proposal.proposalId,
    projectId: proposal.projectId,
    policyId: state.policy.policyId,
    policyRevision: state.policy.revision,
    evaluations,
    satisfied: evaluations.every((evaluation) => evaluation.satisfied),
  };
};

export const evaluateGates = deriveGates;
export const gatesSatisfied = (state: ProjectState, proposal: Proposal): boolean =>
  deriveGates(state, proposal).satisfied;

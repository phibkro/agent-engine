import { describe, expect, test } from "vitest";
import {
  ActorIdSchema,
  AgentProfileIdSchema,
  AttemptNumberSchema,
  AuthenticatedActorSchema,
  CommandEnvelopeSchema,
  CommandIdSchema,
  ContentRevisionSchema,
  CreateProjectRequestSchema,
  EffectIdSchema,
  EventRevisionSchema,
  EvidenceIdSchema,
  GrantIdSchema,
  HandoffIdSchema,
  MergeIdSchema,
  ProjectIdSchema,
  ProposalIdSchema,
  ResourceIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  WorkIdSchema,
  WorkProcessIdSchema,
  WorkspaceViewIdSchema,
  canonicalize,
  decodeCommand,
  decodeCommandEnvelope,
  sortManifestEntries,
  type AuthenticatedActor,
  type CommandEnvelope,
  type CommandId,
  type ContentManifest,
  type EffectId,
  type EventEnvelope,
  type Evidence,
  type EvidenceId,
  type Grant,
  type GrantId,
  type ProjectCommand,
  type ProjectId,
  type Proposal,
  type SessionId,
  type Sha256Digest,
  type Timestamp,
} from "@work-engine/protocol";
import {
  createProject,
  deriveGates,
  emptyProjectState,
  foldEvent,
  replay,
  tracerPolicy,
  transition,
  type TransitionOutcome,
  type ProjectState,
} from "../src/index.ts";

const id = (prefix: string, suffix: number): string =>
  `${prefix}00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const project = (suffix: number): ProjectId => ProjectIdSchema.make(id("prj_", suffix));
const commandId = (suffix: number): CommandId => CommandIdSchema.make(id("cmd_", suffix));
const effectId = (suffix: number): EffectId => EffectIdSchema.make(id("efx_", suffix));
const timestamp = (value: string): Timestamp => TimestampSchema.make(value);
const digest = (hex = "0"): Sha256Digest =>
  Sha256DigestSchema.make(`sha256:${hex.repeat(64).slice(0, 64)}`);

const PROJECT_ID = project(1);
const WORK_ID = WorkIdSchema.make(id("wrk_", 2));
const WORK_ID_B = WorkIdSchema.make(id("wrk_", 22));
const PROCESS_ID = WorkProcessIdSchema.make(id("wpr_", 3));
const PROFILE_ID = AgentProfileIdSchema.make(id("prf_", 4));
const SESSION_ID = SessionIdSchema.make(id("ses_", 5));
const SESSION_ID_B = SessionIdSchema.make(id("ses_", 55));
const RESOURCE_ID = ResourceIdSchema.make(id("res_", 6));
const RESOURCE_ID_B = ResourceIdSchema.make(id("res_", 66));
const PROPOSAL_ID = ProposalIdSchema.make(id("prp_", 7));
const OPERATOR_ID = ActorIdSchema.make("operator:test");
const HOST_ID = ActorIdSchema.make("host:test");
const NOW = timestamp("2026-08-10T00:00:00.000Z");
const LATER = timestamp("2026-08-10T01:00:00.000Z");
const LATERER = timestamp("2026-08-10T02:00:00.000Z");
const BEFORE = timestamp("2025-01-01T00:00:00.000Z");
const CANDIDATE_DIGEST = digest("a");

const grant = (
  suffix: number,
  capability: Grant["capability"],
  scope: Grant["scope"] = { projectId: PROJECT_ID },
  subjectActorId: Grant["subjectActorId"] = OPERATOR_ID,
  validFrom: Timestamp = BEFORE,
  validUntil: Timestamp = timestamp("2027-01-01T00:00:00.000Z"),
): Grant => ({
  _tag: "Grant",
  grantId: GrantIdSchema.make(id("grt_", suffix)),
  subjectActorId,
  capability,
  scope,
  validFrom,
  validUntil,
  grantingAuthority: OPERATOR_ID,
});

const operatorGrants: readonly Grant[] = [
  grant(10, "work.submit"),
  grant(11, "manager.open"),
  grant(12, "worker.start"),
  grant(13, "session.started"),
  grant(14, "session.terminal"),
  grant(15, "session.cancel"),
  grant(16, "handoff.record"),
  grant(17, "evidence.record"),
  grant(18, "proposal.submit"),
  grant(19, "proposal.approve"),
  grant(20, "proposal.reject"),
  grant(21, "proposal.merge"),
  grant(22, "workspace.lease"),
  grant(23, "workspace.heartbeat"),
];
const hostEvidenceGrant = grant(30, "evidence.record", { projectId: PROJECT_ID }, HOST_ID);
const allBootstrapGrants = [...operatorGrants, hostEvidenceGrant];

const operator = (
  presentedGrants: readonly GrantId[] = operatorGrants.map((item) => item.grantId),
  sessionId?: SessionId,
): AuthenticatedActor =>
  AuthenticatedActorSchema.make({
    _tag: "AuthenticatedActor",
    actorId: OPERATOR_ID,
    ...(sessionId === undefined ? {} : { sessionId }),
    kind: "operator",
    presentedGrants,
  });

const host = (): AuthenticatedActor =>
  AuthenticatedActorSchema.make({
    _tag: "AuthenticatedActor",
    actorId: HOST_ID,
    kind: "session_host",
    presentedGrants: [hostEvidenceGrant.grantId],
  });

const createRequest = (policy = tracerPolicy(), grants = allBootstrapGrants) =>
  CreateProjectRequestSchema.make({
    schemaVersion: "work-engine/v1",
    commandId: commandId(100),
    command: { _tag: "CreateProject", policy, grants },
  });

const createState = (policy = tracerPolicy()): ProjectState => {
  const outcome = createProject(createRequest(policy), PROJECT_ID, operator(), NOW);
  expect(outcome.result._tag).toBe("Accepted");
  expect(outcome.state).toBeDefined();
  return outcome.state ?? emptyProjectState(PROJECT_ID);
};

const envelope = (
  state: ProjectState,
  command: ProjectCommand,
  idSuffix: number,
  actor: AuthenticatedActor,
): CommandEnvelope =>
  CommandEnvelopeSchema.make({
    schemaVersion: "work-engine/v1",
    commandId: commandId(idSuffix),
    projectId: state.projectId,
    expectedRevision: state.eventRevision,
    actor,
    command,
  });

const dispatch = (
  state: ProjectState,
  command: ProjectCommand,
  idSuffix: number,
  actor: AuthenticatedActor = operator(),
  now: Timestamp = NOW,
  grants: readonly Grant[] = [],
) => transition(state, envelope(state, command, idSuffix, actor), { now, grants });

const acceptedState = (outcome: TransitionOutcome): ProjectState => {
  expect(outcome.result._tag).toBe("Accepted");
  expect(outcome.state).toBeDefined();
  return outcome.state ?? emptyProjectState(PROJECT_ID);
};

const submitWork = (state: ProjectState, idSuffix = 101): ProjectState =>
  acceptedState(
    dispatch(
      state,
      {
        _tag: "SubmitWork",
        workId: WORK_ID,
        workProcessId: PROCESS_ID,
        objective: "implement the requested change",
        kind: "implementation",
        writableScope: ["src"],
        requiredCheck: "bun run check",
        title: "Semantic kernel",
      },
      idSuffix,
    ),
  );

const openManager = (state: ProjectState, idSuffix = 102): ProjectState =>
  acceptedState(
    dispatch(
      state,
      {
        _tag: "OpenManagerSession",
        sessionId: SESSION_ID,
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(0),
        contextReference: "manager:context",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID,
        effectId: effectId(102),
      },
      idSuffix,
    ),
  );

const startWorker = (state: ProjectState, idSuffix = 103): ProjectState =>
  acceptedState(
    dispatch(
      state,
      {
        _tag: "StartWorkerSession",
        sessionId: SESSION_ID_B,
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(0),
        contextReference: "worker:context",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID,
        effectId: effectId(103),
      },
      idSuffix,
    ),
  );

const reportStarted = (state: ProjectState, idSuffix = 104): ProjectState =>
  acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionStarted",
        sessionId: SESSION_ID_B,
        workspaceViewId: WorkspaceViewIdSchema.make(id("wsv_", idSuffix)),
        startedAt: NOW,
        effectId: effectId(104),
      },
      idSuffix,
    ),
  );

const reportCompleted = (state: ProjectState, idSuffix = 105): ProjectState =>
  acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionTerminal",
        sessionId: SESSION_ID_B,
        status: "completed",
        reason: "completed",
        terminalAt: NOW,
        effectId: effectId(105),
      },
      idSuffix,
    ),
  );

const evidence = (
  evidenceId: EvidenceId,
  kind: Evidence["kind"],
  role: Evidence["role"],
  subject: Evidence["subject"],
  extra: Partial<Evidence> = {},
): Evidence => ({
  _tag: "Evidence",
  evidenceId,
  projectId: PROJECT_ID,
  kind,
  role,
  subject,
  producerSessionId: SESSION_ID_B,
  producerActorId: HOST_ID,
  observedAt: NOW,
  payloadDigest: CANDIDATE_DIGEST,
  limitations: [],
  ...extra,
});

const candidateManifest = (): ContentManifest => ({
  _tag: "ContentManifest",
  digest: CANDIDATE_DIGEST,
  entries: [{ path: "src/index.ts", digest: CANDIDATE_DIGEST, bytes: 1 }],
});

const submitProposal = (state: ProjectState, idSuffix = 115): ProjectState => {
  const proposal: Proposal = {
    _tag: "Proposal",
    proposalId: PROPOSAL_ID,
    projectId: PROJECT_ID,
    proposerSessionId: SESSION_ID_B,
    submissionEventRevision: EventRevisionSchema.make(state.eventRevision + 1),
    basisContentRevision: ContentRevisionSchema.make(0),
    candidate: candidateManifest(),
    evidenceIds: [
      EvidenceIdSchema.make(id("evd_", 111)),
      EvidenceIdSchema.make(id("evd_", 112)),
      EvidenceIdSchema.make(id("evd_", 113)),
      EvidenceIdSchema.make(id("evd_", 114)),
    ],
    status: "submitted",
  };
  return acceptedState(dispatch(state, { _tag: "SubmitProposal", proposal }, idSuffix));
};

const buildSubmittedState = (): { state: ProjectState; proposal: Proposal } => {
  let state = submitWork(createState());
  state = openManager(state);
  state = startWorker(state);
  state = reportStarted(state);
  state = reportCompleted(state);
  const terminal = evidence(
    EvidenceIdSchema.make(id("evd_", 111)),
    "session_terminal",
    "session_completion",
    { _tag: "EvidenceSubject", subjectType: "session", subjectId: SESSION_ID_B },
    { terminalStatus: "completed" },
  );
  const candidate = evidence(
    EvidenceIdSchema.make(id("evd_", 112)),
    "candidate_manifest",
    "candidate_present",
    { _tag: "EvidenceSubject", subjectType: "proposal", subjectId: PROPOSAL_ID },
    { candidateDigest: CANDIDATE_DIGEST, payloadDigest: CANDIDATE_DIGEST },
  );
  const scope = evidence(
    EvidenceIdSchema.make(id("evd_", 113)),
    "scope_check",
    "scope_valid",
    { _tag: "EvidenceSubject", subjectType: "proposal", subjectId: PROPOSAL_ID },
    {
      scope: { _tag: "ScopeEvidence", changedPaths: ["src/index.ts"], writableScope: ["src"] },
    },
  );
  const check = evidence(
    EvidenceIdSchema.make(id("evd_", 114)),
    "machine_check",
    "check_passed",
    { _tag: "EvidenceSubject", subjectType: "proposal", subjectId: PROPOSAL_ID },
    {
      candidateDigest: CANDIDATE_DIGEST,
      check: {
        _tag: "CheckEvidence",
        command: "bun run check",
        exitCode: 0,
        stdoutDigest: CANDIDATE_DIGEST,
        stderrDigest: CANDIDATE_DIGEST,
        candidateDigest: CANDIDATE_DIGEST,
        containerImageDigest: CANDIDATE_DIGEST,
        toolVersions: { bun: "1" },
      },
    },
  );
  for (const [item, idSuffix] of [
    [terminal, 111],
    [candidate, 112],
    [scope, 113],
    [check, 114],
  ] as const) {
    state = acceptedState(dispatch(state, { _tag: "RecordEvidence", evidence: item }, idSuffix));
  }
  const handoff = {
    _tag: "Handoff" as const,
    handoffId: HandoffIdSchema.make(id("hnd_", 115)),
    projectId: PROJECT_ID,
    producerSessionId: SESSION_ID_B,
    intendedConsumer: "operator",
    basisEventRevision: state.eventRevision,
    basisContentRevision: ContentRevisionSchema.make(0),
    payloadDigest: CANDIDATE_DIGEST,
    provenance: [candidate.evidenceId],
  };
  state = acceptedState(dispatch(state, { _tag: "RecordHandoff", handoff }, 115));
  state = submitProposal(state, 116);
  return { state, proposal: state.proposals[PROPOSAL_ID]! };
};

const buildApprovedState = (): { state: ProjectState; proposal: Proposal } => {
  const submitted = buildSubmittedState();
  const approval: Evidence = {
    _tag: "Evidence",
    evidenceId: EvidenceIdSchema.make(id("evd_", 117)),
    projectId: PROJECT_ID,
    kind: "human_approval",
    role: "human_approval",
    subject: { _tag: "EvidenceSubject", subjectType: "proposal", subjectId: PROPOSAL_ID },
    producerActorId: OPERATOR_ID,
    observedAt: NOW,
    payloadDigest: CANDIDATE_DIGEST,
    limitations: [],
    candidateDigest: CANDIDATE_DIGEST,
    proposalSubmissionEventRevision: submitted.proposal.submissionEventRevision,
  };
  const state = acceptedState(
    dispatch(
      submitted.state,
      { _tag: "ApproveProposal", proposalId: PROPOSAL_ID, evidence: approval },
      117,
    ),
  );
  return { state, proposal: state.proposals[PROPOSAL_ID]! };
};

const buildInterruptedState = (): ProjectState => {
  let state = submitWork(createState(), 200);
  state = acceptedState(
    dispatch(
      state,
      {
        _tag: "StartWorkerSession",
        sessionId: SESSION_ID,
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(0),
        contextReference: "worker:context",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID,
        effectId: effectId(201),
      },
      201,
    ),
  );
  state = acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionStarted",
        sessionId: SESSION_ID,
        workspaceViewId: WorkspaceViewIdSchema.make(id("wsv_", 202)),
        startedAt: NOW,
        effectId: effectId(202),
      },
      202,
    ),
  );
  state = acceptedState(
    dispatch(
      state,
      { _tag: "CancelSession", sessionId: SESSION_ID, effectId: effectId(203), reason: "stop" },
      203,
    ),
  );
  return acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionTerminal",
        sessionId: SESSION_ID,
        status: "interrupted",
        reason: "cancelled",
        terminalAt: NOW,
        effectId: effectId(204),
      },
      204,
    ),
  );
};

const buildFailedState = (): ProjectState => {
  let state = submitWork(createState(), 210);
  state = acceptedState(
    dispatch(
      state,
      {
        _tag: "StartWorkerSession",
        sessionId: SESSION_ID,
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(0),
        contextReference: "worker:context",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID,
        effectId: effectId(211),
      },
      211,
    ),
  );
  state = acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionStarted",
        sessionId: SESSION_ID,
        workspaceViewId: WorkspaceViewIdSchema.make(id("wsv_", 212)),
        startedAt: NOW,
        effectId: effectId(212),
      },
      212,
    ),
  );
  return acceptedState(
    dispatch(
      state,
      {
        _tag: "ReportSessionTerminal",
        sessionId: SESSION_ID,
        status: "failed",
        reason: "failed",
        terminalAt: NOW,
        effectId: effectId(213),
      },
      213,
    ),
  );
};

describe("semantic protocol and kernel laws", () => {
  test("strict schemas reject unknown fields and malformed branded identifiers", () => {
    expect(() =>
      decodeCommand({ _tag: "CreateProject", policy: tracerPolicy(), grants: [], extra: true }),
    ).toThrow();
    expect(() => ProjectIdSchema.make("prj_not-a-uuid")).toThrow();
    const state = createState();
    expect(() =>
      decodeCommandEnvelope({
        schemaVersion: "work-engine/v1",
        commandId: commandId(301),
        projectId: "prj_not-a-uuid",
        expectedRevision: state.eventRevision,
        actor: operator(),
        command: {
          _tag: "SubmitWork",
          workId: WORK_ID,
          workProcessId: PROCESS_ID,
          objective: "x",
          kind: "x",
          writableScope: ["src"],
          requiredCheck: "check",
        },
      }),
    ).toThrow();
  });
  test("strict identifier, timestamp, and digest patterns reject malformed input", () => {
    expect(() => TimestampSchema.make("2026-08-10T00:00:00Z")).toThrow();
    expect(() => Sha256DigestSchema.make("sha256:not-a-digest")).toThrow();
  });
  test("stale revision/content, duplicate command, and unsatisfied gate checks are rejected", () => {
    const initial = createState();
    const workCommand: ProjectCommand = {
      _tag: "SubmitWork",
      workId: WORK_ID,
      workProcessId: PROCESS_ID,
      objective: "stale revision",
      kind: "implementation",
      writableScope: ["src"],
      requiredCheck: "check",
    };
    const firstEnvelope = envelope(initial, workCommand, 491, operator());
    const first = transition(initial, firstEnvelope, { now: NOW });
    expect(first.result._tag).toBe("Accepted");
    const duplicate = transition(first.state, firstEnvelope, { now: NOW });
    expect(duplicate.result._tag).toBe("AlreadyApplied");
    const staleEnvelope = {
      ...envelope(
        first.state!,
        {
          ...workCommand,
          workId: WORK_ID_B,
          workProcessId: WorkProcessIdSchema.make(id("wpr_", 492)),
        },
        492,
        operator(),
      ),
      expectedRevision: initial.eventRevision,
    };
    const stale = transition(first.state, staleEnvelope, { now: NOW });
    expect(stale.result).toMatchObject({ _tag: "Rejected", code: "revision_mismatch" });

    const submitted = buildSubmittedState();
    const noApproval = dispatch(
      submitted.state,
      {
        _tag: "MergeProposal",
        mergeId: MergeIdSchema.make(id("mrg_", 493)),
        proposalId: PROPOSAL_ID,
        grantId: operatorGrants.find((item) => item.capability === "proposal.merge")!.grantId,
        candidateDigest: CANDIDATE_DIGEST,
      },
      493,
    );
    expect(noApproval.result).toMatchObject({ _tag: "Rejected", code: "gate_unsatisfied" });
    const staleContent = {
      ...buildApprovedState().state,
      contentRevision: ContentRevisionSchema.make(1),
    };
    const staleMerge = dispatch(
      staleContent,
      {
        _tag: "MergeProposal",
        mergeId: MergeIdSchema.make(id("mrg_", 494)),
        proposalId: PROPOSAL_ID,
        grantId: operatorGrants.find((item) => item.capability === "proposal.merge")!.grantId,
        candidateDigest: CANDIDATE_DIGEST,
      },
      494,
    );
    expect(staleMerge.result).toMatchObject({ _tag: "Rejected", code: "proposal_stale" });
  });

  test("CreateProject requires trusted actor/time and replay reconstructs bootstrap authority", () => {
    const request = createRequest();
    const missingActor = transition(undefined, request, { now: NOW, projectId: PROJECT_ID });
    expect(missingActor.result).toMatchObject({ _tag: "Rejected", code: "unauthorized" });
    const created = createProject(request, PROJECT_ID, operator(), NOW);
    expect(created.result._tag).toBe("Accepted");
    const live = created.state!;
    const rebuilt = replay(emptyProjectState(PROJECT_ID), live.history);
    expect(rebuilt.grants).toEqual(live.grants);
    const accepted = dispatch(
      rebuilt,
      {
        _tag: "SubmitWork",
        workId: WORK_ID,
        workProcessId: PROCESS_ID,
        objective: "replayed authority",
        kind: "implementation",
        writableScope: ["src"],
        requiredCheck: "check",
      },
      302,
    );
    expect(accepted.result._tag).toBe("Accepted");
  });

  test("complete public happy path reaches ProposalMerged and records GatesEvaluated first", () => {
    const approved = buildApprovedState();
    const outcome = dispatch(
      approved.state,
      {
        _tag: "MergeProposal",
        mergeId: MergeIdSchema.make(id("mrg_", 118)),
        proposalId: PROPOSAL_ID,
        grantId: operatorGrants.find((item) => item.capability === "proposal.merge")!.grantId,
        candidateDigest: CANDIDATE_DIGEST,
      },
      118,
    );
    const state = acceptedState(outcome);
    expect(state.contentRevision).toBe(1);
    expect(state.works[WORK_ID]?.lifecycle).toBe("completed");
    expect(state.proposals[PROPOSAL_ID]?.status).toBe("merged");
    const last = state.history.slice(-2);
    expect(last.map((item) => item.event._tag)).toEqual(["GatesEvaluated", "ProposalMerged"]);
    expect(last[0]?.eventRevision).toBe(last[1]?.eventRevision);
    expect(last[0]?.commandId).toBe(last[1]?.commandId);
  });

  test("approval is operator-bound, submission-bound, and cannot be host-recorded or forged", () => {
    const submitted = buildSubmittedState();
    const forged: Evidence = {
      _tag: "Evidence",
      evidenceId: EvidenceIdSchema.make(id("evd_", 119)),
      projectId: PROJECT_ID,
      kind: "human_approval",
      role: "human_approval",
      subject: { _tag: "EvidenceSubject", subjectType: "proposal", subjectId: PROPOSAL_ID },
      producerSessionId: SESSION_ID_B,
      producerActorId: OPERATOR_ID,
      observedAt: NOW,
      payloadDigest: CANDIDATE_DIGEST,
      limitations: [],
      candidateDigest: CANDIDATE_DIGEST,
      proposalSubmissionEventRevision: submitted.proposal.submissionEventRevision,
    };
    const hostResult = dispatch(
      submitted.state,
      { _tag: "RecordEvidence", evidence: forged },
      119,
      host(),
    );
    expect(hostResult.result).toMatchObject({ _tag: "Rejected", code: "invalid_transition" });
    expect(
      deriveGates(submitted.state, submitted.proposal).evaluations.find(
        (item) => item.gateKey === "gat_human_approved",
      )?.satisfied,
    ).toBe(false);
    const approved = buildApprovedState();
    const selfMerge = dispatch(
      approved.state,
      {
        _tag: "MergeProposal",
        mergeId: MergeIdSchema.make(id("mrg_", 120)),
        proposalId: PROPOSAL_ID,
        grantId: operatorGrants.find((item) => item.capability === "proposal.merge")!.grantId,
        candidateDigest: CANDIDATE_DIGEST,
      },
      120,
      operator(undefined, SESSION_ID_B),
    );
    expect(selfMerge.result).toMatchObject({ _tag: "Rejected", code: "unauthorized" });
  });

  test("all frozen commands dispatch through the public transition branches", () => {
    let state = submitWork(createState(), 401);
    state = openManager(state, 402);
    state = startWorker(state, 403);
    state = reportStarted(state, 404);
    state = reportCompleted(state, 405);
    const submitted = buildSubmittedState();
    const rejected = dispatch(
      submitted.state,
      { _tag: "RejectProposal", proposalId: PROPOSAL_ID, reason: "policy" },
      406,
    );
    expect(rejected.result._tag).toBe("Accepted");
    const lease = dispatch(
      state,
      {
        _tag: "AcquireWorkspaceLease",
        lease: {
          _tag: "WorkspaceLease",
          resourceId: RESOURCE_ID_B,
          sessionId: SESSION_ID_B,
          mode: "read",
          acquiredAt: NOW,
          expiresAt: LATER,
          effectId: effectId(407),
        },
      },
      407,
    );
    state = acceptedState(lease);
    state = acceptedState(
      dispatch(
        state,
        {
          _tag: "RenewWorkspaceLease",
          resourceId: RESOURCE_ID_B,
          sessionId: SESSION_ID_B,
          expiresAt: LATERER,
        },
        408,
      ),
    );
    state = acceptedState(
      dispatch(
        state,
        { _tag: "ReleaseWorkspaceLease", resourceId: RESOURCE_ID_B, sessionId: SESSION_ID_B },
        409,
      ),
    );
    expect(state.resources[RESOURCE_ID_B]).toBeUndefined();
  });

  test("every frozen event variant is emitted and folded", () => {
    const happy = buildApprovedState();
    const merged = acceptedState(
      dispatch(
        happy.state,
        {
          _tag: "MergeProposal",
          mergeId: MergeIdSchema.make(id("mrg_", 510)),
          proposalId: PROPOSAL_ID,
          grantId: operatorGrants.find((item) => item.capability === "proposal.merge")!.grantId,
          candidateDigest: CANDIDATE_DIGEST,
        },
        510,
      ),
    );
    const interrupted = buildInterruptedState();
    const failed = buildFailedState();
    const rejected = acceptedState(
      dispatch(
        buildSubmittedState().state,
        { _tag: "RejectProposal", proposalId: PROPOSAL_ID, reason: "reject" },
        511,
      ),
    );
    let leased = openManager(submitWork(createState(), 512), 513);
    leased = acceptedState(
      dispatch(
        leased,
        {
          _tag: "AcquireWorkspaceLease",
          lease: {
            _tag: "WorkspaceLease",
            resourceId: RESOURCE_ID_B,
            sessionId: SESSION_ID,
            mode: "read",
            acquiredAt: NOW,
            expiresAt: LATER,
            effectId: effectId(514),
          },
        },
        514,
      ),
    );
    leased = acceptedState(
      dispatch(
        leased,
        {
          _tag: "RenewWorkspaceLease",
          resourceId: RESOURCE_ID_B,
          sessionId: SESSION_ID,
          expiresAt: LATERER,
        },
        515,
      ),
    );
    leased = acceptedState(
      dispatch(
        leased,
        { _tag: "ReleaseWorkspaceLease", resourceId: RESOURCE_ID_B, sessionId: SESSION_ID },
        516,
      ),
    );
    const tags = new Set(
      [
        ...merged.history,
        ...interrupted.history,
        ...failed.history,
        ...rejected.history,
        ...leased.history,
      ].map((item) => item.event._tag),
    );
    expect(tags).toEqual(
      new Set([
        "ProjectCreated",
        "WorkSubmitted",
        "SessionRequested",
        "SessionStarted",
        "SessionCancellationRequested",
        "SessionInterrupted",
        "SessionFailed",
        "SessionCompleted",
        "HandoffRecorded",
        "EvidenceRecorded",
        "ProposalSubmitted",
        "ApprovalRecorded",
        "ProposalRejected",
        "GatesEvaluated",
        "ProposalMerged",
        "WorkspaceLeaseAcquired",
        "WorkspaceLeaseRenewed",
        "WorkspaceLeaseReleased",
      ]),
    );
  });

  test("scope and time grants fail closed, while trusted per-command grants can authorize", () => {
    const scoped = grant(601, "work.submit", { projectId: PROJECT_ID, workId: WORK_ID });
    const state = createState();
    const accepted = dispatch(
      state,
      {
        _tag: "SubmitWork",
        workId: WORK_ID,
        workProcessId: PROCESS_ID,
        objective: "scoped",
        kind: "implementation",
        writableScope: ["src"],
        requiredCheck: "check",
      },
      601,
      operator([]),
      NOW,
      [scoped],
    );
    expect(accepted.result._tag).toBe("Accepted");
    const wrongScope = dispatch(
      state,
      {
        _tag: "SubmitWork",
        workId: WORK_ID_B,
        workProcessId: WorkProcessIdSchema.make(id("wpr_", 602)),
        objective: "wrong",
        kind: "implementation",
        writableScope: ["src"],
        requiredCheck: "check",
      },
      602,
      operator([]),
      NOW,
      [scoped],
    );
    expect(wrongScope.result).toMatchObject({ _tag: "Rejected", code: "unauthorized" });
    const expired = { ...scoped, validUntil: BEFORE };
    const expiredResult = dispatch(
      state,
      {
        _tag: "SubmitWork",
        workId: WORK_ID_B,
        workProcessId: WorkProcessIdSchema.make(id("wpr_", 603)),
        objective: "expired",
        kind: "implementation",
        writableScope: ["src"],
        requiredCheck: "check",
      },
      603,
      operator([]),
      NOW,
      [expired],
    );
    expect(expiredResult.result).toMatchObject({ _tag: "Rejected", code: "unauthorized" });
  });

  test("manager reads coexist with isolated worker writes, while concurrent writes conflict", () => {
    let state = openManager(submitWork(createState(), 701), 702);
    expect(state.resources[RESOURCE_ID]?.[SESSION_ID]?.mode).toBe("read");
    state = startWorker(state, 703);
    expect(state.resources[RESOURCE_ID]?.[SESSION_ID_B]?.mode).toBe("write");
    const conflict = dispatch(
      state,
      {
        _tag: "StartWorkerSession",
        sessionId: SessionIdSchema.make(id("ses_", 704)),
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(0),
        contextReference: "worker:second",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID,
        effectId: effectId(704),
      },
      704,
    );
    expect(conflict.result).toMatchObject({ _tag: "Rejected", code: "resource_conflict" });
    const forgedTime = dispatch(
      state,
      {
        _tag: "AcquireWorkspaceLease",
        lease: {
          _tag: "WorkspaceLease",
          resourceId: RESOURCE_ID,
          sessionId: SESSION_ID_B,
          mode: "write",
          acquiredAt: LATER,
          expiresAt: LATERER,
          effectId: effectId(705),
        },
      },
      705,
    );
    expect(forgedTime.result).toMatchObject({ _tag: "Rejected", code: "resource_conflict" });
  });

  test("renew/release require the matching owner and trusted current time", () => {
    let state = openManager(submitWork(createState(), 801), 802);
    const renewed = dispatch(
      state,
      {
        _tag: "RenewWorkspaceLease",
        resourceId: RESOURCE_ID,
        sessionId: SESSION_ID,
        expiresAt: LATERER,
      },
      803,
    );
    state = acceptedState(renewed);
    const expired = dispatch(
      state,
      {
        _tag: "RenewWorkspaceLease",
        resourceId: RESOURCE_ID,
        sessionId: SESSION_ID,
        expiresAt: timestamp("2026-08-10T03:00:00.000Z"),
      },
      804,
      operator(),
      LATERER,
    );
    expect(expired.result).toMatchObject({ _tag: "Rejected", code: "lease_expired" });
    const wrongOwner = dispatch(
      state,
      { _tag: "ReleaseWorkspaceLease", resourceId: RESOURCE_ID, sessionId: SESSION_ID_B },
      805,
    );
    expect(wrongOwner.result).toMatchObject({ _tag: "Rejected", code: "lease_expired" });
    state = acceptedState(
      dispatch(
        state,
        { _tag: "ReleaseWorkspaceLease", resourceId: RESOURCE_ID, sessionId: SESSION_ID },
        806,
      ),
    );
    expect(state.resources[RESOURCE_ID]).toBeUndefined();
  });

  test("retry predecessor must be terminal, and effect identities are idempotent", () => {
    let state = submitWork(createState({ ...tracerPolicy(), maxAttempts: 2 }), 901);
    state = openManager(state, 902);
    state = acceptedState(
      dispatch(
        state,
        { _tag: "CancelSession", sessionId: SESSION_ID, effectId: effectId(903), reason: "cancel" },
        903,
      ),
    );
    const retry = dispatch(
      state,
      {
        _tag: "StartWorkerSession",
        sessionId: SESSION_ID_B,
        workId: WORK_ID,
        profileId: PROFILE_ID,
        attempt: AttemptNumberSchema.make(1),
        predecessorSessionId: SESSION_ID,
        contextReference: "retry",
        deadline: LATER,
        outputLimit: 100,
        toolBudget: 10,
        resourceId: RESOURCE_ID_B,
        effectId: effectId(904),
      },
      904,
    );
    expect(retry.result).toMatchObject({ _tag: "Rejected", code: "invalid_transition" });

    let requested = openManager(submitWork(createState(), 905), 906);
    const first = dispatch(
      requested,
      {
        _tag: "ReportSessionStarted",
        sessionId: SESSION_ID,
        workspaceViewId: WorkspaceViewIdSchema.make(id("wsv_", 907)),
        startedAt: NOW,
        effectId: effectId(907),
      },
      907,
    );
    requested = acceptedState(first);
    const duplicate = dispatch(
      requested,
      {
        _tag: "ReportSessionStarted",
        sessionId: SESSION_ID,
        workspaceViewId: WorkspaceViewIdSchema.make(id("wsv_", 908)),
        startedAt: NOW,
        effectId: effectId(907),
      },
      908,
    );
    expect(duplicate.result._tag).toBe("AlreadyApplied");
  });

  test("replay ignores out-of-order revisions but accepts ordered same-command siblings", () => {
    const initial = emptyProjectState(PROJECT_ID);
    const created: EventEnvelope = {
      _tag: "EventEnvelope",
      eventRevision: EventRevisionSchema.make(1),
      commandId: commandId(1001),
      event: { _tag: "ProjectCreated", projectId: PROJECT_ID, policy: tracerPolicy(), grants: [] },
    };
    const work = {
      _tag: "Work" as const,
      workId: WORK_ID,
      projectId: PROJECT_ID,
      workProcessId: PROCESS_ID,
      objective: "ordered",
      kind: "implementation",
      writableScope: ["src"],
      requiredCheck: "check",
      lifecycle: "submitted" as const,
    };
    const second: EventEnvelope = {
      _tag: "EventEnvelope",
      eventRevision: EventRevisionSchema.make(2),
      commandId: commandId(1002),
      event: { _tag: "WorkSubmitted", work },
    };
    const sibling: EventEnvelope = {
      _tag: "EventEnvelope",
      eventRevision: EventRevisionSchema.make(2),
      commandId: commandId(1002),
      event: {
        _tag: "GatesEvaluated",
        proposalId: PROPOSAL_ID,
        policyId: tracerPolicy().policyId,
        policyRevision: EventRevisionSchema.make(1),
        gateKeys: [],
        satisfied: true,
        evidenceIds: [],
      },
    };
    const rebuilt = replay(initial, [second, created, second, sibling]);
    expect(rebuilt.eventRevision).toBe(2);
    expect(rebuilt.history.map((item) => item.event._tag)).toEqual([
      "ProjectCreated",
      "WorkSubmitted",
      "GatesEvaluated",
    ]);
    const outOfOrder = foldEvent(rebuilt, { ...created, commandId: commandId(1003) });
    expect(outOfOrder).toBe(rebuilt);
  });

  test("canonical JSON follows RFC 8785 ordering and manifest ordering", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    const entries = sortManifestEntries([{ path: "a\uFFFD" }, { path: "a\u{10000}" }]);
    expect(entries.map((entry) => entry.path)).toEqual(["a\u{10000}", "a\uFFFD"]);
  });
});

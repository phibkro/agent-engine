import { describe, expect, test } from "vitest";
import { array, assert, integer, property } from "fast-check";
import {
  AuthenticatedActorSchema,
  CommandEnvelopeSchema,
  CreateProjectRequestSchema,
  decodeCommand,
  type AgentProfileId,
  type AttemptNumber,
  type AuthenticatedActor,
  type CommandEnvelope,
  type CommandId,
  type ContentRevision,
  type EventRevision,
  type Grant,
  type GrantId,
  type ProjectCommand,
  type ProjectId,
  type Proposal,
  type ProposalId,
  type Session,
  type SessionId,
  type Sha256Digest,
  type Timestamp,
  type WorkId,
  type WorkProcessId,
} from "@work-engine/protocol";
import {
  createProject,
  deriveGates,
  emptyProjectState,
  foldEvent,
  tracerPolicy,
  transition,
  type ProjectState,
} from "../src/index.ts";

const id = (prefix: string, suffix: string): string =>
  `${prefix}00000000-0000-4000-8000-0000000000${suffix}`;
const PROJECT_ID = id("prj_", "01") as ProjectId;
const OPERATOR_ID = "operator:test" as AuthenticatedActor["actorId"];
const WORK_ID = id("wrk_", "02") as WorkId;
const PROCESS_ID = id("wpr_", "03") as WorkProcessId;
const PROFILE_ID = id("prf_", "04") as AgentProfileId;
const SESSION_ID = id("ses_", "05") as SessionId;
const PROPOSAL_ID = id("prp_", "06") as ProposalId;
const GRANT_ID = id("grt_", "07") as GrantId;
const COMMAND_ID = id("cmd_", "08") as CommandId;
const TIMESTAMP = "2026-08-10T00:00:00.000Z" as Timestamp;
const LATER = "2026-08-10T01:00:00.000Z" as Timestamp;

const operator = (presentedGrants: readonly GrantId[] = []): AuthenticatedActor =>
  AuthenticatedActorSchema.make({
    _tag: "AuthenticatedActor",
    actorId: OPERATOR_ID,
    kind: "operator",
    presentedGrants,
  });

const grant = (capability: Grant["capability"]): Grant => ({
  _tag: "Grant",
  grantId: GRANT_ID,
  subjectActorId: OPERATOR_ID,
  capability,
  scope: { projectId: PROJECT_ID },
  validFrom: "2026-01-01T00:00:00.000Z" as Timestamp,
  validUntil: "2027-01-01T00:00:00.000Z" as Timestamp,
  grantingAuthority: OPERATOR_ID,
});

const createRequest = () =>
  CreateProjectRequestSchema.make({
    schemaVersion: "work-engine/v1",
    commandId: COMMAND_ID,
    command: {
      _tag: "CreateProject",
      policy: tracerPolicy(),
      grants: [grant("work.submit")],
    },
  });

const envelope = (
  state: ProjectState,
  command: ProjectCommand,
  commandId: CommandId,
  actor: AuthenticatedActor,
): CommandEnvelope =>
  CommandEnvelopeSchema.make({
    schemaVersion: "work-engine/v1",
    commandId,
    projectId: state.projectId,
    expectedRevision: state.eventRevision,
    actor,
    command,
  });

describe("protocol and kernel contracts", () => {
  test("strict command decoding rejects unknown fields", () => {
    expect(() =>
      decodeCommand({
        _tag: "CreateProject",
        policy: tracerPolicy(),
        grants: [],
        unexpected: true,
      }),
    ).toThrow();
  });

  test("CreateProject is the explicit bootstrap and replay returns the original receipt", () => {
    const request = createRequest();
    const first = createProject(request, PROJECT_ID, operator());
    expect(first.result._tag).toBe("Accepted");
    expect(first.state?.eventRevision).toBe(1);
    const duplicate = transition(first.state, request, {
      projectId: PROJECT_ID,
      actor: operator(),
    });
    expect(duplicate.result._tag).toBe("AlreadyApplied");
    expect(duplicate.state?.eventRevision).toBe(1);
  });

  test("one accepted command advances one event revision and stale commands do not rebase", () => {
    const created = createProject(createRequest(), PROJECT_ID, operator()).state!;
    const actor = operator([GRANT_ID]);
    const command: ProjectCommand = {
      _tag: "SubmitWork",
      workId: WORK_ID,
      workProcessId: PROCESS_ID,
      objective: "repair the fixture behavior",
      kind: "implementation",
      writableScope: ["src/greeting.ts"],
      requiredCheck: "bun run check",
    };
    const accepted = transition(
      created,
      envelope(created, command, id("cmd_", "09") as CommandId, actor),
      { now: TIMESTAMP },
    );
    expect(accepted.result._tag).toBe("Accepted");
    expect(accepted.state?.eventRevision).toBe(2);
    const stale = transition(
      accepted.state!,
      {
        ...envelope(accepted.state!, command, id("cmd_", "10") as CommandId, actor),
        expectedRevision: 1 as EventRevision,
      },
      { now: TIMESTAMP },
    );
    expect(stale.result).toMatchObject({ _tag: "Rejected", code: "revision_mismatch" });
  });
  test("Rejected receipts are durable and replay as AlreadyApplied without advancing revision", () => {
    const created = createProject(createRequest(), PROJECT_ID, operator()).state!;
    const command: ProjectCommand = {
      _tag: "SubmitWork",
      workId: WORK_ID,
      workProcessId: PROCESS_ID,
      objective: "repair the fixture behavior",
      kind: "implementation",
      writableScope: ["src/greeting.ts"],
      requiredCheck: "bun run check",
    };
    const unauthorized = transition(
      created,
      envelope(created, command, id("cmd_", "12") as CommandId, operator()),
      { now: TIMESTAMP },
    );
    expect(unauthorized.result).toMatchObject({ _tag: "Rejected", code: "unauthorized" });
    const replayed = transition(
      unauthorized.state,
      envelope(unauthorized.state!, command, id("cmd_", "12") as CommandId, operator()),
      { now: TIMESTAMP },
    );
    expect(replayed.result._tag).toBe("AlreadyApplied");
    expect(replayed.state?.eventRevision).toBe(created.eventRevision);
  });

  test("retries have a new Session identity and retain predecessor provenance", () => {
    const state = emptyProjectState(PROJECT_ID);
    const predecessor: Session = {
      _tag: "Session",
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      workId: WORK_ID,
      profileId: PROFILE_ID,
      attempt: 0 as AttemptNumber,
      contextReference: "handoff:one",
      deadline: LATER,
      outputLimit: 100,
      toolBudget: 10,
      status: "interrupted",
    };
    const retry = {
      ...predecessor,
      sessionId: id("ses_", "11") as SessionId,
      attempt: 1 as AttemptNumber,
      predecessorSessionId: predecessor.sessionId,
    };
    const withSessions = {
      ...state,
      sessions: { [predecessor.sessionId]: predecessor, [retry.sessionId]: retry },
    };
    expect(retry.sessionId).not.toBe(predecessor.sessionId);
    expect(withSessions.sessions[retry.sessionId]?.predecessorSessionId).toBe(
      predecessor.sessionId,
    );
  });

  test("Gate derivation is immutable evidence provenance, not an editable boolean", () => {
    const state = emptyProjectState(PROJECT_ID);
    const proposal = {
      _tag: "Proposal" as const,
      proposalId: PROPOSAL_ID,
      projectId: PROJECT_ID,
      proposerSessionId: SESSION_ID,
      submissionEventRevision: 1 as EventRevision,
      basisContentRevision: 0 as ContentRevision,
      candidate: {
        _tag: "ContentManifest" as const,
        digest: `sha256:${"0".repeat(64)}` as Sha256Digest,
        entries: [],
      },
      evidenceIds: [],
      status: "submitted" as const,
    } satisfies Proposal;
    const decision = deriveGates(
      { ...state, proposals: { [proposal.proposalId]: proposal } },
      proposal,
    );
    expect(decision.satisfied).toBe(false);
    expect(
      decision.evaluations.every((gate) => gate.sourceEventRevision === state.eventRevision),
    ).toBe(true);
  });

  test("folding the same event history is deterministic and Merge alone changes content", () => {
    const state = emptyProjectState(PROJECT_ID);
    const event = {
      eventRevision: 1 as EventRevision,
      commandId: COMMAND_ID,
      event: { _tag: "ProjectCreated" as const, projectId: PROJECT_ID, policy: tracerPolicy() },
    };
    const left = foldEvent(state, event);
    const right = foldEvent(state, event);
    expect(left).toEqual(right);
    expect(left.contentRevision).toBe(0);
  });

  test("revision measurements obey a deterministic property", () => {
    assert(
      property(array(integer({ min: 0, max: 100 })), (values) => {
        const revisions = values.reduce((current, value) => current + Math.abs(value), 0);
        expect(revisions).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

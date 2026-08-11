import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";
import {
  SchemaVersionSchema,
  CommitShaSchema,
  NonEmptyStringSchema,
  SessionCompletedResultSchema,
  SessionStateSchema,
  TimestampSchema,
  TerminalSessionStateSchema,
  type SessionState as ProtocolSessionState,
  type Timestamp,
  type TerminalSessionState,
} from "@work-engine/protocol";
import {
  CloudTaskSchema,
  SessionAdmissionSchema,
  SessionObservationSchema,
  SessionResultSchema,
  decode,
  type CloudTask,
  type PlatformCapabilities,
  type SessionAdmission,
  type SessionId,
  type SessionObservation,
  type SessionResult,
} from "./contract.ts";
import { InvalidRequestError, SessionConflictError, SessionTerminalError } from "./errors.ts";

const SessionLifecycleSchema = Schema.Literals([
  "admitted",
  "running",
  "cancellation_requested",
  "cancelled",
  "failed",
  "completed",
] as const);

export type SessionLifecycle = typeof SessionLifecycleSchema.Type;
export type SessionTerminalLifecycle = "cancelled" | "failed" | "completed";

const SessionSideEffectSchema = Schema.Struct({
  kind: Schema.Literals([
    "checkpoint",
    "candidate",
    "sandbox_terminated",
    "sandbox_replaced",
  ] as const),
  at: TimestampSchema,
  details: Schema.Record(Schema.String, Schema.Json),
});
export type SessionSideEffect = typeof SessionSideEffectSchema.Type;

const terminal = (status: SessionLifecycle): status is SessionTerminalLifecycle =>
  status === "cancelled" || status === "failed" || status === "completed";

const terminalResultTag = (status: SessionLifecycle): SessionResult["_tag"] | undefined => {
  if (status === "cancelled") return "Cancelled";
  if (status === "failed") return "Failed";
  if (status === "completed") return "Completed";
  return undefined;
};
const SessionSnapshotBaseSchema = Schema.TaggedStruct("SessionSnapshot", {
  schemaVersion: SchemaVersionSchema,
  task: CloudTaskSchema,
  admission: SessionAdmissionSchema,
  status: SessionLifecycleSchema,
  cursor: Schema.Natural,
  observations: Schema.Array(SessionObservationSchema),
  acceptedMessages: Schema.Record(Schema.String, Schema.Natural),
  terminalResult: Schema.optionalKey(SessionResultSchema),
  cancellationReason: Schema.optionalKey(NonEmptyStringSchema),
  sideEffects: Schema.Array(SessionSideEffectSchema),
  liveSandboxId: Schema.optionalKey(NonEmptyStringSchema),
  predecessorSandboxIds: Schema.Array(NonEmptyStringSchema),
  wipCommit: Schema.optionalKey(CommitShaSchema),
  candidateCommit: Schema.optionalKey(CommitShaSchema),
  updatedAt: TimestampSchema,
});

export const SessionSnapshotSchema = SessionSnapshotBaseSchema.check(
  Schema.makeFilter((snapshot) => {
    if (snapshot.task.sessionId !== snapshot.admission.sessionId) {
      return "task and admission session identities must match";
    }
    if (
      snapshot.terminalResult !== undefined &&
      snapshot.terminalResult.sessionId !== snapshot.task.sessionId
    ) {
      return "terminal result session identity must match the task";
    }
    if (terminal(snapshot.status) !== (snapshot.terminalResult !== undefined)) {
      return "terminal status and terminal result must agree";
    }
    const expectedTag = terminalResultTag(snapshot.status);
    if (
      expectedTag !== undefined &&
      snapshot.terminalResult !== undefined &&
      snapshot.terminalResult._tag !== expectedTag
    ) {
      return "terminal status and result tag must agree";
    }
    if ((snapshot.status === "cancelled") !== (snapshot.cancellationReason !== undefined)) {
      return "cancellation reason must match cancelled status";
    }
    return true;
  }),
);
export type SessionSnapshot = typeof SessionSnapshotSchema.Type;

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  save(snapshot: SessionSnapshot): Promise<void>;
}

const taskKey = (task: CloudTask): string => `${task.taskId}\u0000${task.profileDigest}`;

const cloneSnapshot = (snapshot: SessionSnapshot): SessionSnapshot => ({
  ...snapshot,
  task: { ...snapshot.task },
  admission: { ...snapshot.admission },
  observations: snapshot.observations.map((entry) => ({ ...entry })),
  acceptedMessages: { ...snapshot.acceptedMessages },
  sideEffects: snapshot.sideEffects.map((effect) => ({
    ...effect,
    details: { ...effect.details },
  })),
  predecessorSandboxIds: [...snapshot.predecessorSandboxIds],
});

interface ObservationDetails {
  readonly at?: Timestamp;
  readonly startedAt?: Timestamp;
  readonly reason?: string;
  readonly messageId?: string;
  readonly message?: Json;
  readonly event?: Json;
}

type SessionClock = Pick<PlatformCapabilities, "now">;

const sessionState = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  cursor: number,
  status: SessionLifecycle,
  details: ObservationDetails,
  clock: SessionClock,
): ProtocolSessionState => {
  if (status === "admitted") {
    return decode(SessionStateSchema, { _tag: "Pending", sessionId, cursor });
  }
  if (status === "running" || status === "cancellation_requested") {
    return decode(SessionStateSchema, {
      _tag: "Running",
      sessionId,
      cursor,
      startedAt: details.startedAt ?? clock.now(),
    });
  }
  if (status === "cancelled") {
    return decode(SessionStateSchema, {
      _tag: "Cancelled",
      sessionId,
      cursor,
      cancelledAt: details.at ?? clock.now(),
      reason: details.reason ?? "Session cancelled",
    });
  }
  if (status === "failed") {
    return decode(SessionStateSchema, {
      _tag: "Failed",
      sessionId,
      cursor,
      failedAt: details.at ?? clock.now(),
      reason: details.reason ?? "Session failed",
    });
  }
  return decode(SessionStateSchema, {
    _tag: "Completed",
    sessionId,
    cursor,
    completedAt: details.at ?? clock.now(),
  });
};

const observation = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  cursor: number,
  status: SessionLifecycle,
  details: ObservationDetails,
  clock: SessionClock,
): SessionObservation =>
  decode(SessionObservationSchema, {
    _tag: "SessionObservation",
    sessionId,
    cursor,
    observedAt: clock.now(),
    state: sessionState(sessionId, cursor, status, details, clock),
    ...(details.messageId === undefined ? {} : { messageId: details.messageId }),
    ...(details.message === undefined ? {} : { message: details.message }),
    ...(details.event === undefined ? {} : { event: details.event }),
  });

const admission = (task: CloudTask, clock: SessionClock): SessionAdmission =>
  decode(SessionAdmissionSchema, {
    _tag: "SessionAdmission",
    sessionId: task.sessionId,
    taskId: task.taskId,
    projectId: task.projectId,
    profileId: task.profileId,
    profileRevision: task.profileRevision,
    profileDigest: task.profileDigest,
    baseCommit: task.baseCommit,
    acceptedCursor: 0,
    admittedAt: clock.now(),
    ...(task.memoryRevision === undefined ? {} : { memoryRevision: task.memoryRevision }),
  });

const result = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  status: "pending" | "failed" | "cancelled",
  reason: string | undefined,
  clock: SessionClock,
): SessionResult => {
  if (status === "pending") return decode(SessionResultSchema, { _tag: "Pending", sessionId });
  if (status === "failed") {
    return decode(SessionResultSchema, {
      _tag: "Failed",
      sessionId,
      reason: reason ?? "Session failed",
      completedAt: clock.now(),
    });
  }
  return decode(SessionResultSchema, {
    _tag: "Cancelled",
    sessionId,
    reason: reason ?? "Session cancelled",
    completedAt: clock.now(),
  });
};

/** Pure lifecycle owner used by the Session Durable Object and focused tests. */
export class SessionState {
  #snapshot: SessionSnapshot;
  #clock: SessionClock;

  constructor(task: CloudTask, clock: SessionClock, existing?: SessionSnapshot) {
    const decoded = decode(CloudTaskSchema, task);
    const snapshot = existing === undefined ? undefined : decode(SessionSnapshotSchema, existing);
    this.#clock = clock;
    if (snapshot !== undefined) {
      if (snapshot.task.sessionId !== decoded.sessionId) {
        throw new SessionConflictError(
          "Persisted Session identity does not match the requested identity",
        );
      }
      this.#snapshot = cloneSnapshot(snapshot);
      return;
    }
    this.#snapshot = decode(SessionSnapshotSchema, {
      _tag: "SessionSnapshot",
      schemaVersion: "work-engine/v2",
      task: decoded,
      admission: admission(decoded, clock),
      status: "admitted",
      cursor: 0,
      observations: [],
      acceptedMessages: {},
      sideEffects: [],
      predecessorSandboxIds: [],
      updatedAt: clock.now(),
    });
  }

  get snapshot(): SessionSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  get sessionId(): SessionId {
    return this.#snapshot.task.sessionId;
  }

  get status(): SessionLifecycle {
    return this.#snapshot.status;
  }

  get terminalResult(): SessionResult | undefined {
    return this.#snapshot.terminalResult;
  }

  admission(): SessionAdmission {
    return this.#snapshot.admission;
  }

  spawn(existingTask: CloudTask): SessionAdmission {
    const incoming = decode(CloudTaskSchema, existingTask);
    if (taskKey(incoming) !== taskKey(this.#snapshot.task)) {
      throw new SessionConflictError("sessionId is already admitted for a different task");
    }
    return this.admission();
  }

  #append(status: SessionLifecycle, details: ObservationDetails = {}): void {
    const cursor = this.#snapshot.cursor + 1;
    this.#snapshot = {
      ...this.#snapshot,
      cursor,
      observations: [
        ...this.#snapshot.observations,
        observation(this.#snapshot.task.sessionId, cursor, status, details, this.#clock),
      ],
    };
  }

  #terminalState(reason?: string): TerminalSessionState {
    return decode(
      TerminalSessionStateSchema,
      sessionState(
        this.sessionId,
        this.#snapshot.cursor,
        this.#snapshot.status,
        { at: this.#snapshot.updatedAt, ...(reason === undefined ? {} : { reason }) },
        this.#clock,
      ),
    );
  }

  start(): void {
    if (terminal(this.#snapshot.status)) {
      throw new SessionTerminalError(this.#terminalState());
    }
    if (this.#snapshot.status === "running") return;
    this.#snapshot = { ...this.#snapshot, status: "running" };
    this.#append("running");
  }

  send(messageId: string, message: Json): number {
    if (messageId.length === 0 || (typeof message === "string" && message.length === 0)) {
      throw new InvalidRequestError("Message cannot be empty");
    }
    const prior = this.#snapshot.acceptedMessages[messageId];
    if (prior !== undefined) return prior;
    if (terminal(this.#snapshot.status)) {
      throw new SessionTerminalError(
        this.#terminalState("send is rejected after terminal completion"),
        "send is rejected after terminal completion",
      );
    }
    const status: SessionLifecycle =
      this.#snapshot.status === "admitted" ? "running" : this.#snapshot.status;
    this.#snapshot = {
      ...this.#snapshot,
      status,
      acceptedMessages: {
        ...this.#snapshot.acceptedMessages,
        [messageId]: this.#snapshot.cursor + 1,
      },
    };
    this.#append(status, { messageId, message });
    return this.#snapshot.cursor;
  }

  observe(afterCursor: number): SessionObservation[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new InvalidRequestError("afterCursor must be a non-negative integer");
    }
    return this.#snapshot.observations.filter((entry) => entry.cursor > afterCursor);
  }

  requestCancellation(reason: string): SessionObservation {
    const decodedReason = decode(NonEmptyStringSchema, reason);
    if (terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.observations[this.#snapshot.observations.length - 1];
      if (existing !== undefined) return existing;
      throw new SessionTerminalError(this.#terminalState());
    }
    this.#snapshot = {
      ...this.#snapshot,
      status: "cancelled",
      cancellationReason: decodedReason,
    };
    this.#append("cancelled", { reason: decodedReason, at: this.#clock.now() });
    this.#snapshot = {
      ...this.#snapshot,
      terminalResult: result(this.sessionId, "cancelled", decodedReason, this.#clock),
    };
    const finalObservation = this.#snapshot.observations[this.#snapshot.observations.length - 1];
    if (finalObservation === undefined) {
      throw new SessionTerminalError(this.#terminalState());
    }
    return finalObservation;
  }

  fail(reason: string): SessionResult {
    if (terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.terminalResult;
      if (existing !== undefined) return existing;
      throw new SessionTerminalError(this.#terminalState());
    }
    if (reason.length === 0) throw new InvalidRequestError("Failure reason cannot be empty");
    const nextResult = result(this.#snapshot.task.sessionId, "failed", reason, this.#clock);
    this.#snapshot = { ...this.#snapshot, status: "failed" };
    this.#append("failed", { reason, at: this.#clock.now() });
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult;
  }

  complete(completedResult: unknown): SessionResult {
    if (this.#snapshot.status === "cancelled" || terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.terminalResult;
      if (existing !== undefined) return existing;
      throw new SessionTerminalError(this.#terminalState());
    }
    const decodedResult = decode(SessionCompletedResultSchema, completedResult);
    if (decodedResult.sessionId !== this.#snapshot.task.sessionId) {
      throw new InvalidRequestError("CompletedResult session identity does not match the Session");
    }
    const nextResult = decode(SessionResultSchema, {
      _tag: "Completed",
      sessionId: this.#snapshot.task.sessionId,
      result: decodedResult,
    });
    this.#snapshot = { ...this.#snapshot, status: "completed" };
    this.#append("completed", { at: this.#clock.now() });
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult;
  }

  recordSideEffect(kind: SessionSideEffect["kind"], details: Readonly<Record<string, Json>>): void {
    const effect: SessionSideEffect = {
      kind,
      at: this.#clock.now(),
      details: { ...details },
    };
    this.#snapshot = { ...this.#snapshot, sideEffects: [...this.#snapshot.sideEffects, effect] };
    if (this.#snapshot.status === "cancelled" && this.#snapshot.terminalResult !== undefined) {
      this.#snapshot = {
        ...this.#snapshot,
        terminalResult: result(
          this.sessionId,
          "cancelled",
          this.#snapshot.cancellationReason,
          this.#clock,
        ),
      };
    }
  }

  checkpoint(commit: string): void {
    const decodedCommit = decode(CommitShaSchema, commit);
    this.#snapshot = { ...this.#snapshot, wipCommit: decodedCommit };
    this.recordSideEffect("checkpoint", { commit: decodedCommit, ref: "wip" });
  }

  recordCandidate(commit: string, ref: string): void {
    const decodedCommit = decode(CommitShaSchema, commit);
    this.#snapshot = { ...this.#snapshot, candidateCommit: decodedCommit };
    this.recordSideEffect("candidate", { commit: decodedCommit, ref });
  }

  replaceSandbox(predecessor: string, replacement: string): void {
    const decodedPredecessor = decode(NonEmptyStringSchema, predecessor);
    const decodedReplacement = decode(NonEmptyStringSchema, replacement);
    this.#snapshot = {
      ...this.#snapshot,
      liveSandboxId: decodedReplacement,
      predecessorSandboxIds: [...this.#snapshot.predecessorSandboxIds, decodedPredecessor],
    };
    this.recordSideEffect("sandbox_replaced", {
      predecessor: decodedPredecessor,
      replacement: decodedReplacement,
    });
  }
}

export const decodeSessionAdmission = (value: unknown): SessionAdmission =>
  decode(SessionAdmissionSchema, value);
export const decodeSessionObservation = (value: unknown): SessionObservation =>
  decode(SessionObservationSchema, value);
export const decodeSessionResult = (value: unknown): SessionResult =>
  decode(SessionResultSchema, value);
export const decodeSessionSnapshot = (value: unknown): SessionSnapshot =>
  decode(SessionSnapshotSchema, value);

export const sessionIdFromTask = (task: CloudTask): SessionId => task.sessionId;

import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";
import {
  SchemaVersionSchema,
  CommitShaSchema,
  NonEmptyStringSchema,
  SessionCompletedResultSchema,
  SessionStateSchema,
  TimestampSchema,
  type SessionState as ProtocolSessionState,
} from "@work-engine/protocol";
import {
  CloudTaskSchema,
  SessionAdmissionSchema,
  SessionObservationSchema,
  SessionResultSchema,
  decode,
  newId,
  nowIso,
  type CloudTask,
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
const SessionSnapshotBaseSchema = Schema.Struct({
  _tag: Schema.Literal("SessionSnapshot"),
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
  readonly at?: string;
  readonly startedAt?: string;
  readonly reason?: string;
  readonly messageId?: string;
  readonly message?: Json;
  readonly event?: Json;
}

const sessionState = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  cursor: number,
  status: SessionLifecycle,
  details: ObservationDetails,
): ProtocolSessionState => {
  if (status === "admitted") {
    return decode(SessionStateSchema, { _tag: "Pending", sessionId, cursor });
  }
  if (status === "running" || status === "cancellation_requested") {
    return decode(SessionStateSchema, {
      _tag: "Running",
      sessionId,
      cursor,
      startedAt: details.startedAt ?? nowIso(),
    });
  }
  if (status === "cancelled") {
    return decode(SessionStateSchema, {
      _tag: "Cancelled",
      sessionId,
      cursor,
      cancelledAt: details.at ?? nowIso(),
      reason: details.reason ?? "Session cancelled",
    });
  }
  if (status === "failed") {
    return decode(SessionStateSchema, {
      _tag: "Failed",
      sessionId,
      cursor,
      failedAt: details.at ?? nowIso(),
      reason: details.reason ?? "Session failed",
    });
  }
  return decode(SessionStateSchema, {
    _tag: "Completed",
    sessionId,
    cursor,
    completedAt: details.at ?? nowIso(),
  });
};

const observation = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  cursor: number,
  status: SessionLifecycle,
  details: ObservationDetails = {},
): SessionObservation =>
  decode(SessionObservationSchema, {
    _tag: "SessionObservation",
    sessionId,
    cursor,
    observedAt: nowIso(),
    state: sessionState(sessionId, cursor, status, details),
    ...(details.messageId === undefined ? {} : { messageId: details.messageId }),
    ...(details.message === undefined ? {} : { message: details.message }),
    ...(details.event === undefined ? {} : { event: details.event }),
  });

const admission = (task: CloudTask): SessionAdmission =>
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
    admittedAt: nowIso(),
    ...(task.memoryRevision === undefined ? {} : { memoryRevision: task.memoryRevision }),
  });

const result = (
  sessionId: SessionSnapshot["task"]["sessionId"],
  status: "pending" | "failed" | "cancelled",
  reason?: string,
): SessionResult => {
  if (status === "pending") return decode(SessionResultSchema, { _tag: "Pending", sessionId });
  if (status === "failed") {
    return decode(SessionResultSchema, {
      _tag: "Failed",
      sessionId,
      reason: reason ?? "Session failed",
      completedAt: nowIso(),
    });
  }
  return decode(SessionResultSchema, {
    _tag: "Cancelled",
    sessionId,
    reason: reason ?? "Session cancelled",
    completedAt: nowIso(),
  });
};

/** Pure lifecycle owner used by the Session Durable Object and focused tests. */
export class SessionState {
  #snapshot: SessionSnapshot;

  constructor(task: CloudTask, existing?: SessionSnapshot) {
    const decoded = decode(CloudTaskSchema, task);
    const snapshot = existing === undefined ? undefined : decode(SessionSnapshotSchema, existing);
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
      admission: admission(decoded),
      status: "admitted",
      cursor: 0,
      observations: [],
      acceptedMessages: {},
      sideEffects: [],
      predecessorSandboxIds: [],
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
        observation(this.#snapshot.task.sessionId, cursor, status, details),
      ],
    };
  }

  start(): void {
    if (terminal(this.#snapshot.status)) throw new SessionTerminalError();
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
    if (terminal(this.#snapshot.status))
      throw new SessionTerminalError("send is rejected after terminal completion");
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
      throw new SessionTerminalError();
    }
    this.#snapshot = {
      ...this.#snapshot,
      status: "cancelled",
      cancellationReason: decodedReason,
    };
    this.#append("cancelled", { reason: decodedReason, at: nowIso() });
    this.#snapshot = {
      ...this.#snapshot,
      terminalResult: result(this.sessionId, "cancelled", decodedReason),
    };
    const finalObservation = this.#snapshot.observations[this.#snapshot.observations.length - 1];
    if (finalObservation === undefined) throw new SessionTerminalError();
    return finalObservation;
  }

  fail(reason: string): SessionResult {
    if (terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.terminalResult;
      if (existing !== undefined) return existing;
      throw new SessionTerminalError();
    }
    if (reason.length === 0) throw new InvalidRequestError("Failure reason cannot be empty");
    const nextResult = result(this.#snapshot.task.sessionId, "failed", reason);
    this.#snapshot = { ...this.#snapshot, status: "failed" };
    this.#append("failed", { reason, at: nowIso() });
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult;
  }

  complete(completedResult: unknown): SessionResult {
    if (this.#snapshot.status === "cancelled" || terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.terminalResult;
      if (existing !== undefined) return existing;
      throw new SessionTerminalError();
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
    this.#append("completed", { at: nowIso() });
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult;
  }

  recordSideEffect(kind: SessionSideEffect["kind"], details: Readonly<Record<string, Json>>): void {
    const effect: SessionSideEffect = {
      kind,
      at: decode(TimestampSchema, nowIso()),
      details: { ...details },
    };
    this.#snapshot = { ...this.#snapshot, sideEffects: [...this.#snapshot.sideEffects, effect] };
    if (this.#snapshot.status === "cancelled" && this.#snapshot.terminalResult !== undefined) {
      this.#snapshot = {
        ...this.#snapshot,
        terminalResult: result(this.sessionId, "cancelled", this.#snapshot.cancellationReason),
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
export const freshSessionTaskId = (): string => newId("tsk_");

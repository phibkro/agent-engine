import {
  CloudTaskSchema,
  SessionAdmissionSchema,
  SessionObservationSchema,
  SessionResultSchema,
  decode,
  newId,
  nowIso,
  record,
  requiredString,
  type CloudTask,
  type SessionAdmission,
  type SessionId,
  type SessionObservation,
  type SessionResult,
} from "./contract.ts";
import { InvalidRequestError, SessionConflictError, SessionTerminalError } from "./errors.ts";

export type SessionLifecycle =
  | "admitted"
  | "running"
  | "cancellation_requested"
  | "cancelled"
  | "failed"
  | "completed";

export type SessionTerminalLifecycle = "cancelled" | "failed" | "completed";

export interface SessionSideEffect {
  readonly kind: "checkpoint" | "candidate" | "sandbox_terminated" | "sandbox_replaced";
  readonly at: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface SessionSnapshot {
  readonly task: Record<string, unknown>;
  readonly admission: Record<string, unknown>;
  readonly status: SessionLifecycle;
  readonly cursor: number;
  readonly observations: readonly Record<string, unknown>[];
  readonly acceptedMessages: Readonly<Record<string, number>>;
  readonly terminalResult?: Record<string, unknown>;
  readonly cancellationReason?: string;
  readonly sideEffects: readonly SessionSideEffect[];
  readonly liveSandboxId?: string;
  readonly predecessorSandboxIds: readonly string[];
  readonly wipCommit?: string;
  readonly candidateCommit?: string;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  save(snapshot: SessionSnapshot): Promise<void>;
}

const terminal = (status: SessionLifecycle): status is SessionTerminalLifecycle =>
  status === "cancelled" || status === "failed" || status === "completed";

const taskKey = (task: CloudTask): string => {
  const value = record(task);
  return `${requiredString(value["taskId"], "task.taskId")}\u0000${requiredString(value["profileDigest"], "task.profileDigest")}`;
};

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

const sessionState = (
  sessionId: string,
  cursor: number,
  status: SessionLifecycle,
  details: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  if (status === "admitted") return { _tag: "Pending", sessionId, cursor };
  if (status === "running" || status === "cancellation_requested") {
    return { _tag: "Running", sessionId, cursor, startedAt: details["startedAt"] ?? nowIso() };
  }
  if (status === "cancelled")
    return {
      _tag: "Cancelled",
      sessionId,
      cursor,
      cancelledAt: details["at"] ?? nowIso(),
      reason: details["reason"],
    };
  if (status === "failed")
    return {
      _tag: "Failed",
      sessionId,
      cursor,
      failedAt: details["at"] ?? nowIso(),
      reason: details["reason"],
    };
  if (status === "completed")
    return { _tag: "Completed", sessionId, cursor, completedAt: details["at"] ?? nowIso() };
  return { _tag: "Pending", sessionId, cursor };
};

const observation = (
  sessionId: string,
  cursor: number,
  status: SessionLifecycle,
  details: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const next: Record<string, unknown> = {
    _tag: "SessionObservation",
    sessionId,
    cursor,
    observedAt: nowIso(),
    state: sessionState(sessionId, cursor, status, details),
  };
  if (typeof details["messageId"] === "string") next["messageId"] = details["messageId"];
  if (details["message"] !== undefined) next["message"] = details["message"];
  if (details["event"] !== undefined) next["event"] = details["event"];
  return next;
};

const admission = (task: CloudTask): Record<string, unknown> => {
  const value = record(task);
  const next: Record<string, unknown> = {
    _tag: "SessionAdmission",
    sessionId: requiredString(value["sessionId"], "task.sessionId"),
    taskId: requiredString(value["taskId"], "task.taskId"),
    projectId: requiredString(value["projectId"], "task.projectId"),
    profileId: requiredString(value["profileId"], "task.profileId"),
    profileRevision: value["profileRevision"],
    profileDigest: requiredString(value["profileDigest"], "task.profileDigest"),
    baseCommit: requiredString(value["baseCommit"], "task.baseCommit"),
    acceptedCursor: 0,
    admittedAt: nowIso(),
  };
  if (value["memoryRevision"] !== undefined) next["memoryRevision"] = value["memoryRevision"];
  return next;
};

const result = (
  sessionId: string,
  status: "pending" | "failed" | "cancelled",
  reason?: string,
): Record<string, unknown> => {
  if (status === "pending") return { _tag: "Pending", sessionId };
  if (status === "failed")
    return { _tag: "Failed", sessionId, reason: reason ?? "Session failed", completedAt: nowIso() };
  return {
    _tag: "Cancelled",
    sessionId,
    reason: reason ?? "Session cancelled",
    completedAt: nowIso(),
  };
};

/** Pure lifecycle owner used by the Session Durable Object and focused tests. */
export class SessionState {
  #snapshot: SessionSnapshot;

  constructor(task: CloudTask, existing?: SessionSnapshot) {
    const decoded = decode(CloudTaskSchema, task);
    const taskRecord = record(decoded);
    const sessionId = requiredString(taskRecord["sessionId"], "task.sessionId");
    if (existing !== undefined) {
      if (requiredString(existing.task["sessionId"], "snapshot.task.sessionId") !== sessionId) {
        throw new SessionConflictError(
          "Persisted Session identity does not match the requested identity",
        );
      }
      this.#snapshot = cloneSnapshot(existing);
      return;
    }
    this.#snapshot = {
      task: { ...taskRecord },
      admission: admission(decoded),
      status: "admitted",
      cursor: 0,
      observations: [],
      acceptedMessages: {},
      sideEffects: [],
      predecessorSandboxIds: [],
    };
  }

  get snapshot(): SessionSnapshot {
    return cloneSnapshot(this.#snapshot);
  }

  get sessionId(): string {
    return requiredString(this.#snapshot.task["sessionId"], "task.sessionId");
  }

  get status(): SessionLifecycle {
    return this.#snapshot.status;
  }

  get terminalResult(): SessionResult | undefined {
    return this.#snapshot.terminalResult as SessionResult | undefined;
  }

  admission(): SessionAdmission {
    return this.#snapshot.admission as SessionAdmission;
  }

  spawn(existingTask: CloudTask): SessionAdmission {
    const incoming = decode(CloudTaskSchema, existingTask);
    if (taskKey(incoming) !== taskKey(this.#snapshot.task as CloudTask)) {
      throw new SessionConflictError("sessionId is already admitted for a different task");
    }
    return this.admission();
  }

  #append(status: SessionLifecycle, details: Readonly<Record<string, unknown>> = {}): void {
    const cursor = this.#snapshot.cursor + 1;
    this.#snapshot = {
      ...this.#snapshot,
      cursor,
      observations: [
        ...this.#snapshot.observations,
        observation(this.sessionId, cursor, status, details),
      ],
    };
  }

  start(): void {
    if (terminal(this.#snapshot.status)) throw new SessionTerminalError();
    if (this.#snapshot.status === "running") return;
    this.#snapshot = { ...this.#snapshot, status: "running" };
    this.#append("running");
  }

  send(messageId: string, message: string): number {
    if (messageId.length === 0 || message.length === 0)
      throw new InvalidRequestError("Message cannot be empty");
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
    return this.#snapshot.observations
      .filter((entry) => Number(entry["cursor"]) > afterCursor)
      .map((entry) => entry as SessionObservation);
  }

  requestCancellation(reason: string): SessionObservation {
    if (reason.length === 0) throw new InvalidRequestError("Cancellation reason cannot be empty");
    if (terminal(this.#snapshot.status)) {
      const existing = this.#snapshot.observations[this.#snapshot.observations.length - 1];
      if (existing !== undefined) return existing as SessionObservation;
      throw new SessionTerminalError();
    }
    this.#snapshot = { ...this.#snapshot, status: "cancelled", cancellationReason: reason };
    this.#append("cancelled", { reason, at: nowIso() });
    this.#snapshot = {
      ...this.#snapshot,
      terminalResult: result(this.sessionId, "cancelled", reason),
    };
    return this.#snapshot.observations[
      this.#snapshot.observations.length - 1
    ] as SessionObservation;
  }

  fail(reason: string): SessionResult {
    if (terminal(this.#snapshot.status)) return this.#snapshot.terminalResult as SessionResult;
    this.#snapshot = { ...this.#snapshot, status: "failed" };
    this.#append("failed", { reason, at: nowIso() });
    const nextResult = result(this.sessionId, "failed", reason);
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult as SessionResult;
  }

  complete(completedResult: Record<string, unknown>): SessionResult {
    if (this.#snapshot.status === "cancelled")
      return this.#snapshot.terminalResult as SessionResult;
    if (terminal(this.#snapshot.status)) return this.#snapshot.terminalResult as SessionResult;
    if (completedResult["_tag"] !== "CompletedResult") {
      throw new InvalidRequestError(
        "A trusted CompletedResult is required for terminal completion",
      );
    }
    this.#snapshot = { ...this.#snapshot, status: "completed" };
    this.#append("completed", { at: nowIso() });
    const nextResult = { _tag: "Completed", sessionId: this.sessionId, result: completedResult };
    this.#snapshot = { ...this.#snapshot, terminalResult: nextResult };
    return nextResult as SessionResult;
  }

  recordSideEffect(
    kind: SessionSideEffect["kind"],
    details: Readonly<Record<string, unknown>>,
  ): void {
    const effect: SessionSideEffect = { kind, at: nowIso(), details: { ...details } };
    this.#snapshot = { ...this.#snapshot, sideEffects: [...this.#snapshot.sideEffects, effect] };
    if (this.#snapshot.status === "cancelled" && this.#snapshot.terminalResult !== undefined) {
      this.#snapshot = {
        ...this.#snapshot,
        terminalResult: result(this.sessionId, "cancelled", this.#snapshot.cancellationReason),
      };
    }
  }

  checkpoint(commit: string): void {
    if (commit.length === 0) throw new InvalidRequestError("Checkpoint commit cannot be empty");
    this.#snapshot = { ...this.#snapshot, wipCommit: commit };
    this.recordSideEffect("checkpoint", { commit, ref: "wip" });
  }

  recordCandidate(commit: string, ref: string): void {
    this.#snapshot = { ...this.#snapshot, candidateCommit: commit };
    this.recordSideEffect("candidate", { commit, ref });
  }

  replaceSandbox(predecessor: string, replacement: string): void {
    if (predecessor.length === 0 || replacement.length === 0) {
      throw new InvalidRequestError("Sandbox identities cannot be empty");
    }
    this.#snapshot = {
      ...this.#snapshot,
      liveSandboxId: replacement,
      predecessorSandboxIds: [...this.#snapshot.predecessorSandboxIds, predecessor],
    };
    this.recordSideEffect("sandbox_replaced", { predecessor, replacement });
  }
}

export const decodeSessionAdmission = (value: unknown): SessionAdmission =>
  decode(SessionAdmissionSchema, value);
export const decodeSessionObservation = (value: unknown): SessionObservation =>
  decode(SessionObservationSchema, value);
export const decodeSessionResult = (value: unknown): SessionResult =>
  decode(SessionResultSchema, value);

export const sessionIdFromTask = (task: CloudTask): SessionId =>
  requiredString(record(task)["sessionId"], "task.sessionId") as SessionId;
export const freshSessionTaskId = (): string => newId("tsk_");

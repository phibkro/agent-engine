import * as Effect from "effect/Effect";
import type {
  CommandEnvelope,
  CommandResult,
  EffectId,
  ProjectCommand,
  SessionHostCancelRequest,
  SessionHostReceipt,
  SessionId,
  SessionStartSpec,
  Timestamp,
  WorkspaceLease,
  WorkspaceReady,
} from "@work-engine/protocol";
import {
  SessionHostCancelRequestSchema,
  SessionHostReceiptSchema,
  SessionStartSpecSchema,
  WorkspaceLeaseSchema,
  WorkspaceReadySchema,
  decodeCommandEnvelope,
  decodeCommandResult,
  decodeUnknownStrict,
} from "@work-engine/protocol";
import type { SessionHost, SessionHostError } from "@work-engine/runtime";
import { HostFailure, CustodyFailureError, failureReason, isSessionHostFailure, workspaceViewId } from "./errors.ts";
import { makeStartClaim, startClaimKey, type StartClaim, type StartClaimStore } from "./persistence.ts";
import type { SessionProcess, SessionProcessController } from "./process.ts";
import type { WorkspaceCustodian, WorkspaceSession, FrozenCandidate, CandidateFinalizeRequest } from "./custody.ts";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ReadinessProbe {
  ensureReady(lease: WorkspaceLease, timeoutMs: number): Promise<WorkspaceReady>;
}

export interface SessionStartedContext {
  readonly spec: SessionStartSpec;
  readonly workspaceViewId: string;
  readonly startedAt: Timestamp;
  readonly processReference: string;
}

export interface SessionTerminalContext {
  readonly sessionId: SessionId;
  readonly effectId: EffectId;
  readonly status: "completed" | "failed" | "interrupted";
  readonly reason: string;
  readonly terminalAt: Timestamp;
}

export interface SessionHostLifecycleCallbacks {
  onStarted?(context: SessionStartedContext): Promise<void>;
  onTerminal?(context: SessionTerminalContext): Promise<void>;
  flushPending?(): Promise<void>;
}

export interface SessionHostServiceOptions {
  readonly claims: StartClaimStore;
  readonly processController: SessionProcessController;
  readonly readiness: ReadinessProbe;
  readonly clock?: Clock;
  readonly workspace?: WorkspaceCustodian;
  readonly lifecycle?: SessionHostLifecycleCallbacks;
  readonly candidate?: SessionHostCandidateCallbacks;
}

export interface SessionHostSnapshot {
  readonly accepting: boolean;
  readonly claims: readonly StartClaim[];
}

export interface SessionHostCandidateCallbacks {
  readonly candidate: (candidate: FrozenCandidate) => Promise<void>;
}

/**
 * Durable session effect adapter. Claims are written before the controller is
 * called, and a claim in `spawn_requested` is never blindly spawned again:
 * reconciliation must find the deterministic launch first.
 */
export class SessionHostService implements SessionHost {
  private readonly clock: Clock;
  private readonly locks = new Map<string, Promise<void>>();
  private accepting = true;
  private readonly terminalCallbacks: SessionHostLifecycleCallbacks;

  constructor(private readonly options: SessionHostServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.terminalCallbacks = options.lifecycle ?? {};
  }

  ensureReady(lease: WorkspaceLease): Effect.Effect<WorkspaceReady, SessionHostError> {
    return Effect.tryPromise({
      try: () => this.ensureReadyAsync(lease),
      catch: (error) => toHostError(error),
    });
  }

  start(spec: SessionStartSpec): Effect.Effect<SessionHostReceipt, SessionHostError> {
    return Effect.tryPromise({
      try: () => this.startAsync(spec),
      catch: (error) => toHostError(error),
    });
  }

  cancel(sessionId: SessionId, reason: string): Effect.Effect<SessionHostReceipt, SessionHostError> {
    return Effect.tryPromise({
      try: () => this.cancelAsync(sessionId, reason),
      catch: (error) => toHostError(error),
    });
  }

  reportTerminal(
    sessionId: SessionId,
    status: "completed" | "failed" | "interrupted",
    reason: string,
  ): Effect.Effect<SessionHostReceipt, SessionHostError> {
    return Effect.tryPromise({
      try: () => this.reportTerminalAsync(sessionId, status, reason),
      catch: (error) => toHostError(error),
    });
  }


  async finalizeCandidate(request: CandidateFinalizeRequest): Promise<FrozenCandidate> {
    if (this.options.workspace === undefined) throw new CustodyFailureError({ _tag: "SnapshotUnavailable", reason: "workspace custody is not configured" });
    const candidate = await this.options.workspace.finalize(request);
    await this.options.candidate?.candidate(candidate);
    return candidate;
  }

  async markProcessExited(sessionId: SessionId): Promise<void> {
    if (this.options.workspace !== undefined) await this.options.workspace.markProcessExited(sessionId);
  }

  async shutdown(reason = "sigterm"): Promise<void> {
    this.accepting = false;
    await this.terminalCallbacks.flushPending?.();
    const claims = await this.options.claims.list();
    for (const claim of claims) {
      if (claim.state === "terminal") continue;
      await this.options.processController.cancel(claim.sessionId, reason).catch(() => undefined);
      await this.reportTerminalAsync(claim.sessionId, "interrupted", reason).catch(() => undefined);
    }
    await this.terminalCallbacks.flushPending?.();
  }

  async snapshot(): Promise<SessionHostSnapshot> {
    return { accepting: this.accepting, claims: await this.options.claims.list() };
  }

  private async ensureReadyAsync(lease: WorkspaceLease): Promise<WorkspaceReady> {
    const now = timestamp(this.clock.now());
    if (lease.expiresAt <= now) throw new HostFailure({ _tag: "LeaseExpired", resourceId: lease.resourceId });
    try {
      const ready = await withTimeout(this.options.readiness.ensureReady(lease, 60_000), 60_000);
      return WorkspaceReadySchema.make(ready);
    } catch (error) {
      if (error instanceof HostFailure) throw error;
      if (isSessionHostFailure(error)) throw new HostFailure(error);
      throw new HostFailure({ _tag: "ReadinessFailed", reason: errorMessage(error) });
    }
  }

  private async startAsync(spec: SessionStartSpec): Promise<SessionHostReceipt> {
    if (!this.accepting) throw new HostFailure({ _tag: "HostUnavailable", reason: "Session host is shutting down" });
    const now = timestamp(this.clock.now());
    if (spec.workspaceLease.expiresAt <= now) throw new HostFailure({ _tag: "LeaseExpired", resourceId: spec.workspaceLease.resourceId });
    return this.withLock(spec.sessionId, async () => {
      const key = startClaimKey(spec.sessionId, spec.effectId);
      const existing = await this.options.claims.get(key);
      if (existing !== undefined) return this.reconcileClaim(existing);
      const priorSession = await this.findSessionClaim(spec.sessionId);
      if (priorSession !== undefined) {
        throw new HostFailure({
          _tag: "SessionAlreadyStarted",
          sessionId: spec.sessionId,
        });
      }
      const workspace = await this.prepareWorkspace(spec);
      const claim = makeStartClaim(spec, now);
      await this.options.claims.put(claim);
      try {
        await this.terminalCallbacks.onStarted?.({
          spec,
          workspaceViewId: workspace?.workspaceViewId ?? workspaceViewId(spec.sessionId),
          startedAt: now,
          processReference: claim.processReference,
        });
        const process = await this.options.processController.spawn(spec, claim.launchId, claim.processReference);
        await this.options.claims.update(key, (current) => runningClaim(current, process));
        return claim.receipt;
      } catch (error) {
        if (error instanceof HostFailure) throw error;
        if (error instanceof CustodyFailureError) throw new HostFailure({ _tag: "WorkspaceUnavailable", reason: error.message });
        throw new HostFailure({ _tag: "ProcessUnavailable", reason: errorMessage(error) });
      }
    });
  }

  private async reconcileClaim(claim: StartClaim): Promise<SessionHostReceipt> {
    if (claim.state === "terminal") return claim.receipt;
    const existing = await this.options.processController.findExisting(claim);
    if (existing === undefined || existing.reference !== claim.processReference) {
      throw new HostFailure({
        _tag: "ProcessUnavailable",
        reason: `persisted launch ${claim.launchId} has no discoverable process; refusing a second OMP`,
      });
    }
    if (claim.state !== "running" || claim.processId !== existing.pid) {
      await this.options.claims.update(claim.key as `${SessionId}:${EffectId}`, (current) => runningClaim(current, existing));
    }
    return claim.receipt;
  }

  private async cancelAsync(sessionId: SessionId, reason: string): Promise<SessionHostReceipt> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) throw new HostFailure({ _tag: "HostUnavailable", reason: "cancellation reason is required" });
    return this.withLock(sessionId, async () => {
      const claim = await this.findSessionClaim(sessionId);
      if (claim === undefined) throw new HostFailure({ _tag: "SessionNotFound", sessionId });
      if (claim.state === "terminal") return claim.receipt;
      await this.options.processController.cancel(sessionId, normalizedReason).catch((error) => {
        throw new HostFailure({ _tag: "ProcessUnavailable", reason: errorMessage(error) });
      });
      return this.reportTerminalLocked(claim, "interrupted", "cancelled");
    });
  }

  private async reportTerminalAsync(sessionId: SessionId, status: "completed" | "failed" | "interrupted", reason: string): Promise<SessionHostReceipt> {
    return this.withLock(sessionId, async () => {
      const claim = await this.findSessionClaim(sessionId);
      if (claim === undefined) throw new HostFailure({ _tag: "SessionNotFound", sessionId });
      if (claim.state === "terminal") return claim.receipt;
      return this.reportTerminalLocked(claim, status, reason);
    });
  }

  private async reportTerminalLocked(claim: StartClaim, status: "completed" | "failed" | "interrupted", reason: string): Promise<SessionHostReceipt> {
    const terminalAt = timestamp(this.clock.now());
    const terminalClaim = await this.options.claims.update(claim.key as `${SessionId}:${EffectId}`, (current) => ({
      ...current,
      state: "terminal",
      terminalStatus: status,
      terminalReason: reason,
      terminalAt,
    }));
    try {
      await this.terminalCallbacks.onTerminal?.({ sessionId: claim.sessionId, effectId: claim.effectId, status, reason, terminalAt });
      await this.options.workspace?.revoke(claim.sessionId);
    } catch (error) {
      throw new HostFailure({ _tag: "HostUnavailable", reason: errorMessage(error) });
    }
    return terminalClaim.receipt;
  }

  private async prepareWorkspace(spec: SessionStartSpec): Promise<WorkspaceSession | undefined> {
    if (this.options.workspace === undefined) return undefined;
    try {
      return await this.options.workspace.prepare(spec);
    } catch (error) {
      if (error instanceof CustodyFailureError) throw error;
      throw new CustodyFailureError({ _tag: "SnapshotUnavailable", reason: errorMessage(error) });
    }
  }

  private async findSessionClaim(sessionId: SessionId): Promise<StartClaim | undefined> {
    const claims = await this.options.claims.list();
    return claims.find((claim) => claim.sessionId === sessionId);
  }
  private async withLock<A>(key: string, operation: () => Promise<A>): Promise<A> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => next);
    this.locks.set(key, queued);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export class InMemoryReadinessProbe implements ReadinessProbe {
  constructor(private readonly ready: WorkspaceReady | (() => Promise<WorkspaceReady>)) {}
  async ensureReady(_lease: WorkspaceLease, _timeoutMs: number): Promise<WorkspaceReady> {
    return typeof this.ready === "function" ? this.ready() : this.ready;
  }
}

export interface DecodedCommandDispatcher {
  dispatch(input: unknown): Promise<CommandResult>;
}

export class StrictCommandDispatcher implements DecodedCommandDispatcher {
  constructor(private readonly dispatchDecoded: (envelope: CommandEnvelope) => Promise<unknown>) {}

  async dispatch(input: unknown): Promise<CommandResult> {
    const envelope = decodeCommandEnvelope(input);
    const result = await this.dispatchDecoded(envelope);
    return decodeCommandResult(result);
  }
}

export interface HostCommandCallbacks {
  readonly dispatcher: DecodedCommandDispatcher;
  readonly makeEnvelope: (command: ProjectCommand) => Promise<CommandEnvelope>;
}

export const dispatchDecodedCommand = async (callbacks: HostCommandCallbacks, command: ProjectCommand): Promise<CommandResult> => {
  const envelope = await callbacks.makeEnvelope(command);
  return callbacks.dispatcher.dispatch(envelope);
};

export const decodeHostLease = (input: unknown): WorkspaceLease => decodeUnknownStrict(WorkspaceLeaseSchema, input);
export const decodeHostStartSpec = (input: unknown): SessionStartSpec => decodeUnknownStrict(SessionStartSpecSchema, input);
export const decodeHostCancel = (input: unknown): SessionHostCancelRequest => decodeUnknownStrict(SessionHostCancelRequestSchema, input);
export const decodeHostReceipt = (input: unknown): SessionHostReceipt => decodeUnknownStrict(SessionHostReceiptSchema, input);

const runningClaim = (claim: StartClaim, process: SessionProcess): StartClaim => ({
  ...claim,
  state: "running",
  ...(process.pid === undefined ? {} : { processId: process.pid }),
  processReference: process.reference,
  startedAt: process.startedAt as Timestamp,
});

const timestamp = (date: Date): Timestamp => date.toISOString().replace(/(\.\d{3})\d*Z$/u, "$1Z") as Timestamp;
const toHostError = (error: unknown): SessionHostError => {
  if (error instanceof HostFailure && isSessionHostFailure(error.failure) && isRuntimeSessionHostError(error.failure)) return error.failure;
  if (error instanceof HostFailure) return { _tag: "HostUnavailable", reason: failureReason(error.failure) };
  return { _tag: "HostUnavailable", reason: errorMessage(error) };
};
const isRuntimeSessionHostError = (error: unknown): error is SessionHostError => {
  if (!isSessionHostFailure(error)) return false;
  return ["LeaseExpired", "WorkspaceUnavailable", "ReadinessFailed", "VersionMismatch", "SessionNotFound", "SessionAlreadyStarted", "ProcessUnavailable", "ModelUnavailable", "HostUnavailable"].includes(error._tag);
};
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const withTimeout = async <A>(promise: Promise<A>, timeoutMs: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<A>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

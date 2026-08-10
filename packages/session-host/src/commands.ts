import type {
  ActorId,
  AuthenticatedActor,
  CommandEnvelope,
  CommandResult,
  EffectId,
  Evidence,
  EventRevision,
  GrantId,
  Handoff,
  ProjectCommand,
  ProjectId,
  Proposal,
  SessionId,
  SessionStartSpec,
  Timestamp,
  WorkspaceViewId,
} from "@work-engine/protocol";
import { EventRevisionSchema, SchemaVersionSchema, makeCommandId } from "@work-engine/protocol";
import { HostFailure } from "./errors.ts";
import type { DecodedCommandDispatcher, SessionHostLifecycleCallbacks, SessionStartedContext, SessionTerminalContext } from "./host.ts";

export interface HostRevisionProvider {
  currentRevision(projectId: ProjectId): Promise<EventRevision>;
}
export interface HostActorOptions {
  readonly actorId: ActorId;
  readonly grants: readonly GrantId[];
}

export interface DecodedHostCommandOptions {
  readonly projectId: ProjectId;
  readonly actor: AuthenticatedActor | HostActorOptions;
  readonly revision: HostRevisionProvider;
  readonly dispatcher: DecodedCommandDispatcher;
}

/**
 * Builds every host callback as a normal CommandEnvelope, then routes it
 * through StrictCommandDispatcher so lifecycle traffic cannot bypass schema
 * decoding or Project authority.
 */
export class DecodedHostCommandCallbacks {
  private readonly terminalSessions = new Map<SessionId, SessionTerminalContext>();
  private readonly actor: AuthenticatedActor;

  constructor(private readonly options: DecodedHostCommandOptions) {
    this.actor = "kind" in options.actor ? options.actor : {
      _tag: "AuthenticatedActor",
      actorId: options.actor.actorId,
      kind: "session_host",
      presentedGrants: options.actor.grants,
    };
  }

  async dispatch(command: ProjectCommand): Promise<CommandResult> {
    const expectedRevision = await this.options.revision.currentRevision(this.options.projectId);
    const envelope: CommandEnvelope = {
      schemaVersion: SchemaVersionSchema.make("work-engine/v1"),
      commandId: makeCommandId(),
      projectId: this.options.projectId,
      expectedRevision,
      actor: this.actor,
      command,
    };
    return this.options.dispatcher.dispatch(envelope);
  }

  async reportStarted(context: SessionStartedContext): Promise<CommandResult> {
    return this.dispatch({
      _tag: "ReportSessionStarted",
      sessionId: context.spec.sessionId,
      workspaceViewId: context.workspaceViewId as WorkspaceViewId,
      startedAt: context.startedAt,
      ...(context.spec.effectId === undefined ? {} : { effectId: context.spec.effectId }),
    });
  }

  async reportTerminal(context: SessionTerminalContext): Promise<CommandResult> {
    const previous = this.terminalSessions.get(context.sessionId);
    if (previous !== undefined) {
      if (previous.status === context.status && previous.reason === context.reason) return this.dispatch({
        _tag: "ReportSessionTerminal",
        sessionId: context.sessionId,
        status: context.status,
        reason: context.reason,
        terminalAt: context.terminalAt,
        effectId: context.effectId,
      });
      throw new HostFailure({ _tag: "HostUnavailable", reason: `conflicting terminal report for ${context.sessionId}` });
    }
    this.terminalSessions.set(context.sessionId, context);
    return this.dispatch({
      _tag: "ReportSessionTerminal",
      sessionId: context.sessionId,
      status: context.status,
      reason: context.reason,
      terminalAt: context.terminalAt,
      effectId: context.effectId,
    });
  }

  async recordEvidence(evidence: Evidence): Promise<CommandResult> {
    return this.dispatch({ _tag: "RecordEvidence", evidence });
  }

  async recordHandoff(handoff: Handoff): Promise<CommandResult> {
    return this.dispatch({ _tag: "RecordHandoff", handoff });
  }

  async submitProposal(proposal: Proposal): Promise<CommandResult> {
    return this.dispatch(proposalCommand(proposal));
  }
}

export const proposalCommand = (proposal: Proposal): Extract<ProjectCommand, { readonly _tag: "SubmitProposal" }> => ({
  _tag: "SubmitProposal",
  proposal,
});

export interface SessionHostLifecycleCommandOptions extends DecodedHostCommandOptions {
  readonly onTerminalFlush?: () => Promise<void>;
}

export const makeDecodedLifecycleCallbacks = (options: SessionHostLifecycleCommandOptions): SessionHostLifecycleCallbacks => {
  const callbacks = new DecodedHostCommandCallbacks(options);
  return {
    onStarted: async (context) => {
      await callbacks.reportStarted(context);
    },
    onTerminal: async (context) => {
      await callbacks.reportTerminal(context);
    },
    flushPending: options.onTerminalFlush,
  };
};

export const terminalTimestamp = (value: Date): Timestamp => value.toISOString() as Timestamp;
export const eventRevision = (value: number): EventRevision => EventRevisionSchema.make(value);
export const effectIdOf = (spec: SessionStartSpec): EffectId => spec.effectId;

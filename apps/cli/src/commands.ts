import { Effect, Schema } from "effect";
import {
  AgentProfileIdSchema,
  ApproveProposalSchema,
  CancelSessionSchema,
  CommandIdSchema,
  CreateProjectSchema,
  CreateProjectRequestSchema,
  EffectIdSchema,
  EvidenceIdSchema,
  EvidenceSchema,
  EventRevisionSchema,
  GrantIdSchema,
  MergeIdSchema,
  MergeProposalSchema,
  OpenManagerSessionSchema,
  PolicyIdSchema,
  PolicySchema,
  ProjectIdSchema,
  ProposalIdSchema,
  RejectProposalSchema,
  ResourceIdSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  SchemaVersionSchema,
  SubmitWorkSchema,
  WorkIdSchema,
  WorkProcessIdSchema,
  type CommandResult,
  type CreateProjectRequest,
  type EventRevision,
  type ProjectCommand,
  type ProjectId,
  type ProjectObservation,
  type WorkId,
} from "@work-engine/protocol";
import { AttachResolutionRequestSchema, type ProjectCreateResult } from "@work-engine/runtime";
import { runAttach, type AttachOutcome } from "./attach.ts";
import { loadOperatorConfig, type ConfigError, type OperatorConfig } from "./config.ts";
import { makeRemoteClient, type RemoteClient } from "./client.ts";
import type { CliFailure } from "./output.ts";
import { readTextFile } from "./platform.ts";

export interface ParsedInvocation {
  readonly command: string;
  readonly json: boolean;
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positional: ReadonlyArray<string>;
}

export type ParseError = { readonly _tag: "UsageFailure"; readonly reason: string };

const COMMANDS: ReadonlySet<string> = new Set([
  "project create",
  "submit",
  "attach",
  "status",
  "session start",
  "session cancel",
  "evidence show",
  "proposal show",
  "approve",
  "reject",
  "merge",
  "why",
  "mcp",
]);

const commandName = (
  argv: ReadonlyArray<string>,
): { readonly command: string; readonly consumed: number } | ParseError => {
  const first = argv[0];
  if (first === undefined) return { _tag: "UsageFailure", reason: "a work command is required" };
  if (first === "project" || first === "session" || first === "evidence" || first === "proposal") {
    const second = argv[1];
    if (second === undefined)
      return { _tag: "UsageFailure", reason: `${first} requires a subcommand` };
    const command = `${first} ${second}`;
    if (COMMANDS.has(command)) return { command, consumed: 2 };
    return { _tag: "UsageFailure", reason: `unknown command ${command}` };
  }
  if (COMMANDS.has(first)) return { command: first, consumed: 1 };
  return { _tag: "UsageFailure", reason: `unknown command ${first}` };
};

export const parseInvocation = (argv: ReadonlyArray<string>): ParsedInvocation | ParseError => {
  const named = commandName(argv);
  if ("_tag" in named) return named;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  let json = false;
  for (let index = named.consumed; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equal = argument.indexOf("=");
    const key = equal >= 0 ? argument.slice(2, equal) : argument.slice(2);
    if (key.length === 0) return { _tag: "UsageFailure", reason: "empty option name" };
    if (equal >= 0) {
      const value = argument.slice(equal + 1);
      if (value.length === 0)
        return { _tag: "UsageFailure", reason: `option --${key} requires a value` };
      flags.set(key, value);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command: named.command, json, flags, positional };
};

const fail = (reason: string): Effect.Effect<never, ParseError> =>
  Effect.fail({ _tag: "UsageFailure", reason });

const flag = (invocation: ParsedInvocation, name: string): string | undefined => {
  const value = invocation.flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const requiredFlag = (
  invocation: ParsedInvocation,
  name: string,
): Effect.Effect<string, ParseError> => {
  const value = flag(invocation, name);
  return value === undefined ? fail(`--${name} is required`) : Effect.succeed(value);
};

const positionalOrFlag = (
  invocation: ParsedInvocation,
  position: number,
  name: string,
): Effect.Effect<string, ParseError> => {
  const value = flag(invocation, name) ?? invocation.positional[position];
  return value === undefined
    ? fail(`${name === "project" ? "a Project id" : `--${name}`} is required`)
    : Effect.succeed(value);
};

const parseWith = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  name: string,
): Effect.Effect<S["Type"], ParseError> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError((error) => ({
      _tag: "UsageFailure" as const,
      reason: `invalid ${name}: ${String(error)}`,
    })),
  );

const parseNatural = (value: string, name: string): Effect.Effect<number, ParseError> => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Effect.succeed(number)
    : fail(`${name} must be a non-negative safe integer`);
};

const timestamp = (millisecondsFromNow: number): string =>
  new Date(Date.now() + millisecondsFromNow).toISOString();

const readJsonFile = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  path: string,
  name: string,
): Effect.Effect<S["Type"], ParseError> =>
  Effect.gen(function* () {
    const text = yield* readTextFile(path).pipe(
      Effect.mapError((error) => ({
        _tag: "UsageFailure" as const,
        reason: `cannot read ${name}: ${error instanceof Error ? error.message : String(error)}`,
      })),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => ({
        _tag: "UsageFailure" as const,
        reason: `invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
      }),
    });
    return yield* parseWith(schema, parsed, name);
  });

const acceptedResult = (result: CommandResult): Effect.Effect<CommandResult, CliFailure> => {
  if (result._tag === "Rejected") {
    return Effect.fail({
      _tag: "DomainFailure",
      reason: `${result.code}: ${JSON.stringify(result.details)}`,
    } as const);
  }
  return Effect.succeed(result);
};

const acceptedCreateResult = (
  result: ProjectCreateResult,
): Effect.Effect<ProjectCreateResult, CliFailure> => {
  if (result.result._tag === "Rejected") {
    return Effect.fail({
      _tag: "DomainFailure",
      reason: `${result.result.code}: ${JSON.stringify(result.result.details)}`,
    } as const);
  }
  return Effect.succeed(result);
};

const observationRevision = (
  invocation: ParsedInvocation,
  observation: ProjectObservation,
): Effect.Effect<EventRevision, ParseError> => {
  const value = flag(invocation, "expected-revision");
  return value === undefined
    ? Effect.succeed(observation.eventRevision)
    : parseNatural(value, "--expected-revision").pipe(
        Effect.flatMap((revision) => parseWith(EventRevisionSchema, revision, "expected revision")),
      );
};

const actorCommand = (
  client: RemoteClient,
  invocation: ParsedInvocation,
  projectId: ProjectId,
  command: ProjectCommand,
  observation?: ProjectObservation,
): Effect.Effect<CommandResult, CliFailure> =>
  Effect.gen(function* () {
    const revision =
      observation === undefined
        ? yield* parseNatural(
            flag(invocation, "expected-revision") ?? "0",
            "--expected-revision",
          ).pipe(
            Effect.flatMap((value) => parseWith(EventRevisionSchema, value, "expected revision")),
          )
        : yield* observationRevision(invocation, observation);
    const id = yield* parseWith(CommandIdSchema, `cmd_${crypto.randomUUID()}`, "command id");
    return yield* client
      .dispatch(projectId, id, revision, command)
      .pipe(Effect.flatMap(acceptedResult));
  });

export const buildCreateProjectRequest = (
  invocation: ParsedInvocation,
): Effect.Effect<CreateProjectRequest, ParseError> =>
  Effect.gen(function* () {
    const policyId = yield* parseWith(
      PolicyIdSchema,
      flag(invocation, "policy-id") ?? "pol_tracer_0001_v1",
      "policy id",
    );
    const revision = yield* parseNatural(
      flag(invocation, "policy-revision") ?? "0",
      "--policy-revision",
    );
    const maxAttempts = yield* parseNatural(
      flag(invocation, "max-attempts") ?? "2",
      "--max-attempts",
    );
    const policy = yield* parseWith(
      PolicySchema,
      {
        _tag: "Policy",
        policyId,
        revision,
        requiredGates: [
          "gat_session_completed",
          "gat_candidate_present",
          "gat_scope_valid",
          "gat_check_passed",
          "gat_human_approved",
        ],
        mergeCapability: "proposal.merge",
        maxAttempts,
      },
      "policy",
    );
    const command = yield* parseWith(
      CreateProjectSchema,
      { _tag: "CreateProject", policy },
      "create command",
    );
    return yield* parseWith(
      CreateProjectRequestSchema,
      {
        schemaVersion: SchemaVersionSchema.make("work-engine/v1"),
        commandId: yield* parseWith(CommandIdSchema, `cmd_${crypto.randomUUID()}`, "command id"),
        command,
      },
      "create request",
    );
  });

const buildSubmitWork = (invocation: ParsedInvocation): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const workId = yield* parseWith(
      WorkIdSchema,
      flag(invocation, "work-id") ?? `wrk_${crypto.randomUUID()}`,
      "Work id",
    );
    const processId = yield* parseWith(
      WorkProcessIdSchema,
      flag(invocation, "work-process-id") ?? `wpr_${crypto.randomUUID()}`,
      "Work Process id",
    );
    const objective = yield* requiredFlag(invocation, "objective");
    const kind = yield* requiredFlag(invocation, "kind");
    const requiredCheck = yield* requiredFlag(invocation, "required-check");
    const writableScope = (flag(invocation, "writable-scope") ?? "src/greeting.ts")
      .split(",")
      .filter(Boolean);
    const title = flag(invocation, "title");
    const value: Record<string, unknown> = {
      _tag: "SubmitWork",
      workId,
      workProcessId: processId,
      objective,
      kind,
      writableScope,
      requiredCheck,
    };
    if (title !== undefined) value["title"] = title;
    return yield* parseWith(SubmitWorkSchema, value, "submit command");
  });

const buildManagerSession = (
  invocation: ParsedInvocation,
): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseWith(
      SessionIdSchema,
      flag(invocation, "session-id") ?? `ses_${crypto.randomUUID()}`,
      "Session id",
    );
    const workId = yield* parseWith(
      WorkIdSchema,
      yield* requiredFlag(invocation, "work"),
      "Work id",
    );
    const profileId = yield* parseWith(
      AgentProfileIdSchema,
      flag(invocation, "profile") ?? `prf_${crypto.randomUUID()}`,
      "Profile id",
    );
    const attempt = yield* parseNatural(flag(invocation, "attempt") ?? "0", "--attempt");
    const contextReference = flag(invocation, "context") ?? "project-observation/current";
    const deadline = yield* parseWith(
      TimestampSchema,
      flag(invocation, "deadline") ?? timestamp(30 * 60 * 1000),
      "deadline",
    );
    const outputLimit = yield* parseNatural(
      flag(invocation, "output-limit") ?? `${10 * 1024 * 1024}`,
      "--output-limit",
    );
    const toolBudget = yield* parseNatural(
      flag(invocation, "tool-budget") ?? "100",
      "--tool-budget",
    );
    const resourceId = yield* parseWith(
      ResourceIdSchema,
      flag(invocation, "resource") ?? `res_${crypto.randomUUID()}`,
      "Resource id",
    );
    const effectId = yield* parseWith(
      EffectIdSchema,
      flag(invocation, "effect") ?? `efx_${crypto.randomUUID()}`,
      "Effect id",
    );
    return yield* parseWith(
      OpenManagerSessionSchema,
      {
        _tag: "OpenManagerSession",
        sessionId,
        workId,
        profileId,
        attempt,
        contextReference,
        deadline,
        outputLimit,
        toolBudget,
        resourceId,
        effectId,
      },
      "session start command",
    );
  });

const buildCancelSession = (
  invocation: ParsedInvocation,
): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const sessionId = yield* parseWith(
      SessionIdSchema,
      yield* requiredFlag(invocation, "session"),
      "Session id",
    );
    const effectId = yield* parseWith(
      EffectIdSchema,
      flag(invocation, "effect") ?? `efx_${crypto.randomUUID()}`,
      "Effect id",
    );
    const reason = flag(invocation, "reason") ?? "operator requested cancellation";
    return yield* parseWith(
      CancelSessionSchema,
      { _tag: "CancelSession", sessionId, effectId, reason },
      "session cancel command",
    );
  });

const buildApproval = (invocation: ParsedInvocation): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const proposalId = yield* parseWith(
      ProposalIdSchema,
      yield* requiredFlag(invocation, "proposal"),
      "Proposal id",
    );
    const evidencePath = yield* requiredFlag(invocation, "evidence");
    const evidence = yield* readJsonFile(EvidenceSchema, evidencePath, "approval evidence");
    return yield* parseWith(
      ApproveProposalSchema,
      { _tag: "ApproveProposal", proposalId, evidence },
      "approval command",
    );
  });

const buildRejection = (invocation: ParsedInvocation): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const proposalId = yield* parseWith(
      ProposalIdSchema,
      yield* requiredFlag(invocation, "proposal"),
      "Proposal id",
    );
    const reason = yield* requiredFlag(invocation, "reason");
    return yield* parseWith(
      RejectProposalSchema,
      { _tag: "RejectProposal", proposalId, reason },
      "rejection command",
    );
  });

const buildMerge = (invocation: ParsedInvocation): Effect.Effect<ProjectCommand, ParseError> =>
  Effect.gen(function* () {
    const mergeId = yield* parseWith(
      MergeIdSchema,
      flag(invocation, "merge-id") ?? `mrg_${crypto.randomUUID()}`,
      "Merge id",
    );
    const proposalId = yield* parseWith(
      ProposalIdSchema,
      yield* requiredFlag(invocation, "proposal"),
      "Proposal id",
    );
    const grantId = yield* parseWith(
      GrantIdSchema,
      yield* requiredFlag(invocation, "grant"),
      "Grant id",
    );
    const candidateDigest = yield* parseWith(
      Sha256DigestSchema,
      yield* requiredFlag(invocation, "candidate"),
      "candidate digest",
    );
    return yield* parseWith(
      MergeProposalSchema,
      { _tag: "MergeProposal", mergeId, proposalId, grantId, candidateDigest },
      "merge command",
    );
  });

const observationFor = (
  client: RemoteClient,
  projectId: ProjectId,
): Effect.Effect<ProjectObservation, CliFailure> => client.observe(projectId);

const projectIdFor = (invocation: ParsedInvocation): Effect.Effect<ProjectId, ParseError> =>
  positionalOrFlag(invocation, 0, "project").pipe(
    Effect.flatMap((value) => parseWith(ProjectIdSchema, value, "Project id")),
  );

const attachWorkIdFor = (invocation: ParsedInvocation): Effect.Effect<WorkId, ParseError> => {
  const value = flag(invocation, "work") ?? invocation.positional[1];
  return value === undefined
    ? fail("--work is required")
    : parseWith(WorkIdSchema, value, "Work id");
};

const findEvent = (
  observation: ProjectObservation,
  eventTag: "EvidenceRecorded" | "ProposalSubmitted",
  id: string,
): unknown =>
  observation.history.find((entry) => {
    if (eventTag === "EvidenceRecorded" && entry.event._tag === eventTag) {
      return entry.event.evidence.evidenceId === id;
    }
    if (eventTag === "ProposalSubmitted" && entry.event._tag === eventTag) {
      return entry.event.proposal.proposalId === id;
    }
    return false;
  }) ?? null;

const why = (
  observation: ProjectObservation,
  invocation: ParsedInvocation,
): Effect.Effect<unknown, CliFailure> =>
  Effect.gen(function* () {
    const revisionValue = flag(invocation, "event-revision");
    const targetRevision =
      revisionValue === undefined
        ? undefined
        : yield* parseNatural(revisionValue, "--event-revision");
    const selected =
      targetRevision === undefined
        ? observation.history
        : observation.history.filter((entry) => entry.eventRevision === targetRevision);
    if (selected.length === 0) {
      return yield* Effect.fail({
        _tag: "DomainFailure",
        reason: "canonical event reference was not found",
      } as const);
    }
    return {
      _tag: "Why",
      projectId: observation.projectId,
      sourceDigest: observation.sourceDigest,
      references: selected.map((entry) => ({
        eventRevision: entry.eventRevision,
        eventId: entry.commandId,
        eventTag: entry.event._tag,
      })),
    };
  });

export type CommandResultData =
  | ProjectCreateResult
  | CommandResult
  | ProjectObservation
  | AttachOutcome
  | unknown;

export const executeInvocation = (
  invocation: ParsedInvocation,
  client: RemoteClient,
  config: OperatorConfig,
): Effect.Effect<CommandResultData, CliFailure> => {
  switch (invocation.command) {
    case "project create":
      return Effect.gen(function* () {
        const request = yield* buildCreateProjectRequest(invocation);
        return yield* client.createProject(request).pipe(Effect.flatMap(acceptedCreateResult));
      });
    case "submit":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const command = yield* buildSubmitWork(invocation);
        return yield* actorCommand(client, invocation, projectId, command);
      });
    case "status":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        return yield* observationFor(client, projectId);
      });
    case "session start":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const command = yield* buildManagerSession(invocation);
        return yield* actorCommand(client, invocation, projectId, command);
      });
    case "session cancel":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const command = yield* buildCancelSession(invocation);
        return yield* actorCommand(client, invocation, projectId, command);
      });
    case "evidence show":
    case "proposal show":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const observation = yield* observationFor(client, projectId);
        const id = yield* requiredFlag(
          invocation,
          invocation.command === "evidence show" ? "evidence" : "proposal",
        );
        const canonicalId =
          invocation.command === "evidence show"
            ? yield* parseWith(EvidenceIdSchema, id, "Evidence id")
            : yield* parseWith(ProposalIdSchema, id, "Proposal id");
        const found = findEvent(
          observation,
          invocation.command === "evidence show" ? "EvidenceRecorded" : "ProposalSubmitted",
          canonicalId,
        );
        if (found === null) {
          return yield* Effect.fail({
            _tag: "DomainFailure",
            reason: "canonical reference was not found",
          } as const);
        }
        return found;
      });
    case "approve":
    case "reject":
    case "merge":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const observation = yield* observationFor(client, projectId);
        const command =
          invocation.command === "approve"
            ? yield* buildApproval(invocation)
            : invocation.command === "reject"
              ? yield* buildRejection(invocation)
              : yield* buildMerge(invocation);
        return yield* actorCommand(client, invocation, projectId, command, observation);
      });
    case "why":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        return yield* why(yield* observationFor(client, projectId), invocation);
      });
    case "attach":
      return Effect.gen(function* () {
        const projectId = yield* projectIdFor(invocation);
        const workId = yield* attachWorkIdFor(invocation);
        const request = yield* parseWith(
          AttachResolutionRequestSchema,
          { _tag: "AttachResolutionRequest", workId },
          "attach request",
        );
        const resolution = yield* client.attachResolution(projectId, request);
        return yield* runAttach(resolution, projectId, workId, config, { json: invocation.json });
      });
    default:
      return fail(`unsupported command ${invocation.command}`);
  }
};

export const loadClientForInvocation = (
  invocation: ParsedInvocation,
): Effect.Effect<{ readonly client: RemoteClient; readonly config: OperatorConfig }, ConfigError> =>
  Effect.gen(function* () {
    const config = yield* loadOperatorConfig;
    if (invocation.command === "mcp")
      return yield* Effect.fail({
        _tag: "OperatorRequired",
        reason: "MCP uses a Session capability file",
      } as const);
    return { config, client: makeRemoteClient(config) };
  });

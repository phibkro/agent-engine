import { Effect, Schema } from "effect";
import {
  CommandIdSchema,
  EventRevisionSchema,
  ProjectIdSchema,
  ProjectCommandSchema,
  type Capability,
  type ProjectId,
  type ProjectObservation,
  type ProjectCommand,
} from "@work-engine/protocol";
import { makeRemoteClient, type RemoteClientError } from "./client.ts";
import type { ConfigError, SessionCapabilityFile } from "./config.ts";

export const SessionToolName = {
  projectRead: "project.read",
  workRead: "work.read",
  evidenceRead: "evidence.read",
  proposalRead: "proposal.read",
  workerStart: "worker.start",
  sessionCancel: "session.cancel",
  candidateFinalize: "candidate.finalize",
} as const;
export type SessionToolName = (typeof SessionToolName)[keyof typeof SessionToolName];

export interface McpTool {
  readonly name: SessionToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const SESSION_TOOLS: ReadonlyArray<McpTool> = [
  {
    name: SessionToolName.projectRead,
    description: "Read the current Project observation for this Session's scope.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  },
  {
    name: SessionToolName.workRead,
    description: "Read the current Project observation containing Work state.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
  },
  {
    name: SessionToolName.evidenceRead,
    description: "Read canonical Evidence references from a Project observation.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, evidenceId: { type: "string" } }, required: ["projectId", "evidenceId"] },
  },
  {
    name: SessionToolName.proposalRead,
    description: "Read canonical Proposal references from a Project observation.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, proposalId: { type: "string" } }, required: ["projectId", "proposalId"] },
  },
  {
    name: SessionToolName.workerStart,
    description: "Request a worker Session when this Session's Grant permits it.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, expectedRevision: { type: "number" }, commandId: { type: "string" }, command: { type: "object" } }, required: ["projectId", "expectedRevision", "commandId", "command"] },
  },
  {
    name: SessionToolName.sessionCancel,
    description: "Request cancellation of a Session when this Session's Grant permits it.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, expectedRevision: { type: "number" }, commandId: { type: "string" }, command: { type: "object" } }, required: ["projectId", "expectedRevision", "commandId", "command"] },
  },
  {
    name: SessionToolName.candidateFinalize,
    description: "Forward a candidate.finalize request to the loopback Session host.",
    inputSchema: { type: "object", additionalProperties: true },
  },
];

export type McpError =
  | ConfigError
  | RemoteClientError
  | { readonly _tag: "McpDecodeFailure"; readonly reason: string }
  | { readonly _tag: "McpForbidden"; readonly reason: string }
  | { readonly _tag: "McpLoopbackFailure"; readonly reason: string };

const JsonRpcIdSchema = Schema.Union([Schema.String, Schema.Number]);
const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcIdSchema),
  method: Schema.NonEmptyString,
  params: Schema.optionalKey(Schema.Json),
});
type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

const ToolCommandParamsSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  expectedRevision: EventRevisionSchema,
  commandId: CommandIdSchema,
  command: ProjectCommandSchema,
});

type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: string | number | undefined; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: string | number | undefined; readonly error: { readonly code: number; readonly message: string } };

const errorReason = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return String(error);
  if ("reason" in error && typeof error.reason === "string") return error.reason;
  if ("failure" in error && typeof error.failure === "object" && error.failure !== null && "code" in error.failure && "reason" in error.failure) {
    return `${String(error.failure.code)}: ${String(error.failure.reason)}`;
  }
  if ("name" in error && typeof error.name === "string") return error.name;
  if ("_tag" in error && typeof error._tag === "string") return error._tag;
  return String(error);
};

const capabilityAllows = (
  capability: SessionCapabilityFile,
  name: SessionToolName,
  projectId?: ProjectId,
): boolean => {
  const required: ReadonlyArray<Capability> =
    name === SessionToolName.projectRead || name === SessionToolName.workRead
      ? ["project.read", "work.read"]
      : name === SessionToolName.evidenceRead
        ? ["evidence.read"]
        : name === SessionToolName.proposalRead
          ? ["proposal.read"]
          : name === SessionToolName.workerStart
            ? ["worker.start"]
            : name === SessionToolName.sessionCancel
              ? ["session.cancel"]
              : ["candidate.finalize"];
  const ids = new Set(capability.actor.presentedGrants);
  const now = Date.now();
  return required.some((candidate) =>
    capability.grants.some(
      (grant) =>
        ids.has(grant.grantId) &&
        grant.capability === candidate &&
        grant.subjectActorId === capability.actor.actorId &&
        Date.parse(grant.validFrom) <= now &&
        Date.parse(grant.validUntil) > now &&
        (projectId === undefined || grant.scope.projectId === projectId) &&
        (grant.scope.sessionId === undefined || grant.scope.sessionId === capability.sessionId),
    ),
  );
};

const projectIdFrom = (params: unknown): Effect.Effect<ProjectId, McpError> =>
  Effect.try({
    try: () => {
      if (typeof params !== "object" || params === null || !("projectId" in params)) {
        throw new Error("projectId is required");
      }
      return Schema.decodeUnknownSync(ProjectIdSchema, { onExcessProperty: "error" })(params.projectId);
    },
    catch: (error) => ({ _tag: "McpDecodeFailure" as const, reason: errorReason(error) }),
  });

const observationFor = (
  observation: ProjectObservation,
  method: SessionToolName,
  params: unknown,
): unknown => {
  if (method === SessionToolName.projectRead || method === SessionToolName.workRead) return observation;
  const property = method === SessionToolName.evidenceRead ? "evidenceId" : "proposalId";
  const requested = typeof params === "object" && params !== null && property in params ? params[property] : undefined;
  return observation.history.find((entry) => {
    if (method === SessionToolName.evidenceRead && entry.event._tag === "EvidenceRecorded") return requested === entry.event.evidence.evidenceId;
    if (method === SessionToolName.proposalRead && entry.event._tag === "ProposalSubmitted") return requested === entry.event.proposal.proposalId;
    return false;
  }) ?? null;
};

type ToolCommandParams = typeof ToolCommandParamsSchema.Type;

const parseToolCommand = (
  params: unknown,
  expectedTag: "StartWorkerSession" | "CancelSession",
): Effect.Effect<ToolCommandParams, McpError> =>
  Effect.try({
    try: () => {
      const parsed = Schema.decodeUnknownSync(ToolCommandParamsSchema, { onExcessProperty: "error" })(params);
      if (parsed.command._tag !== expectedTag) throw new Error(`expected ${expectedTag}`);
      return parsed;
    },
    catch: (error) => ({ _tag: "McpDecodeFailure" as const, reason: errorReason(error) }),
  });

const forwardCandidateFinalize = (
  capability: SessionCapabilityFile,
  request: JsonRpcRequest,
): Effect.Effect<unknown, McpError> =>
  Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => {
        const parsed = new URL(capability.endpoint);
        if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]") {
          throw new Error("Session host endpoint is not loopback");
        }
        return parsed.toString();
      },
      catch: (error) => ({ _tag: "McpLoopbackFailure" as const, reason: errorReason(error) }),
    });
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: request.id, method: "candidate.finalize", params: request.params ?? null }),
          signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Session host returned HTTP ${response.status}: ${text}`);
        return JSON.parse(text) as unknown;
      },
      catch: (error) => ({ _tag: "McpLoopbackFailure" as const, reason: errorReason(error) }),
    });
  });

export const handleMcpRequest = (
  capability: SessionCapabilityFile,
  requestInput: unknown,
): Effect.Effect<JsonRpcResponse, McpError> =>
  Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(JsonRpcRequestSchema, { onExcessProperty: "error" })(requestInput),
      catch: (error) => ({ _tag: "McpDecodeFailure" as const, reason: errorReason(error) }),
    });
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0" as const,
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "work-engine", version: "0.0.0" },
        },
      };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0" as const, id: request.id, result: { tools: SESSION_TOOLS } };
    }
    if (request.method === "notifications/initialized") {
      return { jsonrpc: "2.0" as const, id: request.id, result: null };
    }
    if (request.method !== "tools/call") {
      return yield* Effect.fail({ _tag: "McpForbidden", reason: `method ${request.method} is not permitted` } as const);
    }
    const params = request.params;
    if (typeof params !== "object" || params === null || !("name" in params)) {
      return yield* Effect.fail({ _tag: "McpDecodeFailure", reason: "tools/call requires a tool name" } as const);
    }
    const nameValue = params.name;
    const name = typeof nameValue === "string"
      ? SESSION_TOOLS.find((tool) => tool.name === nameValue)?.name
      : undefined;
    if (name === undefined) {
      return yield* Effect.fail({ _tag: "McpForbidden", reason: "tool is not in the Session allowlist" } as const);
    }
    const toolArguments = "arguments" in params ? params.arguments : null;
    const client = makeRemoteClient({ baseUrl: capability.endpoint, actor: capability.actor });
    if (name === SessionToolName.candidateFinalize) {
      if (!capabilityAllows(capability, name)) {
        return yield* Effect.fail({ _tag: "McpForbidden", reason: `Grant does not permit ${name}` } as const);
      }
      const forwarded = yield* forwardCandidateFinalize(capability, { ...request, params: toolArguments });
      return { jsonrpc: "2.0" as const, id: request.id, result: forwarded };
    }
    const projectId = yield* projectIdFrom(toolArguments);
    if (!capabilityAllows(capability, name, projectId)) {
      return yield* Effect.fail({ _tag: "McpForbidden", reason: `Grant does not permit ${name} for Project` } as const);
    }
    if (
      name === SessionToolName.projectRead ||
      name === SessionToolName.workRead ||
      name === SessionToolName.evidenceRead ||
      name === SessionToolName.proposalRead
    ) {
      const observation = yield* client.observe(projectId);
      return {
        jsonrpc: "2.0" as const,
        id: request.id,
        result: observationFor(observation, name, toolArguments),
      };
    }
    const parsed = yield* parseToolCommand(
      toolArguments,
      name === SessionToolName.workerStart ? "StartWorkerSession" : "CancelSession",
    );
    const result = yield* client.dispatch(
      parsed.projectId,
      parsed.commandId,
      parsed.expectedRevision,
      parsed.command,
    );
    return { jsonrpc: "2.0" as const, id: request.id, result };
  });

export interface McpStdio {
  readonly input: AsyncIterable<string>;
  readonly write: (line: string) => Effect.Effect<void, never>;
}

export const runMcp = (
  capability: SessionCapabilityFile,
  stdio: McpStdio,
): Effect.Effect<void, never> =>
  Effect.ignore(
    Effect.tryPromise({
      try: async () => {
        for await (const line of stdio.input) {
          if (line.trim().length === 0) continue;
          let requestInput: unknown;
          try {
            requestInput = JSON.parse(line) as unknown;
          } catch (error) {
            await Effect.runPromise(stdio.write(JSON.stringify({
              jsonrpc: "2.0",
              id: undefined,
              error: { code: -32700, message: errorReason(error) },
            })));
            continue;
          }
          const response = await Effect.runPromise(
            handleMcpRequest(capability, requestInput).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  jsonrpc: "2.0" as const,
                  id: undefined,
                  error: { code: -32602, message: errorReason(error) },
                }),
              ),
            ),
          );
          await Effect.runPromise(stdio.write(JSON.stringify(response)));
        }
      },
      catch: () => undefined,
    }),
  );


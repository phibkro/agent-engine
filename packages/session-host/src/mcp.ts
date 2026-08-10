import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import type { SessionId, WorkId } from "@work-engine/protocol";
import { decodeUnknownStrict } from "@work-engine/protocol";
import { SessionCredentialManager } from "./security.ts";
import type { CandidateFinalizeRequest, FrozenCandidate } from "./custody.ts";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const McpCallSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({
    name: Schema.NonEmptyString,
    arguments: Schema.optionalKey(JsonObjectSchema),
  }),
});
const McpListSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.Literal("tools/list"),
});
export const SessionMcpRequestSchema = Schema.Union([McpCallSchema, McpListSchema]);
export type SessionMcpRequest = typeof SessionMcpRequestSchema.Type;

export const SESSION_MCP_TOOLS = [
  "project.observe",
  "session.status",
  "session.start",
  "candidate.finalize",
] as const;
export type SessionMcpTool = (typeof SESSION_MCP_TOOLS)[number];

export type McpFailure =
  | { readonly _tag: "McpDecodeFailure"; readonly reason: string }
  | { readonly _tag: "McpCapabilityInvalid"; readonly sessionId: SessionId }
  | { readonly _tag: "McpToolUnavailable"; readonly name: string }
  | { readonly _tag: "McpAuthorityDenied"; readonly name: string };

export class McpAuthorityError extends Error {
  readonly name = "McpAuthorityError";
  constructor(readonly failure: McpFailure) {
    super(failureReason(failure));
  }
}

export interface SessionMcpHandlers {
  readonly observeProject: (sessionId: SessionId, arguments_: Record<string, unknown>) => Promise<unknown>;
  readonly sessionStatus: (sessionId: SessionId) => Promise<unknown>;
  readonly startSession: (sessionId: SessionId, workId: WorkId) => Promise<unknown>;
  readonly finalizeCandidate: (request: CandidateFinalizeRequest) => Promise<FrozenCandidate | unknown>;
}

export interface SessionMcpServerOptions {
  readonly sessionId: SessionId;
  readonly capabilityFile: string;
  readonly credentials: SessionCredentialManager;
  readonly handlers: SessionMcpHandlers;
}

/**
 * JSON-RPC MCP projection. Its tool table is deliberately closed: approval,
 * rejection, and Merge are not registered and are denied even if requested.
 */
export class SessionMcpServer {
  constructor(private readonly options: SessionMcpServerOptions) {}

  async handle(request: unknown): Promise<unknown> {
    let decoded: SessionMcpRequest;
    try {
      decoded = decodeUnknownStrict(SessionMcpRequestSchema, request);
    } catch (error) {
      throw new McpAuthorityError({ _tag: "McpDecodeFailure", reason: errorMessage(error) });
    }
    const token = await this.readCapabilityToken();
    if (!(await this.options.credentials.validateCapability(this.options.sessionId, token))) {
      throw new McpAuthorityError({ _tag: "McpCapabilityInvalid", sessionId: this.options.sessionId });
    }
    if (decoded.method === "tools/list") return this.list(decoded.id);
    const name = decoded.params.name;
    if (!isAllowedTool(name)) throw new McpAuthorityError({ _tag: "McpAuthorityDenied", name });
    const args = decoded.params.arguments ?? {};
    const result = await this.call(name, args);
    return { jsonrpc: "2.0", id: decoded.id, result: { content: [{ type: "json", json: result }] } };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return response({ error: "method not allowed" }, 405);
    try {
      const result = await this.handle((await request.json()) as unknown);
      return response(result, 200);
    } catch (error) {
      if (!(error instanceof McpAuthorityError)) return response({ error: "MCP unavailable" }, 503);
      const status = error.failure._tag === "McpCapabilityInvalid" || error.failure._tag === "McpAuthorityDenied" ? 403 : 400;
      return response({ error: error.failure }, status);
    }
  }

  private list(id: string | number): unknown {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: SESSION_MCP_TOOLS.map((name) => ({ name, description: description(name) })),
      },
    };
  }

  private async call(name: SessionMcpTool, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "project.observe":
        return this.options.handlers.observeProject(this.options.sessionId, args);
      case "session.status":
        return this.options.handlers.sessionStatus(this.options.sessionId);
      case "session.start": {
        const workId = args.workId;
        if (typeof workId !== "string") throw new McpAuthorityError({ _tag: "McpDecodeFailure", reason: "session.start requires workId" });
        return this.options.handlers.startSession(this.options.sessionId, workId as WorkId);
      }
      case "candidate.finalize": {
        const reason = args.reason;
        if (typeof reason !== "string" || reason.length === 0) throw new McpAuthorityError({ _tag: "McpDecodeFailure", reason: "candidate.finalize requires reason" });
        return this.options.handlers.finalizeCandidate({ sessionId: this.options.sessionId, reason });
      }
    }
  }

  private async readCapabilityToken(): Promise<string> {
    try {
      return (await readFile(this.options.capabilityFile, "utf8")).trim();
    } catch (error) {
      throw new McpAuthorityError({ _tag: "McpCapabilityInvalid", sessionId: this.options.sessionId });
    }
  }
}

export const isAllowedTool = (name: string): name is SessionMcpTool =>
  (SESSION_MCP_TOOLS as readonly string[]).includes(name);

export const parseSessionMcpArgs = (argv: readonly string[]): SessionId => {
  if (argv[0] !== "mcp" || argv[1] !== "--session" || argv[2] === undefined || argv[3] !== undefined) throw new Error("expected: work mcp --session <session-id>");
  return argv[2] as SessionId;
};

const description = (name: SessionMcpTool): string => {
  switch (name) {
    case "project.observe":
      return "Read the Project projection within this Session scope.";
    case "session.status":
      return "Read this Session lifecycle status.";
    case "session.start":
      return "Request one scoped worker Session through Project authority.";
    case "candidate.finalize":
      return "Freeze the candidate after the worker exits.";
  }
};
const failureReason = (failure: McpFailure): string => {
  switch (failure._tag) {
    case "McpDecodeFailure":
      return failure.reason;
    case "McpCapabilityInvalid":
      return `invalid Session capability: ${failure.sessionId}`;
    case "McpToolUnavailable":
      return `MCP tool unavailable: ${failure.name}`;
    case "McpAuthorityDenied":
      return `MCP authority denied: ${failure.name}`;
  }
};
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const response = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

import * as Schema from "effect/Schema";
import type { SessionId } from "@work-engine/protocol";
import { decodeUnknownStrict } from "@work-engine/protocol";
import type { SessionCredentialManager } from "./security.ts";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

export const MODEL_PROVIDER = "@cf/openai/gpt-oss-120b" as const;
export const MODEL_ALIASES = ["work-engine/gpt-oss-120b", "gpt-oss-120b", MODEL_PROVIDER] as const;
export const MODEL_CONTEXT_WINDOW = 128_000;
export const MODEL_RESPONSE_LIMIT = 8_192;
export const DEFAULT_SESSION_OUTPUT_BUDGET = 32_000;

const ChatMessageSchema = Schema.Struct({
  role: Schema.NonEmptyString,
  content: Schema.Union([Schema.String, Schema.Null, Schema.Array(Schema.Unknown)]),
  name: optional(Schema.NonEmptyString),
  tool_calls: optional(Schema.Array(Schema.Unknown)),
  tool_call_id: optional(Schema.NonEmptyString),
});
export type ChatMessage = typeof ChatMessageSchema.Type;

export const ModelChatRequestSchema = Schema.Struct({
  model: Schema.NonEmptyString,
  messages: Schema.Array(ChatMessageSchema),
  max_tokens: optional(Schema.Natural),
  max_completion_tokens: optional(Schema.Natural),
  temperature: optional(Schema.Number),
  top_p: optional(Schema.Number),
  tools: optional(Schema.Array(Schema.Unknown)),
  tool_choice: optional(Schema.Unknown),
  stream: optional(Schema.Boolean),
});
export type ModelChatRequest = typeof ModelChatRequestSchema.Type;

const ChatChoiceSchema = Schema.Struct({
  index: Schema.Natural,
  message: Schema.Unknown,
  finish_reason: optional(Schema.Union([Schema.String, Schema.Null])),
});
const UsageSchema = Schema.Struct({
  prompt_tokens: Schema.Natural,
  completion_tokens: Schema.Natural,
  total_tokens: Schema.Natural,
});
export const ModelChatResponseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  object: Schema.NonEmptyString,
  created: Schema.Natural,
  model: Schema.NonEmptyString,
  choices: Schema.Array(ChatChoiceSchema),
  usage: optional(UsageSchema),
});
export type ModelChatResponse = typeof ModelChatResponseSchema.Type;

export interface ModelProvider {
  complete(request: ModelChatRequest, providerModel: typeof MODEL_PROVIDER): Promise<unknown>;
}

export interface SessionUsage {
  readonly sessionId: SessionId;
  readonly outputBudget: number;
  readonly reservedOutputTokens: number;
  readonly completedOutputTokens: number;
  readonly calls: number;
}

export type ModelProxyFailure =
  | { readonly _tag: "ModelTokenInvalid"; readonly sessionId: SessionId }
  | { readonly _tag: "ModelNotAllowed"; readonly model: string }
  | {
      readonly _tag: "ModelBudgetExceeded";
      readonly sessionId: SessionId;
      readonly remaining: number;
    }
  | { readonly _tag: "ModelUnavailable"; readonly reason: string }
  | { readonly _tag: "ModelDecodeFailure"; readonly reason: string };

export class ModelProxyError extends Error {
  readonly name = "ModelProxyError";
  constructor(readonly failure: ModelProxyFailure) {
    super(failureReason(failure));
  }
}

export interface ModelProxyOptions {
  readonly credentials: SessionCredentialManager;
  readonly provider: ModelProvider;
  readonly outputBudget?: number;
  readonly routePrefix?: string;
}

/**
 * Loopback-only OpenAI-compatible adapter. It authenticates the Session model
 * token, reserves output budget before provider execution, and forwards one
 * fixed Workers AI model—never a caller-selected provider or credential.
 */
export class ModelProxy {
  private readonly budgets = new Map<SessionId, SessionUsage>();
  private readonly outputBudget: number;
  private readonly routePrefix: string;

  constructor(private readonly options: ModelProxyOptions) {
    this.outputBudget = options.outputBudget ?? DEFAULT_SESSION_OUTPUT_BUDGET;
    this.routePrefix = options.routePrefix ?? "/v1/sessions";
  }

  async registerSession(sessionId: SessionId, outputBudget = this.outputBudget): Promise<void> {
    this.budgets.set(sessionId, {
      sessionId,
      outputBudget,
      reservedOutputTokens: 0,
      completedOutputTokens: 0,
      calls: 0,
    });
  }

  usage(sessionId: SessionId): SessionUsage | undefined {
    return this.budgets.get(sessionId);
  }

  async revokeSession(sessionId: SessionId): Promise<void> {
    this.budgets.delete(sessionId);
  }

  async complete(sessionId: SessionId, token: string, input: unknown): Promise<ModelChatResponse> {
    if (!(await this.options.credentials.validateModel(sessionId, token))) {
      throw new ModelProxyError({ _tag: "ModelTokenInvalid", sessionId });
    }
    const request = decodeModelRequest(input);
    if (!MODEL_ALIASES.includes(request.model as (typeof MODEL_ALIASES)[number])) {
      throw new ModelProxyError({ _tag: "ModelNotAllowed", model: request.model });
    }
    if (request.stream === true)
      throw new ModelProxyError({ _tag: "ModelUnavailable", reason: "streaming is not enabled" });
    const requested = request.max_completion_tokens ?? request.max_tokens ?? MODEL_RESPONSE_LIMIT;
    if (requested > MODEL_RESPONSE_LIMIT)
      throw new ModelProxyError({
        _tag: "ModelBudgetExceeded",
        sessionId,
        remaining: MODEL_RESPONSE_LIMIT,
      });
    const budget = this.budgets.get(sessionId);
    if (budget === undefined) throw new ModelProxyError({ _tag: "ModelTokenInvalid", sessionId });
    const remaining = budget.outputBudget - budget.reservedOutputTokens;
    if (requested > remaining)
      throw new ModelProxyError({ _tag: "ModelBudgetExceeded", sessionId, remaining });
    const reserved: SessionUsage = {
      ...budget,
      reservedOutputTokens: budget.reservedOutputTokens + requested,
      calls: budget.calls + 1,
    };
    this.budgets.set(sessionId, reserved);
    try {
      const response = await this.options.provider.complete(
        { ...request, max_tokens: requested },
        MODEL_PROVIDER,
      );
      const decoded = decodeModelResponse(response);
      const completed = decoded.usage?.completion_tokens ?? requested;
      if (completed > requested || completed > remaining)
        throw new ModelProxyError({
          _tag: "ModelUnavailable",
          reason: "provider exceeded the reserved output budget",
        });
      this.budgets.set(sessionId, {
        ...reserved,
        completedOutputTokens: reserved.completedOutputTokens + completed,
      });
      return decoded;
    } catch (error) {
      this.budgets.set(sessionId, budget);
      if (error instanceof ModelProxyError) throw error;
      throw new ModelProxyError({ _tag: "ModelUnavailable", reason: errorMessage(error) });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const token = bearerToken(request.headers.get("authorization"));
      if (token === undefined) return jsonResponse({ error: "model token required" }, 401);
      const sessionId = await this.options.credentials.sessionForModelToken(token);
      if (sessionId === undefined) return jsonResponse({ error: "model token invalid" }, 401);
      return jsonResponse(
        {
          object: "list",
          data: [{ id: "gpt-oss-120b", object: "model", owned_by: "work-engine" }],
        },
        200,
      );
    }
    const match = /^\/v1\/sessions\/([^/]+)\/model\/chat\/completions$/u.exec(url.pathname);
    if (request.method !== "POST" || match === null || !url.pathname.startsWith(this.routePrefix))
      return jsonResponse({ error: "not found" }, 404);
    const sessionId = match[1] as SessionId | undefined;
    if (sessionId === undefined) return jsonResponse({ error: "session not found" }, 404);
    const token = bearerToken(request.headers.get("authorization"));
    if (token === undefined) return jsonResponse({ error: "model token required" }, 401);
    try {
      const input = (await request.json()) as unknown;
      const response = await this.complete(sessionId, token, input);
      return jsonResponse(response, 200);
    } catch (error) {
      if (!(error instanceof ModelProxyError))
        return jsonResponse({ error: "model unavailable" }, 503);
      return jsonResponse({ error: error.failure }, statusForFailure(error.failure));
    }
  }
}

const decodeModelRequest = (input: unknown): ModelChatRequest => {
  try {
    return decodeUnknownStrict(ModelChatRequestSchema, input);
  } catch (error) {
    throw new ModelProxyError({ _tag: "ModelDecodeFailure", reason: errorMessage(error) });
  }
};

const decodeModelResponse = (input: unknown): ModelChatResponse => {
  try {
    return decodeUnknownStrict(ModelChatResponseSchema, input);
  } catch (error) {
    throw new ModelProxyError({ _tag: "ModelDecodeFailure", reason: errorMessage(error) });
  }
};

const bearerToken = (value: string | null): string | undefined => {
  if (value === null || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const statusForFailure = (failure: ModelProxyFailure): number => {
  switch (failure._tag) {
    case "ModelTokenInvalid":
      return 401;
    case "ModelNotAllowed":
      return 400;
    case "ModelBudgetExceeded":
      return 429;
    case "ModelUnavailable":
      return 503;
    case "ModelDecodeFailure":
      return 400;
  }
};

const failureReason = (failure: ModelProxyFailure): string => {
  switch (failure._tag) {
    case "ModelTokenInvalid":
      return `invalid model token for ${failure.sessionId}`;
    case "ModelNotAllowed":
      return `model is not allowed: ${failure.model}`;
    case "ModelBudgetExceeded":
      return `model output budget exceeded for ${failure.sessionId}; remaining ${failure.remaining}`;
    case "ModelUnavailable":
      return failure.reason;
    case "ModelDecodeFailure":
      return failure.reason;
  }
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AuthenticatedActorSchema,
  CommandEnvelopeSchema,
  CreateProjectRequestSchema,
  GrantIdSchema,
  ProjectIdSchema,
  Sha256DigestSchema,
  type AuthenticatedActor,
  type CommandEnvelope,
  type ProjectId,
} from "@work-engine/protocol";
import {
  AttachResolutionRequestSchema,
  ApiFailureSchema,
  WorkEngineHeader,
} from "@work-engine/runtime";
import {
  DurableObjectProjectAuthority,
  observationReferencesDigest,
  R2ArtifactStore,
} from "@work-engine/cloudflare";
import type { ControlPlaneEnv } from "./env.ts";
import { PROJECT_ID_HEADER } from "./env.ts";
import { ModelChatRequestSchema, type ModelChatRequest } from "./model.ts";

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const json = (value: unknown): string => JSON.stringify(value);

const failure = (code: string, reason: string, status: number): Response =>
  new Response(json(Schema.encodeSync(ApiFailureSchema)({ _tag: "ApiFailure", code, reason })), {
    status,
    headers: { "content-type": "application/json" },
  });

const body = async (request: Request): Promise<unknown> => {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("request body is not valid JSON");
  }
};

const grants = (request: Request): AuthenticatedActor["presentedGrants"] => {
  const query = new URL(request.url).searchParams.get("grantIds");
  const raw = query ?? request.headers.get(WorkEngineHeader.grantIds) ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => decode(GrantIdSchema, value));
};

const actor = (
  request: Request,
  kind: AuthenticatedActor["kind"] = "operator",
): AuthenticatedActor => {
  const actorId = request.headers.get(WorkEngineHeader.actorId);
  if (actorId === null || actorId.length === 0)
    throw new Error("X-Work-Engine-Actor-Id is required");
  return decode(AuthenticatedActorSchema, {
    _tag: "AuthenticatedActor",
    actorId,
    kind,
    presentedGrants: grants(request),
  });
};

const projectId = (value: string): ProjectId => decode(ProjectIdSchema, decodeURIComponent(value));

const authHeaders = (env: ControlPlaneEnv): HeadersInit => ({
  [WorkEngineHeader.accessClientId]: env.ACCESS_CLIENT_ID,
  [WorkEngineHeader.accessClientSecret]: env.ACCESS_CLIENT_SECRET,
});

const authenticated = (request: Request, env: ControlPlaneEnv): Response | undefined => {
  const id = request.headers.get(WorkEngineHeader.accessClientId);
  const secret = request.headers.get(WorkEngineHeader.accessClientSecret);
  if (
    id === null ||
    secret === null ||
    id !== env.ACCESS_CLIENT_ID ||
    secret !== env.ACCESS_CLIENT_SECRET
  ) {
    return failure("unauthorized", "Cloudflare Access service-token authentication failed", 401);
  }
};

const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const mapError = (cause: unknown): Response => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = String((cause as { readonly _tag: unknown })._tag);
    if (tag === "AuthorityRejected") {
      return new Response(json((cause as { readonly result: unknown }).result), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    if (tag === "DecodeFailure")
      return failure("decode_failure", String((cause as { readonly reason: unknown }).reason), 502);
    if (tag === "Unauthorized")
      return failure("unauthorized", String((cause as { readonly reason: unknown }).reason), 403);
  }
  return failure(
    "dependency_unavailable",
    cause instanceof Error ? cause.message : "Cloudflare dependency unavailable",
    503,
  );
};

export const handleRequest = async (
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const denied = authenticated(request, env);
  if (denied !== undefined) return denied;
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/v1/projects") {
      const input = decode(CreateProjectRequestSchema, await body(request));
      const subject = actor(request, "operator");
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const result = await run(authority.create(input));
      return new Response(json(result), { headers: { "content-type": "application/json" } });
    }

    const commandMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/commands$/u);
    if (request.method === "POST" && commandMatch !== null) {
      const input = decode(CommandEnvelopeSchema, await body(request));
      const subject = actor(request, input.actor.kind);
      if (input.actor.actorId !== subject.actorId)
        throw new Error("command actor does not match Access actor");
      const command: CommandEnvelope = { ...input, actor: subject };
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const result = await run(authority.dispatch(command));
      return new Response(json(result), {
        status: result._tag === "Rejected" ? 409 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    const observationMatch = url.pathname.match(
      /^\/v1\/projects\/([^/]+)\/observations\/current$/u,
    );
    if (request.method === "GET" && observationMatch !== null) {
      const id = projectId(observationMatch[1]!);
      const subject = actor(request, "operator");
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const result = await run(authority.observe(id));
      ctx.waitUntil(Promise.resolve());
      return new Response(json(result), { headers: { "content-type": "application/json" } });
    }

    const artifactMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/artifacts\/(.+)$/u);
    if (request.method === "GET" && artifactMatch !== null) {
      const id = projectId(artifactMatch[1]!);
      const digest = decode(Sha256DigestSchema, decodeURIComponent(artifactMatch[2]!));
      const subject = actor(request, "operator");
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const observation = await run(authority.observe(id));
      if (!observationReferencesDigest(observation, digest))
        return failure(
          "unauthorized",
          "artifact is not referenced by an accepted Project event",
          403,
        );
      const artifacts = new R2ArtifactStore(env.ARTIFACTS);
      const receipt = await run(artifacts.head(digest));
      const bytes = await run(artifacts.get(digest));
      return new Response(bytes, {
        headers: {
          "content-type": receipt.mediaType,
          "content-length": String(receipt.bytes),
          etag: `"${digest.slice("sha256:".length)}"`,
        },
      });
    }

    const attachPostMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/attach-resolutions$/u);
    if (request.method === "POST" && attachPostMatch !== null) {
      const id = projectId(attachPostMatch[1]!);
      const input = decode(AttachResolutionRequestSchema, await body(request));
      const subject = actor(request, "operator");
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const result = await run(authority.attach(id, input));
      return new Response(json(result), { headers: { "content-type": "application/json" } });
    }

    const attachGetMatch = url.pathname.match(
      /^\/v1\/projects\/([^/]+)\/attach-resolutions\/([^/]+)$/u,
    );
    if (request.method === "GET" && attachGetMatch !== null) {
      const id = projectId(attachGetMatch[1]!);
      const subject = actor(request, "operator");
      const authority = new DurableObjectProjectAuthority(env.PROJECTS, subject, authHeaders(env));
      const result = await run(authority.attachQuery(id, decodeURIComponent(attachGetMatch[2]!)));
      return new Response(json(result), { headers: { "content-type": "application/json" } });
    }

    const modelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/model\/chat\/completions$/u);
    if (request.method === "POST" && modelMatch !== null)
      return await handleModel(request, env, modelMatch[1]!);
    return failure("not_found", "Worker route does not exist", 404);
  } catch (cause) {
    if (cause instanceof Error && /required|valid|decode|does not match/iu.test(cause.message))
      return failure("decode_failure", cause.message, 400);
    return mapError(cause);
  }
};

const handleModel = async (
  request: Request,
  env: ControlPlaneEnv,
  sessionId: string,
): Promise<Response> => {
  const input: ModelChatRequest = decode(ModelChatRequestSchema, await body(request));
  if (input.stream === true)
    return failure("decode_failure", "streaming model responses are not part of tracer 0001", 400);
  const id = projectId(request.headers.get(PROJECT_ID_HEADER) ?? "");
  const subject = actor(request, "worker_session");
  const requestedTokens = input.max_tokens ?? 8192;
  const stub = env.PROJECTS.getByName(id);
  const authorization = await stub.fetch("https://project/v1/model/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WorkEngineHeader.actorId]: subject.actorId,
      [WorkEngineHeader.grantIds]: subject.presentedGrants.join(","),
      ...authHeaders(env),
    },
    body: json({ _tag: "ModelAuthorizationRequest", sessionId, requestedTokens }),
  });
  if (!authorization.ok)
    return failure("unauthorized", "Session model authorization failed", authorization.status);
  if (env.AI === undefined)
    return failure("model_unavailable", "Workers AI binding is unavailable", 503);
  const output: unknown = await env.AI.run("@cf/openai/gpt-oss-120b", {
    messages: input.messages,
    max_tokens: requestedTokens,
    stream: false,
  } as never);
  return new Response(json(output), { headers: { "content-type": "application/json" } });
};

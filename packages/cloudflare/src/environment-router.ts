import * as Schema from "effect/Schema";
import {
  EnvironmentCheckpointedResponseSchema,
  EnvironmentCommandRequestSchema,
  EnvironmentCreatedResponseSchema,
  EnvironmentDestroyedResponseSchema,
  EnvironmentFailureSchema,
  EnvironmentInspectedResponseSchema,
  EnvironmentRateLimitedResponseSchema,
  EnvironmentRecoveredResponseSchema,
  EnvironmentIdSchema,
  decodeUnknownStrict,
  type EnvironmentCommandRequest,
  type EnvironmentFailure,
} from "@work-engine/protocol";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { InvalidRequestError, ProviderUnavailableError, UnauthorizedError } from "./errors.ts";

const ENVIRONMENT_PATH = /^\/v1\/environments\/([^/]+)(\/connect(?:\/.*)?)?$/u;
const EnvironmentCommandJsonSchema = Schema.fromJsonString(EnvironmentCommandRequestSchema);
const EnvironmentFailureJsonSchema = Schema.fromJsonString(EnvironmentFailureSchema);
const EnvironmentInspectedResponseJsonSchema = Schema.fromJsonString(
  EnvironmentInspectedResponseSchema,
);
const EnvironmentCreatedResponseJsonSchema = Schema.fromJsonString(
  EnvironmentCreatedResponseSchema,
);
const EnvironmentRecoveredResponseJsonSchema = Schema.fromJsonString(
  EnvironmentRecoveredResponseSchema,
);
const EnvironmentDestroyedResponseJsonSchema = Schema.fromJsonString(
  EnvironmentDestroyedResponseSchema,
);
const EnvironmentCheckpointedResponseJsonSchema = Schema.fromJsonString(
  EnvironmentCheckpointedResponseSchema,
);
const EnvironmentSourceIdentitySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\S+$/u)),
  Schema.check(
    Schema.makeFilter(
      (value) => value.toLowerCase() !== "unknown" || "source identity must be verified",
    ),
  ),
);

type EnvironmentResponseSchema =
  | typeof EnvironmentInspectedResponseSchema
  | typeof EnvironmentCreatedResponseSchema
  | typeof EnvironmentRecoveredResponseSchema
  | typeof EnvironmentDestroyedResponseSchema
  | typeof EnvironmentCheckpointedResponseSchema;
type EnvironmentResponseJsonSchema =
  | typeof EnvironmentInspectedResponseJsonSchema
  | typeof EnvironmentCreatedResponseJsonSchema
  | typeof EnvironmentRecoveredResponseJsonSchema
  | typeof EnvironmentDestroyedResponseJsonSchema
  | typeof EnvironmentCheckpointedResponseJsonSchema;

const responseJsonSchemaFor = (
  schema: EnvironmentResponseSchema,
): EnvironmentResponseJsonSchema => {
  switch (schema) {
    case EnvironmentInspectedResponseSchema:
      return EnvironmentInspectedResponseJsonSchema;
    case EnvironmentCreatedResponseSchema:
      return EnvironmentCreatedResponseJsonSchema;
    case EnvironmentRecoveredResponseSchema:
      return EnvironmentRecoveredResponseJsonSchema;
    case EnvironmentDestroyedResponseSchema:
      return EnvironmentDestroyedResponseJsonSchema;
    case EnvironmentCheckpointedResponseSchema:
      return EnvironmentCheckpointedResponseJsonSchema;
    default:
      throw new ProviderUnavailableError(
        "Environment Durable Object",
        "returned an unsupported response schema",
      );
  }
};

const jsonResponse = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  init?: ResponseInit,
): Response => Response.json(decodeUnknownStrict(schema, value), init);

const statusForFailure = (tag: EnvironmentFailure["_tag"]): number => {
  switch (tag) {
    case "Unauthorized":
      return 403;
    case "InvalidRequest":
      return 400;
    case "ProviderUnavailable":
      return 503;
    case "EnvironmentRuntimeFailure":
    case "EnvironmentRouterFailure":
      return 500;
  }
};

const redactedReason = (tag: EnvironmentFailure["_tag"]): string => {
  switch (tag) {
    case "Unauthorized":
      return "Environment operation is unauthorized";
    case "InvalidRequest":
      return "Environment request is invalid";
    case "ProviderUnavailable":
      return "Environment provider is unavailable";
    case "EnvironmentRuntimeFailure":
      return "Environment runtime failed";
    case "EnvironmentRouterFailure":
      return "Environment routing failed";
  }
};

const redactedFailure = (tag: EnvironmentFailure["_tag"]): EnvironmentFailure => {
  switch (tag) {
    case "Unauthorized":
      return { _tag: "Unauthorized", reason: redactedReason(tag) };
    case "InvalidRequest":
      return { _tag: "InvalidRequest", reason: redactedReason(tag) };
    case "ProviderUnavailable":
      return { _tag: "ProviderUnavailable", reason: redactedReason(tag) };
    case "EnvironmentRuntimeFailure":
      return { _tag: "EnvironmentRuntimeFailure", reason: redactedReason(tag) };
    case "EnvironmentRouterFailure":
      return { _tag: "EnvironmentRouterFailure", reason: redactedReason(tag) };
  }
};

const failureCause = (cause: unknown): EnvironmentFailure => {
  if (cause instanceof UnauthorizedError) return redactedFailure("Unauthorized");
  if (cause instanceof InvalidRequestError) return redactedFailure("InvalidRequest");
  if (cause instanceof ProviderUnavailableError) return redactedFailure("ProviderUnavailable");
  return redactedFailure("EnvironmentRouterFailure");
};

const failureResponse = (cause: unknown): Response => {
  const failure = failureCause(cause);
  return jsonResponse(EnvironmentFailureSchema, failure, {
    status: statusForFailure(failure._tag),
  });
};

const requireOperator = (request: Request, expected: string | undefined): void => {
  const authorization = request.headers.get("Authorization");
  if (expected === undefined || authorization !== `Bearer ${expected}`) {
    throw new UnauthorizedError("Environment operation requires operator authorization");
  }
};

const commandBody = (body: string): EnvironmentCommandRequest => {
  try {
    return decodeUnknownStrict(EnvironmentCommandJsonSchema, body);
  } catch {
    throw new InvalidRequestError("Environment command body is invalid");
  }
};

const responseSchemaFor = (command: EnvironmentCommandRequest): EnvironmentResponseSchema => {
  switch (command._tag) {
    case "CreateEnvironment":
      return EnvironmentCreatedResponseSchema;
    case "RecoverEnvironment":
      return EnvironmentRecoveredResponseSchema;
    case "DestroyEnvironment":
      return EnvironmentDestroyedResponseSchema;
    case "CheckpointEnvironment":
      return EnvironmentCheckpointedResponseSchema;
  }
};

const responseFor = async (
  response: Response,
  schema: EnvironmentResponseSchema,
): Promise<Response> => {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new ProviderUnavailableError("Environment Durable Object", "returned invalid JSON");
  }
  if (!response.ok) {
    let failure: EnvironmentFailure;
    try {
      failure = decodeUnknownStrict(EnvironmentFailureJsonSchema, body);
    } catch {
      throw new ProviderUnavailableError(
        "Environment Durable Object",
        "returned an invalid failure response",
      );
    }
    const redacted = redactedFailure(failure._tag);
    return jsonResponse(EnvironmentFailureSchema, redacted, {
      status: statusForFailure(redacted._tag),
    });
  }
  try {
    const decoded = decodeUnknownStrict(responseJsonSchemaFor(schema), body);
    return jsonResponse(schema, decoded, { status: response.status });
  } catch {
    throw new ProviderUnavailableError(
      "Environment Durable Object",
      "returned an invalid success response",
    );
  }
};

export class EnvironmentRouter {
  readonly #env: CloudflareRuntimeEnv;

  constructor(env: CloudflareRuntimeEnv) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const match = ENVIRONMENT_PATH.exec(new URL(request.url).pathname);
      if (match === null) throw new InvalidRequestError("Environment route does not exist");
      let environmentId: string;
      try {
        environmentId = decodeUnknownStrict(EnvironmentIdSchema, match[1]);
      } catch {
        throw new InvalidRequestError("Environment route identifier is invalid");
      }
      const connect = match[2] !== undefined;
      if (!connect) requireOperator(request, this.#env.CLOUD_TASK_AUTH_TOKEN);

      const namespace = this.#env.ENVIRONMENT;
      if (namespace === undefined) {
        throw new ProviderUnavailableError("Environment Durable Object namespace");
      }
      const secret = this.#env.ENVIRONMENT_ROUTER_SECRET;
      if (secret === undefined) {
        throw new ProviderUnavailableError("Environment router secret");
      }

      let body: string | undefined;
      let responseSchema: EnvironmentResponseSchema = EnvironmentInspectedResponseSchema;
      if (!connect && request.method !== "GET") {
        const command = commandBody(await request.text());
        if (command.environmentId !== environmentId) {
          throw new InvalidRequestError("Route and command Environment identifiers differ");
        }
        body = Schema.encodeSync(EnvironmentCommandJsonSchema, {
          onExcessProperty: "error",
        })(command);
        responseSchema = responseSchemaFor(command);
      }

      if (connect) {
        let source: string;
        try {
          source = decodeUnknownStrict(
            EnvironmentSourceIdentitySchema,
            request.headers.get("CF-Connecting-IP"),
          );
        } catch {
          throw new InvalidRequestError("Environment connection source identity is required");
        }
        const limiters = [
          this.#env.ENVIRONMENT_HTTP_RATE,
          ...(request.headers.get("Upgrade")?.toLowerCase() === "websocket"
            ? [this.#env.ENVIRONMENT_CONNECT_RATE]
            : []),
        ];
        const decisions = await Promise.all(
          limiters
            .filter((limiter): limiter is RateLimit => limiter !== undefined)
            .map((limiter) => limiter.limit({ key: `${source}:${environmentId}` })),
        );
        if (decisions.some((decision) => !decision.success)) {
          return jsonResponse(
            EnvironmentRateLimitedResponseSchema,
            { _tag: "EnvironmentRateLimited" },
            { status: 429 },
          );
        }
      }

      const headers = new Headers(request.headers);
      headers.delete("Authorization");
      headers.set("X-Environment-Internal", secret);
      if (body !== undefined) headers.set("content-type", "application/json");
      const forwarded = new Request(request, {
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
      const object = namespace.get(namespace.idFromName(environmentId));
      const response = await object.fetch(forwarded);
      return connect ? response : await responseFor(response, responseSchema);
    } catch (cause) {
      return failureResponse(cause);
    }
  }
}

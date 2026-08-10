import { Schema } from "effect";
import {
  EnvironmentCommandRequestSchema,
  EnvironmentIdSchema,
  decodeUnknownStrict,
  type EnvironmentCommandRequest,
} from "@work-engine/protocol";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { InvalidRequestError, UnauthorizedError } from "./errors.ts";

const ENVIRONMENT_PATH = /^\/v1\/environments\/([^/]+)(\/connect(?:\/.*)?)?$/u;

const failureResponse = (cause: unknown): Response => {
  if (cause instanceof UnauthorizedError) {
    return Response.json({ _tag: cause._tag, reason: cause.message }, { status: 403 });
  }
  if (cause instanceof InvalidRequestError) {
    return Response.json({ _tag: cause._tag, reason: cause.message }, { status: 400 });
  }
  return Response.json(
    {
      _tag: "EnvironmentRouterFailure",
      reason: "Environment routing failed",
    },
    { status: 500 },
  );
};

const requireOperator = (request: Request, expected: string | undefined): void => {
  const authorization = request.headers.get("Authorization");
  if (expected === undefined || authorization !== `Bearer ${expected}`) {
    throw new UnauthorizedError("Environment operation requires operator authorization");
  }
};

const commandBody = (body: string): EnvironmentCommandRequest => {
  let value: unknown;
  try {
    value = decodeUnknownStrict(Schema.UnknownFromJsonString, body);
  } catch {
    throw new InvalidRequestError("Environment command body must be JSON");
  }
  try {
    return decodeUnknownStrict(EnvironmentCommandRequestSchema, value);
  } catch {
    throw new InvalidRequestError("Environment command body is invalid");
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
      const secret = this.#env.ENVIRONMENT_ROUTER_SECRET;
      if (namespace === undefined || secret === undefined) {
        throw new Error("Environment routing bindings are incomplete");
      }
      let body: string | undefined;
      if (!connect && request.method !== "GET") {
        const rawBody = await request.text();
        const command = commandBody(rawBody);
        if (command.environmentId !== environmentId) {
          throw new InvalidRequestError("Route and command Environment identifiers differ");
        }
        body = JSON.stringify(command);
      }

      if (connect) {
        const source = request.headers.get("CF-Connecting-IP") ?? "unknown";
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
          return Response.json({ _tag: "EnvironmentRateLimited" }, { status: 429 });
        }
      }

      const headers = new Headers(request.headers);
      headers.set("X-Environment-Internal", secret);
      const forwarded = new Request(request, {
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
      const object = namespace.get(namespace.idFromName(environmentId));
      return object.fetch(forwarded);
    } catch (cause) {
      return failureResponse(cause);
    }
  }
}

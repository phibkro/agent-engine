import { WorkflowEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { SessionHostWireResponseSchema } from "@work-engine/runtime";
import type { CloudflareRuntimeEnv } from "./env.ts";
import { OutboxMessageSchema, type OutboxMessage } from "./schemas.ts";

const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const json = (value: unknown): string => JSON.stringify(value);

const requestHost = async (
  env: CloudflareRuntimeEnv,
  path: string,
  payload: unknown,
): Promise<unknown> => {
  if (env.SESSION_HOST === undefined) throw new Error("Session host binding is unavailable");
  const response = await env.SESSION_HOST.fetch(`https://session-host${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.ACCESS_CLIENT_ID === undefined ? {} : { "CF-Access-Client-Id": env.ACCESS_CLIENT_ID }),
      ...(env.ACCESS_CLIENT_SECRET === undefined ? {} : { "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET }),
    },
    body: json(payload),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`Session host returned ${response.status}`);
  return decode(SessionHostWireResponseSchema, body);
};

export const runSessionEffect = async (
  env: CloudflareRuntimeEnv,
  effect: OutboxMessage["effect"],
): Promise<unknown> => {
  if (effect._tag === "StartSessionEffect") {
    const ready = await requestHost(env, "/v1/session-host/workspaces/ensure-ready", effect.spec.workspaceLease);
    if (decode(SessionHostWireResponseSchema, ready)._tag === "SessionHostWireFailure") {
      throw new Error(decode(SessionHostWireResponseSchema, ready).reason);
    }
    return requestHost(env, "/v1/session-host/sessions/start", effect.spec);
  }
  return requestHost(env, "/v1/session-host/sessions/cancel", {
    _tag: "SessionHostCancelRequest",
    sessionId: effect.sessionId,
    reason: effect.reason,
  });
};

export class SessionWorkflow extends WorkflowEntrypoint<CloudflareRuntimeEnv, OutboxMessage> {
  async run(event: Readonly<WorkflowEvent<OutboxMessage>>, step: WorkflowStep): Promise<unknown> {
    const message = decode(OutboxMessageSchema, event.payload);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await step.do(`session-host-attempt-${attempt + 1}`, () => runSessionEffect(this.env, message.effect));
      } catch (cause) {
        lastError = cause;
        if (attempt < 2) await step.sleep(`session-host-backoff-${attempt + 1}`, 10_000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Session host dispatch exhausted");
  }
}
import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import {
  consumeSessionEffects,
  deadLetterSessionEffect,
  type OutboxMessage,
} from "@work-engine/cloudflare";
import type { ControlPlaneEnv } from "./env.ts";
import { handleRequest } from "./routes.ts";

export { ProjectDurableObject } from "@work-engine/cloudflare";
export { SessionWorkflow } from "@work-engine/cloudflare";
export { handleRequest } from "./routes.ts";
export type { ControlPlaneEnv } from "./env.ts";

export const fetch = (
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
): Promise<Response> => handleRequest(request, env, ctx);

export const queue = async (
  batch: MessageBatch<OutboxMessage>,
  env: ControlPlaneEnv,
): Promise<void> => {
  if (batch.queue.includes("dead-letter")) return deadLetterSessionEffect(batch, env);
  return consumeSessionEffects(batch, env);
};

export const scheduled = async (
  _controller: ScheduledController,
  env: ControlPlaneEnv,
): Promise<void> => {
  if (env.RECONCILIATION_QUEUE !== undefined) {
    await env.RECONCILIATION_QUEUE.send({ _tag: "ReconcileProjects" }, { contentType: "json" });
  }
};

export default { fetch, queue, scheduled };

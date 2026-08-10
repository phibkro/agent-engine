import * as Schema from "effect/Schema";
import { WorkEngineHeader } from "@work-engine/runtime";
import type { CloudflareRuntimeEnv } from "./env.ts";
import {
  OutboxMessageSchema,
  WorkflowStartReceiptRequestSchema,
  type OutboxMessage,
} from "./schemas.ts";

const json = (value: unknown): string => JSON.stringify(value);
const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

export const workflowInstanceId = (effectId: string): string => effectId;

const authorityHeaders = (env: CloudflareRuntimeEnv): HeadersInit => ({
  "content-type": "application/json",
  [WorkEngineHeader.actorId]: "system/session-workflow",
  [WorkEngineHeader.grantIds]: "",
  ...(env.ACCESS_CLIENT_ID === undefined
    ? {}
    : { [WorkEngineHeader.accessClientId]: env.ACCESS_CLIENT_ID }),
  ...(env.ACCESS_CLIENT_SECRET === undefined
    ? {}
    : { [WorkEngineHeader.accessClientSecret]: env.ACCESS_CLIENT_SECRET }),
});

const markWorkflowStarted = async (
  message: OutboxMessage,
  env: CloudflareRuntimeEnv,
): Promise<void> => {
  if (env.PROJECTS === undefined) throw new Error("Project authority binding is unavailable");
  const stub = env.PROJECTS.getByName(message.projectId);
  const payload = decode(WorkflowStartReceiptRequestSchema, {
    _tag: "WorkflowStartReceipt",
    effectId: message.effect.effectId,
  });
  const response = await stub.fetch("https://project/v1/outbox/workflow-started", {
    method: "POST",
    headers: authorityHeaders(env),
    body: json(payload),
  });
  if (!response.ok) throw new Error(`Project refused Workflow-start receipt (${response.status})`);
};

export const consumeSessionEffects = async (
  batch: MessageBatch<OutboxMessage>,
  env: CloudflareRuntimeEnv,
): Promise<void> => {
  for (const message of batch.messages) {
    let body: OutboxMessage;
    try {
      body = decode(OutboxMessageSchema, message.body);
    } catch {
      if (env.SESSION_DEAD_LETTER !== undefined) {
        await env.SESSION_DEAD_LETTER.send(message.body, { contentType: "json" });
      }
      message.ack();
      continue;
    }
    if (message.attempts > 3) {
      if (env.SESSION_DEAD_LETTER !== undefined)
        await env.SESSION_DEAD_LETTER.send(body, { contentType: "json" });
      message.ack();
      continue;
    }
    if (env.SESSION_WORKFLOW === undefined) {
      message.retry({ delaySeconds: 10 });
      continue;
    }
    try {
      try {
        await env.SESSION_WORKFLOW.create({
          id: workflowInstanceId(body.effect.effectId),
          params: body,
        });
      } catch {
        await env.SESSION_WORKFLOW.get(workflowInstanceId(body.effect.effectId));
      }
      await markWorkflowStarted(body, env);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 10 });
    }
  }
};

export const deadLetterSessionEffect = async (
  batch: MessageBatch<OutboxMessage>,
  env: CloudflareRuntimeEnv,
): Promise<void> => {
  for (const message of batch.messages) {
    const body = decode(OutboxMessageSchema, message.body);
    if (env.PROJECTS !== undefined) {
      const stub = env.PROJECTS.getByName(body.projectId);
      await stub.fetch("https://project/v1/outbox/workflow-started", {
        method: "POST",
        headers: authorityHeaders(env),
        body: json(
          decode(WorkflowStartReceiptRequestSchema, {
            _tag: "WorkflowStartReceipt",
            effectId: body.effect.effectId,
          }),
        ),
      });
    }
    message.ack();
  }
};

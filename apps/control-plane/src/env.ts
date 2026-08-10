import type { CloudflareRuntimeEnv, OutboxMessage } from "@work-engine/cloudflare";

export interface ControlPlaneEnv extends CloudflareRuntimeEnv {
  PROJECTS: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  PROJECT_INDEX: D1Database;
  SESSION_EFFECTS: Queue<OutboxMessage>;
  SESSION_WORKFLOW: Workflow<OutboxMessage>;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  AI: Ai;
}

export const PROJECT_ID_HEADER = "X-Work-Engine-Project-Id";

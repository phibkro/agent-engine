import type { OutboxMessage } from "./schemas.ts";

/** Bindings shared by the Worker, Project DO, Queue consumer, and Workflow. */
export interface CloudflareRuntimeEnv {
  PROJECTS?: DurableObjectNamespace;
  ARTIFACTS?: R2Bucket;
  PROJECT_INDEX?: D1Database;
  SESSION_HOST?: Fetcher;
  SESSION_EFFECTS?: Queue<OutboxMessage>;
  SESSION_DEAD_LETTER?: Queue<OutboxMessage>;
  SESSION_WORKFLOW?: Workflow<OutboxMessage>;
  AI?: Ai;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  AUTHORIZED_SSH_KEY_NAME?: string;
  CONTAINER_IMAGE_DIGEST?: string;
  RECONCILIATION_QUEUE?: Queue<{ readonly _tag: "ReconcileProjects" }>;
}

export const ACCESS_SERVICE_TOKEN_HEADERS = {
  id: "CF-Access-Client-Id",
  secret: "CF-Access-Client-Secret",
} as const;

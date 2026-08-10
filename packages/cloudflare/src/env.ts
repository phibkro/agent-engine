import type { CloudTask } from "./contract.ts";

/** Cloudflare bindings for the 0002 runtime. No 0001 D1, Queue, or Workflow bindings remain. */
export interface CloudflareRuntimeEnv {
  readonly SESSION: DurableObjectNamespace;
  readonly PROJECT_MEMORY: DurableObjectNamespace;
  readonly DEPENDENCY_CACHE?: R2Bucket;
  readonly GITHUB_TRANSPORT?: Fetcher;
  readonly SANDBOX_PROVIDER?: Fetcher;
  readonly CLOUD_TASK_AUTH_TOKEN?: string;
  readonly CLOUD_TASK_ROUTER_SECRET?: string;
  readonly PROJECT_MEMORY_COORDINATOR_SECRET?: string;
  readonly CLOUD_TASK_AUTH?: Fetcher;
  readonly PROFILE_CATALOG?: KVNamespace;
}

export interface CloudTaskRequestContext {
  readonly caller: string;
  readonly task: CloudTask;
}

export const CLOUD_TASK_AUTHORIZATION = "Authorization";
export const CLOUD_TASK_BEARER_PREFIX = "Bearer ";
export const SESSION_DO_PATH = "/v1/session";
export const PROJECT_MEMORY_DO_PATH = "/v1/project-memory";

import type { CloudTask } from "./contract.ts";
import type { Sandbox } from "@cloudflare/sandbox";

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
  readonly ENVIRONMENT?: DurableObjectNamespace;
  readonly SANDBOX?: DurableObjectNamespace<Sandbox>;
  readonly BACKUP_BUCKET?: R2Bucket;
  readonly CREDENTIAL_BROKER?: Fetcher;
  readonly CREDENTIAL_BROKER_SECRET?: string;
  readonly CREDENTIAL_BROKER_URL?: string;
  readonly ENVIRONMENT_ROUTER_SECRET?: string;
  readonly ENVIRONMENT_PUBLIC_ORIGIN?: string;
  readonly ENVIRONMENT_IMAGE_DIGEST?: string;
  readonly T3CODE_VERSION?: string;
  readonly SANDBOX_SDK_VERSION?: string;
  readonly ENVIRONMENT_CONNECT_RATE?: RateLimit;
  readonly ENVIRONMENT_HTTP_RATE?: RateLimit;
  readonly BACKUP_BUCKET_NAME?: string;
  readonly R2_ACCESS_KEY_ID?: string;
  readonly R2_SECRET_ACCESS_KEY?: string;
}

export interface CloudTaskRequestContext {
  readonly caller: string;
  readonly task: CloudTask;
}

export const CLOUD_TASK_AUTHORIZATION = "Authorization";
export const CLOUD_TASK_BEARER_PREFIX = "Bearer ";
export const SESSION_DO_PATH = "/v1/session";
export const PROJECT_MEMORY_DO_PATH = "/v1/project-memory";

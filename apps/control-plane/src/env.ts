import type { CloudflareRuntimeEnv } from "@work-engine/cloudflare";

export interface ControlPlaneEnv extends CloudflareRuntimeEnv {
  readonly SESSION: DurableObjectNamespace;
  readonly PROJECT_MEMORY: DurableObjectNamespace;
  readonly CLOUD_TASK_AUTH_TOKEN: string;
  readonly CLOUD_TASK_ROUTER_SECRET: string;
}

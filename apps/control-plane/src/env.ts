import type { CloudflareRuntimeEnv } from "@work-engine/cloudflare";

export interface ControlPlaneEnv extends CloudflareRuntimeEnv {
  readonly SESSION: DurableObjectNamespace;
  readonly PROJECT_MEMORY: DurableObjectNamespace;
  readonly CLOUD_TASK_AUTH_TOKEN: string;
  readonly CLOUD_TASK_ROUTER_SECRET: string;
  readonly ENVIRONMENT: DurableObjectNamespace;
  readonly SANDBOX: NonNullable<CloudflareRuntimeEnv["SANDBOX"]>;
  readonly BACKUP_BUCKET: R2Bucket;
  readonly CREDENTIAL_BROKER_SECRET: string;
  readonly CREDENTIAL_BROKER_URL: string;
  readonly ENVIRONMENT_ROUTER_SECRET: string;
  readonly ENVIRONMENT_PUBLIC_ORIGIN: string;
  readonly ENVIRONMENT_IMAGE_DIGEST: string;
  readonly T3CODE_VERSION: string;
  readonly SANDBOX_SDK_VERSION: string;
  readonly ENVIRONMENT_CONNECT_RATE: RateLimit;
  readonly ENVIRONMENT_HTTP_RATE: RateLimit;
  readonly BACKUP_BUCKET_NAME: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
}

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";
import type { Sandbox } from "@cloudflare/sandbox";

/** Deployment inputs remain explicit; no credentials are created by this graph. */
export const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");
export const publicDomain = Config.string("WORK_ENGINE_DOMAIN");
export const cloudTaskAuthToken = Config.redacted("CLOUD_TASK_AUTH_TOKEN");
export const cloudTaskRouterSecret = Config.redacted("CLOUD_TASK_ROUTER_SECRET");
export const environmentRouterSecret = Config.redacted("ENVIRONMENT_ROUTER_SECRET");
export const credentialBrokerSecret = Config.redacted("CREDENTIAL_BROKER_SECRET");
export const credentialBrokerUrl = Config.string("CREDENTIAL_BROKER_URL");
export const environmentPublicOrigin = Config.string("ENVIRONMENT_PUBLIC_ORIGIN");
export const environmentImageDigest = Config.string("ENVIRONMENT_IMAGE_DIGEST");
export const r2AccessKeyId = Config.redacted("R2_ACCESS_KEY_ID");
export const r2SecretAccessKey = Config.redacted("R2_SECRET_ACCESS_KEY");

/** Only the 0002 Session, Project Memory, cache, and control-plane resources are declared. */
export const graph = Effect.gen(function* () {
  const sessionNamespace = Cloudflare.DurableObject("Session");
  const projectMemoryNamespace = Cloudflare.DurableObject("ProjectMemory");
  const environmentNamespace = Cloudflare.DurableObject("EnvironmentDurableObject");
  const sandboxNamespace = Cloudflare.Container<Sandbox>("Sandbox", {
    context: "./infra/t3code-sandbox",
    instanceType: "standard-2",
    maxInstances: 1,
  });
  const dependencyCache = yield* Cloudflare.R2.Bucket("DependencyCache", {
    name: "work-engine-dependency-cache",
  });
  const environmentBackups = yield* Cloudflare.R2.Bucket("EnvironmentBackups", {
    name: "work-engine-environment-backups",
    lifecycleRules: [
      {
        id: "expire-environment-backups",
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 },
        },
      },
    ],
  });

  const controlPlaneWorker = yield* Cloudflare.Worker("ControlPlane", {
    main: "./apps/control-plane/src/index.ts",
    compatibility: {
      date: "2026-08-10",
    },
    routes: [{ pattern: publicDomain }],
    env: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUD_TASK_AUTH_TOKEN: cloudTaskAuthToken,
      CLOUD_TASK_ROUTER_SECRET: cloudTaskRouterSecret,
      ENVIRONMENT_ROUTER_SECRET: environmentRouterSecret,
      CREDENTIAL_BROKER_SECRET: credentialBrokerSecret,
      CREDENTIAL_BROKER_URL: credentialBrokerUrl,
      ENVIRONMENT_PUBLIC_ORIGIN: environmentPublicOrigin,
      ENVIRONMENT_IMAGE_DIGEST: environmentImageDigest,
      T3CODE_VERSION: "0.0.33",
      SANDBOX_SDK_VERSION: "0.12.5",
      BACKUP_BUCKET_NAME: "work-engine-environment-backups",
      R2_ACCESS_KEY_ID: r2AccessKeyId,
      R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
      SESSION: sessionNamespace,
      PROJECT_MEMORY: projectMemoryNamespace,
      DEPENDENCY_CACHE: dependencyCache,
      ENVIRONMENT: environmentNamespace,
      SANDBOX: sandboxNamespace,
      BACKUP_BUCKET: environmentBackups,
      ENVIRONMENT_CONNECT_RATE: Cloudflare.RateLimit("EnvironmentConnectRate", {
        namespaceId: 30031,
        simple: { limit: 30, period: 60 },
      }),
      ENVIRONMENT_HTTP_RATE: Cloudflare.RateLimit("EnvironmentHttpRate", {
        namespaceId: 30032,
        simple: { limit: 120, period: 60 },
      }),
    },
  });

  return {
    accountId,
    cloudTaskAuthToken,
    cloudTaskRouterSecret,
    controlPlaneWorker,
    credentialBrokerSecret,
    credentialBrokerUrl,
    environmentBackups,
    environmentImageDigest,
    environmentNamespace,
    environmentPublicOrigin,
    environmentRouterSecret,
    sandboxNamespace,
    r2AccessKeyId,
    r2SecretAccessKey,
    dependencyCache,
    projectMemoryNamespace,
    publicDomain,
    sessionNamespace,
  } as const;
});

export default graph;

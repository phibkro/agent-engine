import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";

/** Deployment inputs remain explicit; no credentials are created by this graph. */
export const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");
export const publicDomain = Config.string("WORK_ENGINE_DOMAIN");
export const cloudTaskAuthToken = Config.redacted("CLOUD_TASK_AUTH_TOKEN");
export const cloudTaskRouterSecret = Config.redacted("CLOUD_TASK_ROUTER_SECRET");

/** Only the 0002 Session, Project Memory, cache, and control-plane resources are declared. */
export const graph = Effect.gen(function* () {
  const sessionNamespace = Cloudflare.DurableObject("Session");
  const projectMemoryNamespace = Cloudflare.DurableObject("ProjectMemory");
  const dependencyCache = yield* Cloudflare.R2.Bucket("DependencyCache", {
    name: "work-engine-dependency-cache",
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
      SESSION: sessionNamespace,
      PROJECT_MEMORY: projectMemoryNamespace,
      DEPENDENCY_CACHE: dependencyCache,
    },
  });

  return {
    accountId,
    cloudTaskAuthToken,
    cloudTaskRouterSecret,
    controlPlaneWorker,
    dependencyCache,
    projectMemoryNamespace,
    publicDomain,
    sessionNamespace,
  } as const;
});

export default graph;

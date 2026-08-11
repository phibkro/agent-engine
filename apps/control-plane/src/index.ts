import * as Effect from "effect/Effect";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { ControlPlaneEnv } from "./env.ts";
import { handleRequest } from "./routes.ts";
export { ProjectMemoryDurableObject, SessionDurableObject } from "@work-engine/cloudflare";
export {
  ContainerProxy,
  EnvironmentDurableObject,
  Sandbox,
} from "@work-engine/cloudflare/environment-worker";
export { handleRequest } from "./routes.ts";
export type { ControlPlaneEnv } from "./env.ts";

export const fetch = (
  request: Request,
  env: ControlPlaneEnv,
  ctx: ExecutionContext,
): Promise<Response> => Effect.runPromise(handleRequest(request, env, ctx));

export default { fetch };

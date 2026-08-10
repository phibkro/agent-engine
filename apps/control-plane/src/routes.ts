import { CloudTaskRouter, EnvironmentRouter } from "@work-engine/cloudflare";
import type { ControlPlaneEnv } from "./env.ts";

export const handleRequest = async (
  request: Request,
  env: ControlPlaneEnv,
  _ctx: ExecutionContext,
): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", runtime: "agent-runtime-0002" });
  }
  if (url.pathname.startsWith("/v1/environments/")) {
    return new EnvironmentRouter(env).fetch(request);
  }
  if (!url.pathname.startsWith("/v1/cloud-tasks")) {
    return Response.json(
      { _tag: "NotFound", reason: "Worker route does not exist" },
      { status: 404 },
    );
  }
  return new CloudTaskRouter(env).fetch(request);
};

import { describe, expect, it } from "vitest";
import { EnvironmentRouter, type CloudflareRuntimeEnv } from "../src/index.ts";

const makeEnv = (fetchResponse = Response.json({ ok: true })) => {
  const requests: Request[] = [];
  const keys: string[] = [];
  const stub = {
    fetch: async (request: Request) => {
      requests.push(request);
      return fetchResponse;
    },
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: true };
    },
  } as RateLimit;
  const env = {
    ENVIRONMENT: namespace,
    ENVIRONMENT_ROUTER_SECRET: "router-secret",
    CLOUD_TASK_AUTH_TOKEN: "operator-token",
    ENVIRONMENT_CONNECT_RATE: limiter,
    ENVIRONMENT_HTTP_RATE: limiter,
  } as CloudflareRuntimeEnv;
  return { env, keys, requests };
};

const createBody = JSON.stringify({
  _tag: "CreateEnvironment",
  commandId: "create-00000000-0000-4000-8000-000000000001",
  environmentId: "demo-environment",
  ownerId: "operator-1",
  repository: { owner: "example", name: "project" },
  baseCommit: "0".repeat(40),
  provider: "codex",
});

describe("EnvironmentRouter", () => {
  it("requires operator authority and binds the route identity to the command", async () => {
    const { env, requests } = makeEnv();
    const unauthorized = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        method: "POST",
        body: createBody,
      }),
    );
    expect(unauthorized.status).toBe(403);

    const accepted = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token" },
        body: createBody,
      }),
    );
    expect(accepted.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("X-Environment-Internal")).toBe("router-secret");

    const mismatched = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/other-environment", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token" },
        body: createBody,
      }),
    );
    expect(mismatched.status).toBe(400);
  });

  it("keeps the connect address public while rate-limiting by source and environment", async () => {
    const { env, keys, requests } = makeEnv();
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api", {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
    );
    expect(response.status).toBe(200);
    expect(keys).toEqual(["203.0.113.7:demo-environment"]);
    expect(requests).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { EnvironmentRouter, type CloudflareRuntimeEnv } from "../src/index.ts";

const snapshot = {
  _tag: "EnvironmentSnapshot",
  schemaVersion: "work-engine/v2",
  environmentId: "demo-environment",
  ownerId: "operator-1",
  repository: { owner: "example", name: "project" },
  baseCommit: "0".repeat(40),
  provider: "codex",
  lifecycle: "Requested",
  versions: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    t3codeVersion: "0.9.0",
    sandboxSdkVersion: "1.0.0",
  },
  generation: null,
  retiredGenerationIds: [],
  acceptedCheckpoint: null,
  dataLossWarning: false,
  retainedCheckpoints: [],
  checkpointFailures: 0,
  checkpointRetryAt: null,
  recoveryFailures: 0,
  recoveryRetryAt: null,
  recoveryRequest: null,
  commandReceipts: [],
  createdAt: "2026-08-10T00:00:00.000Z",
  lastActivityAt: "2026-08-10T00:00:00.000Z",
  expiresAt: "2026-08-10T08:00:00.000Z",
  inactivityDeadline: "2026-08-10T00:30:00.000Z",
};

const createdResponse = {
  _tag: "EnvironmentCreated",
  snapshot,
  pairingUrl: "https://demo-environment.example.test/connect",
  expiresAt: "2026-08-10T00:10:00.000Z",
  scopes: [
    "orchestration:read",
    "orchestration:operate",
    "terminal:operate",
    "review:write",
    "relay:read",
  ],
};

const makeEnv = (fetchResponse = Response.json(createdResponse)) => {
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
    expect(requests[0]?.headers.get("Authorization")).toBeNull();
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]?.text()).toBe(createBody);

    const mismatched = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/other-environment", {
        method: "POST",
        headers: { Authorization: "Bearer operator-token" },
        body: createBody,
      }),
    );
    expect(mismatched.status).toBe(400);
  });
  it("rejects a public checkpoint without command identity before forwarding", async () => {
    const { env, requests } = makeEnv();
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        method: "POST",
        headers: {
          Authorization: "Bearer operator-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          _tag: "CheckpointEnvironment",
          environmentId: "demo-environment",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("keeps the connect address public while rate-limiting by source and environment", async () => {
    const { env, keys, requests } = makeEnv();
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api", {
        headers: {
          "CF-Connecting-IP": "203.0.113.7",
          Authorization: "Bearer client-token",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(keys).toEqual(["203.0.113.7:demo-environment"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer client-token");
  });

  it("fails closed before DO access when the HTTP connection limiter is missing", async () => {
    const { env, requests } = makeEnv();
    const response = await new EnvironmentRouter({
      ...env,
      ENVIRONMENT_HTTP_RATE: undefined,
    }).fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api", {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
    );

    expect(response.status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  it("fails closed before DO access when the WebSocket limiter is missing", async () => {
    const { env, requests } = makeEnv();
    const response = await new EnvironmentRouter({
      ...env,
      ENVIRONMENT_CONNECT_RATE: undefined,
    }).fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api", {
        headers: {
          "CF-Connecting-IP": "203.0.113.7",
          Upgrade: "websocket",
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(requests).toHaveLength(0);
  });

  it("omits the snapshot when an inspect response has no Environment state", async () => {
    const { env, requests } = makeEnv(Response.json({ _tag: "EnvironmentInspected" }));
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        headers: { Authorization: "Bearer operator-token" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ _tag: "EnvironmentInspected" });
    expect(requests).toHaveLength(1);
  });

  it("fails closed when the Environment DO success payload is malformed", async () => {
    const { env, requests } = makeEnv(
      Response.json({ _tag: "EnvironmentInspected", snapshot: {} }),
    );
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        headers: { Authorization: "Bearer operator-token" },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      _tag: "ProviderUnavailable",
      reason: "Environment provider is unavailable",
    });
    expect(requests).toHaveLength(1);
  });

  it("fails closed when the Environment DO failure payload is malformed", async () => {
    const { env, requests } = makeEnv(
      new Response(
        JSON.stringify({
          _tag: "InvalidRequest",
          reason: "internal details",
          extra: "must not cross the router",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        headers: { Authorization: "Bearer operator-token" },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      _tag: "ProviderUnavailable",
      reason: "Environment provider is unavailable",
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects a connect request without a verified source identity", async () => {
    const { env, keys, requests } = makeEnv();
    const response = await new EnvironmentRouter(env).fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      _tag: "InvalidRequest",
      reason: "Environment request is invalid",
    });
    expect(keys).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

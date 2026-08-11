import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { fetch as workerFetch } from "../src/index.ts";
import type { ControlPlaneEnv } from "../src/env.ts";

const sessionId = "ses_00000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

const makeEnv = (): ControlPlaneEnv => {
  const sessionStub = {
    fetch: async (request: Request): Promise<Response> => {
      expect(request.headers.get("X-Cloud-Task-Internal")).toBe("router-secret");
      return Response.json({
        _tag: "Result",
        result: { _tag: "Pending", sessionId },
      });
    },
  };
  const session = {
    getByName: () => sessionStub,
  };
  const objectNamespace = {
    get: () => sessionStub,
    idFromName: (name: string) => name,
  };
  const rate = {
    limit: async () => ({ success: true }),
  };
  return {
    SESSION: session,
    PROJECT_MEMORY: objectNamespace,
    CLOUD_TASK_AUTH_TOKEN: "auth-token",
    CLOUD_TASK_ROUTER_SECRET: "router-secret",
    ENVIRONMENT: objectNamespace,
    SANDBOX: objectNamespace,
    BACKUP_BUCKET: {},
    CREDENTIAL_BROKER_SECRET: "broker-secret",
    CREDENTIAL_BROKER_URL: "https://broker.example.test",
    ENVIRONMENT_ROUTER_SECRET: "environment-secret",
    ENVIRONMENT_PUBLIC_ORIGIN: "https://environment.example.test",
    ENVIRONMENT_IMAGE_DIGEST: digest,
    T3CODE_VERSION: "0.0.33",
    SANDBOX_SDK_VERSION: "0.12.5",
    ENVIRONMENT_CONNECT_RATE: rate,
    ENVIRONMENT_HTTP_RATE: rate,
    BACKUP_BUCKET_NAME: "test-backups",
    R2_ACCESS_KEY_ID: "access-key",
    R2_SECRET_ACCESS_KEY: "secret-key",
  } as unknown as ControlPlaneEnv;
};

const context = {} as ExecutionContext;

describe("control-plane composition root", () => {
  it("rejects invalid config before binding providers are touched", async () => {
    const env = makeEnv();
    let bindingReads = 0;
    const session = env.SESSION;
    Object.defineProperty(env, "CLOUD_TASK_AUTH_TOKEN", { value: undefined });
    Object.defineProperty(env, "SESSION", {
      configurable: true,
      get: () => {
        bindingReads += 1;
        return session;
      },
    });

    const response = await workerFetch(
      new Request("https://control-plane.example.test/health"),
      env,
      context,
    );

    expect(response.status).toBe(503);
    expect(bindingReads).toBe(0);
    await expect(response.json()).resolves.toEqual({
      _tag: "ControlPlaneConfigurationFailure",
      reason: "Control-plane configuration is invalid",
    });
  });

  it("validates config and routes through the existing CloudTask router", async () => {
    const response = await workerFetch(
      new Request("https://control-plane.example.test/v1/cloud-tasks", {
        method: "POST",
        headers: { authorization: "Bearer auth-token" },
        body: JSON.stringify({ _tag: "Result", sessionId }),
      }),
      makeEnv(),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      _tag: "Result",
      result: { _tag: "Pending", sessionId },
    });
  });
});

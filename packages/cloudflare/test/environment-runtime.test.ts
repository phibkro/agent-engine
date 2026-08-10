import { describe, expect, it } from "vitest";
import { FetcherEnvironmentCredentialBroker } from "../src/index.ts";

const leaseInput = {
  environmentId: "demo-environment",
  repository: { owner: "example", name: "project" },
  provider: "codex" as const,
};

describe("FetcherEnvironmentCredentialBroker", () => {
  it("authenticates a bounded lease request and decodes environment variables", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const broker = new FetcherEnvironmentCredentialBroker(
      {
        fetch: async (input, init) => {
          requests.push({ input, ...(init === undefined ? {} : { init }) });
          return Response.json({
            environment: { GITHUB_TOKEN: "short-lived", OPENAI_API_KEY: "provider-lease" },
          });
        },
      },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );

    const lease = await broker.lease(leaseInput);
    expect(lease.environment).toEqual({
      GITHUB_TOKEN: "short-lived",
      OPENAI_API_KEY: "provider-lease",
    });
    expect(requests[0]?.input).toBe("https://vault.example/v1/environment-lease");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer broker-secret",
    });
  });

  it("rejects malformed or GitHub-less leases", async () => {
    const broker = new FetcherEnvironmentCredentialBroker(
      { fetch: async () => Response.json({ environment: { "bad-name": "secret" } }) },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );
    await expect(broker.lease(leaseInput)).rejects.toThrow("invalid environment variables");
  });
});

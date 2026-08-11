import { describe, expect, it } from "vitest";
import { FetcherEnvironmentCredentialBroker } from "../src/index.ts";

const leaseInput = {
  environmentId: "demo-environment",
  generationId: "demo-environment-g1",
  repository: { owner: "example", name: "project" },
  provider: "codex" as const,
};

describe("FetcherEnvironmentCredentialBroker", () => {
  it("authenticates generation-bound lease and revocation requests", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const broker = new FetcherEnvironmentCredentialBroker(
      {
        fetch: async (input, init) => {
          requests.push({ input, ...(init === undefined ? {} : { init }) });
          return Response.json({
            generationToken: "generation-token",
            expiresAt: "2026-08-10T01:00:00.000Z",
          });
        },
      },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );

    const lease = await broker.lease(leaseInput);
    await broker.revoke({
      environmentId: leaseInput.environmentId,
      generationId: leaseInput.generationId,
    });
    expect(lease).toEqual({
      generationToken: "generation-token",
      brokerOrigin: "https://vault.example",
      expiresAt: "2026-08-10T01:00:00.000Z",
    });
    expect(requests.map((request) => request.init?.method)).toEqual(["POST", "DELETE"]);
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer broker-secret",
    });
  });

  it("rejects malformed leases", async () => {
    const broker = new FetcherEnvironmentCredentialBroker(
      { fetch: async () => Response.json({ generationToken: "" }) },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );
    await expect(broker.lease(leaseInput)).rejects.toThrow("invalid");
  });
});

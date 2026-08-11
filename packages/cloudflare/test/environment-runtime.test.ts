import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: (namespace: DurableObjectNamespace, id: string) =>
    namespace.get(namespace.idFromName(id)),
}));

import { FetcherEnvironmentCredentialBroker } from "../src/index.ts";
import { CloudflareSandboxEnvironmentRuntime } from "../src/environment-runtime.ts";

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
          return init?.method === "DELETE"
            ? new Response(null, { status: 204 })
            : Response.json({
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
    expect(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(String(requests[0]?.init?.body)),
    ).toEqual(leaseInput);
  });

  it.each([
    ["a 200 lease body", Response.json({ generationToken: "unexpected" })],
    ["a 202 pending response", new Response(null, { status: 202 })],
  ])("rejects revocation success that is not an empty 204 (%s)", async (_label, response) => {
    const broker = new FetcherEnvironmentCredentialBroker(
      { fetch: async () => response },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );
    await expect(
      broker.revoke({
        environmentId: leaseInput.environmentId,
        generationId: leaseInput.generationId,
      }),
    ).rejects.toThrow("empty 204");
  });

  it("rejects malformed leases", async () => {
    const broker = new FetcherEnvironmentCredentialBroker(
      { fetch: async () => Response.json({ generationToken: "" }) },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );
    await expect(broker.lease(leaseInput)).rejects.toThrow("invalid");
  });

  it("rejects malformed broker failure envelopes", async () => {
    const broker = new FetcherEnvironmentCredentialBroker(
      {
        fetch: async () =>
          Response.json({ reason: "unavailable", unexpected: true }, { status: 503 }),
      },
      "https://vault.example/v1/environment-lease",
      "broker-secret",
    );

    await expect(broker.lease(leaseInput)).rejects.toThrow("invalid failure response");
  });
});

describe("CloudflareSandboxEnvironmentRuntime", () => {
  it("releases a locally acquired Sandbox when startup fails", async () => {
    const events: string[] = [];
    const sandbox = {
      setKeepAlive: async (enabled: boolean) => {
        events.push(`keepAlive:${String(enabled)}`);
      },
      exec: async () => {
        events.push("exec");
        throw new Error("startup failed");
      },
      destroy: async () => {
        events.push("destroy");
      },
    };
    const namespace = {
      idFromName: (id: string) => id,
      get: () => sandbox,
    } as unknown as DurableObjectNamespace<Sandbox>;
    const runtime = new CloudflareSandboxEnvironmentRuntime({
      sandbox: namespace,
      credentials: {
        lease: async () => {
          throw new Error("unused");
        },
        revoke: async () => {},
      },
      backupBucket: {} as R2Bucket,
      publicOrigin: "https://environment.example",
      now: () => "2026-08-10T00:00:00.000Z",
    });

    await expect(
      runtime.start({
        environmentId: "demo-environment",
        generationOrdinal: 1,
        keepAlive: true,
      }),
    ).rejects.toThrow("startup failed");
    expect(events).toEqual(["keepAlive:true", "exec", "keepAlive:false", "destroy"]);
  });
});

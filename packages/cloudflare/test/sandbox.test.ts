import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { SessionIdSchema, Sha256DigestSchema, TimestampSchema } from "@work-engine/protocol";
import { CloudflareSandboxProvider, type SandboxFetcher } from "../src/index.ts";

const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000001");
const imageDigest = Sha256DigestSchema.make(`sha256:${"1".repeat(64)}`);
const allocatedAt = TimestampSchema.make("2026-08-10T00:00:00.000Z");
const clock = { now: () => allocatedAt };

describe("CloudflareSandboxProvider", () => {
  it("strictly decodes a provider allocation and uses the injected clock", async () => {
    let requestBody: unknown;
    const fetcher: SandboxFetcher = {
      fetch: async (_input, init) => {
        requestBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
          String(init?.body),
        );
        return Response.json({
          providerId: "sandbox-1",
          workspaceRoot: "/workspace",
        });
      },
    };
    const provider = new CloudflareSandboxProvider(fetcher, clock);

    await expect(provider.allocate(sessionId, imageDigest)).resolves.toEqual({
      providerId: "sandbox-1",
      sessionId,
      imageDigest,
      workspaceRoot: "/workspace",
      allocatedAt,
    });
    expect(requestBody).toEqual({ sessionId, imageDigest });
  });

  it("rejects malformed successful provider responses", async () => {
    const fetcher: SandboxFetcher = {
      fetch: async () =>
        Response.json({
          providerId: "sandbox-1",
          workspaceRoot: "/workspace",
          unexpected: true,
        }),
    };
    const provider = new CloudflareSandboxProvider(fetcher, clock);

    await expect(provider.allocate(sessionId, imageDigest)).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
    });
  });

  it("rejects non-JSON provider responses and invalid termination identities", async () => {
    const fetcher: SandboxFetcher = {
      fetch: async () => new Response("not-json"),
    };
    const provider = new CloudflareSandboxProvider(fetcher, clock);

    await expect(provider.allocate(sessionId, imageDigest)).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
    });
    await expect(provider.terminate("")).rejects.toMatchObject({ _tag: "InvalidRequest" });
  });
});

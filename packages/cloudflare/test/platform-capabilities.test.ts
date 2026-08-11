import { describe, expect, it } from "vitest";
import { TimestampSchema, decodeUnknownStrict } from "@work-engine/protocol";
import { cloudflarePlatformCapabilities } from "../src/index.ts";

describe("Cloudflare platform capabilities", () => {
  it("provides schema-valid time, UUID, and SHA-256 values", async () => {
    expect(() =>
      decodeUnknownStrict(TimestampSchema, cloudflarePlatformCapabilities.now()),
    ).not.toThrow();
    expect(cloudflarePlatformCapabilities.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    await expect(cloudflarePlatformCapabilities.sha256(new Uint8Array())).resolves.toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

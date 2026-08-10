import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import {
  TracerAcceptanceEvidenceSchema,
  TracerAcceptanceRecordSchema,
} from "../../packages/protocol/src/index.ts";
import { verifyFixture } from "./fixture.ts";

describe("tracer 0001 acceptance boundary", () => {
  test("verifies the exact committed base, candidate, and patch", async () => {
    const verified = await verifyFixture();
    expect(verified.manifest.writableScope).toEqual(["src/greeting.ts"]);
    expect(verified.manifest.base.entries.map(({ path }) => path)).toEqual([
      "package.json",
      "src/greeting.ts",
      "test/greeting.test.ts",
    ]);
    expect(verified.manifest.candidate.entries.map(({ path }) => path)).toEqual([
      "package.json",
      "src/greeting.ts",
      "test/greeting.test.ts",
    ]);
    expect(verified.manifest.patch.bytes).toBeGreaterThan(0);
  });

  test("records unavailable evidence without accepting it as success", async () => {
    const input = JSON.parse(
      await Bun.file(`${import.meta.dirname}/evidence.json`).text(),
    ) as unknown;
    expect(() =>
      Schema.decodeUnknownSync(TracerAcceptanceRecordSchema, {
        onExcessProperty: "error",
      })(input),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TracerAcceptanceEvidenceSchema, {
        onExcessProperty: "error",
      })(input),
    ).toThrow();
  });
});

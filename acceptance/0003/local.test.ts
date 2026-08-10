import { expect, test } from "vitest";
import { runLocalEnvironmentTracer } from "./local.ts";

test("exercises the complete local Environment lifecycle without claiming deployment", async () => {
  const evidence = await runLocalEnvironmentTracer();
  expect(evidence).toEqual({
    _tag: "LocalEnvironmentTracerEvidence",
    cloudflareDeployed: false,
    lifecycle: ["Ready", "Ready", "Ready", "Destroyed"],
    checkpointValidated: true,
    generationReplaced: true,
    destructionTerminal: true,
  });
});

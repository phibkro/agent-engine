#!/usr/bin/env bun
import { Schema } from "effect";
import { ProductDecisionReportSchema } from "../../packages/protocol/src/index.ts";
import { ComparativeTrialInputSchema, evaluateComparativeTrials } from "./evaluate.ts";

const inputPath = Bun.argv[2];
if (inputPath === undefined) {
  console.error("usage: bun acceptance/0002/report.ts <paired-trials.json>");
  process.exitCode = 64;
} else {
  try {
    const input = Schema.decodeUnknownSync(Schema.fromJsonString(ComparativeTrialInputSchema), {
      onExcessProperty: "error",
    })(await Bun.file(inputPath).text());
    const report = evaluateComparativeTrials(input);
    console.log(Schema.encodeSync(Schema.fromJsonString(ProductDecisionReportSchema))(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 65;
  }
}

#!/usr/bin/env bun
import { evaluateComparativeTrials, type ComparativeTrialInput } from "./evaluate.ts";

const inputPath = Bun.argv[2];
if (inputPath === undefined) {
  console.error("usage: bun acceptance/0002/report.ts <paired-trials.json>");
  process.exitCode = 64;
} else {
  try {
    const input = (await Bun.file(inputPath).json()) as ComparativeTrialInput;
    console.log(JSON.stringify(evaluateComparativeTrials(input), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 65;
  }
}

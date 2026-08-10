import { describe, expect, test } from "vitest";
import { evaluateComparativeTrials } from "./evaluate.ts";

const uuid = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const digest = (value: string): string => `sha256:${value.repeat(64)}`;
const timestamp = "2026-08-10T00:00:00.000Z";
const commit = "a".repeat(40);
const cacheManifest = {
  _tag: "DependencyCacheManifest",
  cacheKey: digest("1"),
  runtimeDigest: digest("2"),
  platformDigest: digest("3"),
  imageDigest: digest("4"),
  repositoryDigest: digest("5"),
  lockfileDigest: digest("6"),
  payloadDigest: digest("7"),
  createdAt: timestamp,
};

const manifest = {
  _tag: "TrialManifest",
  trialId: "trial-1",
  taskId: `tsk_${uuid("1")}`,
  projectId: `prj_${uuid("2")}`,
  objective: "complete representative task",
  writablePaths: ["src/**"],
  baseline: {
    model: "matched-model",
    budget: { tokens: 10_000 },
    baseCommit: commit,
    cacheManifest,
    verificationCommands: ["bun test"],
    capabilities: ["harness-native"],
  },
  treatment: {
    model: "matched-model",
    budget: { tokens: 10_000 },
    baseCommit: commit,
    cacheManifest,
    verificationCommands: ["bun test"],
    capabilities: ["agent-runtime"],
  },
};

const completed = (sessionId: string) => ({
  _tag: "Completed",
  sessionId,
  result: {
    _tag: "CompletedResult",
    sessionId,
    projectId: manifest.projectId,
    profileId: `prf_${uuid("3")}`,
    profileRevision: 1,
    profileDigest: digest("8"),
    repository: { owner: "example", name: "fixture" },
    baseCommit: commit,
    candidateCommit: "b".repeat(40),
    candidateBranch: `agent/${sessionId}`,
    candidateUrl: `https://example.invalid/${sessionId}`,
    changedPaths: ["src/change.ts"],
    commitMetadata: { sha: "b".repeat(40), message: "change" },
    commands: [],
    artifacts: [],
    startedAt: timestamp,
    completedAt: timestamp,
    publishedAt: timestamp,
    unresolvedBlockers: [],
  },
});

const measures = (arm: "baseline" | "treatment") => ({
  correctnessScore: 1,
  verificationPassed: true,
  safetyViolations: [],
  recoveryRequired: true,
  recoverySucceeded: true,
  operatorInterventions: arm === "baseline" ? 2 : 0,
  isolationViolations: [],
  reconstructable: true,
  profileDigest: arm === "baseline" ? digest("9") : digest("8"),
  configurationCopied: false,
  modelToolConsumption: arm === "baseline" ? 100 : 80,
  completionLatencyMs: arm === "baseline" ? 1000 : 1100,
  directCostUsd: arm === "baseline" ? 1 : 1.1,
  frictionCount: arm === "baseline" ? 3 : 1,
});

const record = (arm: "baseline" | "treatment", run: number, overrides = {}) => {
  const sessionId = `ses_${uuid(String(arm === "baseline" ? run : run + 100))}`;
  return {
    _tag: "TrialRecord",
    trialId: manifest.trialId,
    arm,
    runId: `${arm}-${run}`,
    sessionId,
    result: completed(sessionId),
    measures: { ...measures(arm), ...overrides },
    recordedAt: timestamp,
  };
};

const records = () => [
  ...[1, 2, 3].map((run) => record("baseline", run)),
  ...[1, 2, 3].map((run) => record("treatment", run)),
];

describe("0002 comparative product decision", () => {
  test("expands only from paired repeated evidence and preserves every raw row", () => {
    const report = evaluateComparativeTrials({ manifests: [manifest], records: records() });
    expect(report.decision).toBe("expand");
    expect(report.records).toHaveLength(6);
    expect(report.thresholdResults["improvementCount"]).toBeGreaterThanOrEqual(2);
  });

  test("a known-bad treatment cannot produce expansion", () => {
    const bad = records();
    for (const entry of bad) {
      if (entry.arm === "treatment") {
        Object.assign(entry.measures, { safetyViolations: ["credential exposure"] });
      }
    }
    const report = evaluateComparativeTrials({ manifests: [manifest], records: bad });
    expect(report.decision).toBe("collapse");
    expect(report.thresholdResults["treatmentQualifies"]).toBe(false);
  });

  test("rejects missing repetitions and reused Session identities", () => {
    expect(() =>
      evaluateComparativeTrials({ manifests: [manifest], records: records().slice(0, 5) }),
    ).toThrow(/at least three runs/iu);
    const duplicated = records();
    duplicated[1] = { ...duplicated[1]!, sessionId: duplicated[0]!.sessionId };
    expect(() => evaluateComparativeTrials({ manifests: [manifest], records: duplicated })).toThrow(
      /fresh Session identities/iu,
    );
  });
});

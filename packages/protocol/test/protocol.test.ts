import { expect, test } from "vitest";
import {
  CloudTaskSchema,
  ProjectMemoryRevisionSchema,
  RepositoryGrantSchema,
  SessionResultSchema,
  TrialManifestSchema,
  decodeUnknownStrict,
} from "../src/index.ts";
const sessionId = "ses_00000000-0000-4000-8000-000000000001";
const taskId = "tsk_00000000-0000-4000-8000-000000000003";
const projectId = "prj_00000000-0000-4000-8000-000000000004";
const profileId = "prf_00000000-0000-4000-8000-000000000005";
const grantId = "grt_00000000-0000-4000-8000-000000000006";
const baseCommit = "0000000000000000000000000000000000000001";
const candidateCommit = "0000000000000000000000000000000000000002";
const digest = "sha256:" + "a".repeat(64);
const now = "2026-08-10T00:00:00.000Z";

const task = {
  _tag: "CloudTask",
  taskId,
  sessionId,
  projectId,
  profileId,
  profileRevision: 1,
  profileDigest: digest,
  baseCommit,
  objective: "update the behavior",
  writablePaths: ["src/**"],
  requiredCommands: ["bun test"],
  deadline: now,
  outputLimitBytes: 100_000,
};

const cacheManifest = {
  _tag: "DependencyCacheManifest",
  cacheKey: "cache-key",
  runtimeDigest: digest,
  platformDigest: digest,
  imageDigest: digest,
  repositoryDigest: digest,
  lockfileDigest: digest,
  payloadDigest: digest,
  createdAt: now,
};

const arm = {
  model: "model:test",
  budget: { maxOutputBytes: 100_000, maxToolCalls: 10 },
  baseCommit,
  cacheManifest,
  verificationCommands: ["bun test"],
  capabilities: ["repository:read"],
};

test("decodes a valid CloudTask and rejects excess properties", () => {
  expect(decodeUnknownStrict(CloudTaskSchema, task).sessionId).toBe(sessionId);
  expect(() => decodeUnknownStrict(CloudTaskSchema, { ...task, unexpected: true })).toThrow();
});

test("rejects malformed identifiers and SHA-256 digests", () => {
  expect(() =>
    decodeUnknownStrict(CloudTaskSchema, { ...task, sessionId: "ses_not-a-uuid" }),
  ).toThrow();
  expect(() =>
    decodeUnknownStrict(CloudTaskSchema, { ...task, profileDigest: "sha256:bad" }),
  ).toThrow();
});

test("rejects impossible UTC timestamps", () => {
  expect(() =>
    decodeUnknownStrict(CloudTaskSchema, {
      ...task,
      deadline: "2026-02-30T00:00:00.000Z",
    }),
  ).toThrow();
});

test("accepts paired trial JSON values with reordered object keys", () => {
  const decoded = decodeUnknownStrict(TrialManifestSchema, {
    _tag: "TrialManifest",
    trialId: "trial-1",
    taskId,
    projectId,
    objective: "paired task",
    writablePaths: ["src/**"],
    baseline: arm,
    treatment: {
      ...arm,
      budget: {
        maxToolCalls: 10,
        maxOutputBytes: 100_000,
      },
    },
  });

  expect(decoded.trialId).toBe("trial-1");
});

test("accepts terminal results and rejects an unknown terminal state", () => {
  const completed = {
    _tag: "Completed",
    sessionId,
    result: {
      _tag: "CompletedResult",
      sessionId,
      projectId,
      profileId,
      profileRevision: 1,
      profileDigest: digest,
      repository: { owner: "org", name: "repo" },
      baseCommit,
      candidateCommit,
      candidateBranch: "agent/project/session",
      candidateUrl: "https://github.com/org/repo/tree/agent/project/session",
      changedPaths: ["src/index.ts"],
      commitMetadata: { sha: candidateCommit, message: "candidate" },
      commands: [],
      artifacts: [],
      startedAt: now,
      completedAt: now,
      publishedAt: now,
      unresolvedBlockers: [],
    },
  };
  expect(decodeUnknownStrict(SessionResultSchema, completed)._tag).toBe("Completed");
  expect(() =>
    decodeUnknownStrict(SessionResultSchema, { ...completed, _tag: "Running" }),
  ).toThrow();
});

test("rejects a stale Project Memory revision", () => {
  expect(() =>
    decodeUnknownStrict(ProjectMemoryRevisionSchema, {
      _tag: "ProjectMemoryRevision",
      projectId,
      memoryRevision: 2,
      previousRevision: 2,
      facts: [],
      acceptedAt: now,
    }),
  ).toThrow();
});

test("rejects a repository grant whose WIP and candidate refs collapse", () => {
  expect(() =>
    decodeUnknownStrict(RepositoryGrantSchema, {
      _tag: "RepositoryGrant",
      grantId,
      sessionId,
      projectId,
      repository: { owner: "org", name: "repo" },
      baseCommit,
      writablePaths: ["src/**"],
      wipRef: "agent/project/session",
      candidateRef: "agent/project/session",
      expiresAt: now,
      issuedAt: now,
    }),
  ).toThrow();
});

test("rejects mismatched paired trial arms", () => {
  expect(() =>
    decodeUnknownStrict(TrialManifestSchema, {
      _tag: "TrialManifest",
      trialId: "trial-1",
      taskId,
      projectId,
      objective: "paired task",
      writablePaths: ["src/**"],
      baseline: arm,
      treatment: { ...arm, baseCommit: candidateCommit },
    }),
  ).toThrow();
  expect(
    decodeUnknownStrict(TrialManifestSchema, {
      _tag: "TrialManifest",
      trialId: "trial-1",
      taskId,
      projectId,
      objective: "paired task",
      writablePaths: ["src/**"],
      baseline: arm,
      treatment: { ...arm, capabilities: ["repository:read", "memory:propose"] },
    }).trialId,
  ).toBe("trial-1");
});

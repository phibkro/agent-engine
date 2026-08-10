import { describe, expect, it } from "vitest";
import {
  CacheDigestMismatchError,
  InMemoryCloudTaskDirectory,
  ProjectMemoryState,
  SessionState,
  TrustedRepositoryPublisher,
  makeRepositoryGrant,
  refsAreDistinct,
  sessionRefs,
  verifyDependencyCache,
} from "../src/index.ts";
import type { CloudTask, DependencyCacheManifest } from "../src/index.ts";

const uuid = "00000000-0000-4000-8000-000000000001";
const digest = (hex: string): string => `sha256:${hex.repeat(64 / hex.length)}`;
const task = (): CloudTask => ({
  _tag: "CloudTask",
  taskId: `tsk_${uuid}`,
  sessionId: `ses_${uuid}`,
  projectId: `prj_${uuid}`,
  profileId: `prf_${uuid}`,
  profileRevision: 1,
  profileDigest: digest("1"),
  baseCommit: "a".repeat(40),
  objective: "make a bounded change",
  writablePaths: ["packages/**"],
  requiredCommands: ["bun test"],
  deadline: "2026-08-10T00:00:00.000Z",
  outputLimitBytes: 100_000,
} as unknown as CloudTask);

const request = (payload: Record<string, unknown>, token = "test-token"): Request =>
  new Request("https://cloud-task/v1/cloud-tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

describe("authenticated CloudTask routing", () => {
  it("deduplicates spawn and send by caller-minted identities", async () => {
    const directory = new InMemoryCloudTaskDirectory();
    const first = await directory.fetch(request({ _tag: "Spawn", sessionId: task().sessionId, task: task() }));
    const second = await directory.fetch(request({ _tag: "Spawn", sessionId: task().sessionId, task: task() }));
    expect(await first.json()).toEqual(await second.json());

    const send = { _tag: "Send", sessionId: task().sessionId, messageId: `msg_${uuid}`, message: "continue" };
    const accepted = await directory.fetch(request(send));
    const duplicate = await directory.fetch(request(send));
    expect(await accepted.json()).toEqual(await duplicate.json());
  });

  it("rejects a valid sessionId without caller authentication", async () => {
    const directory = new InMemoryCloudTaskDirectory();
    const response = await directory.fetch(request({ _tag: "Result", sessionId: task().sessionId }, "wrong-token"));
    expect(response.status).toBe(403);
  });
});

describe("Project Memory authority", () => {
  it("rejects stale acceptance while preserving pinned reads", () => {
    const memory = new ProjectMemoryState(task().projectId);
    const provenance = {
      _tag: "ProjectMemoryProvenance",
      source: "worker",
      observedAt: "2026-08-10T00:00:00.000Z",
    };
    const proposal = memory.proposeMemory(task().sessionId, 0, "build uses Bun", provenance);
    const revision = memory.acceptMemory(proposal.proposalId, 0);
    expect(memory.readContext(0)).toHaveLength(0);
    expect(memory.readContext(revision.memoryRevision)).toHaveLength(1);
    const stale = memory.proposeMemory(task().sessionId, 0, "stale claim", provenance);
    expect(() => memory.acceptMemory(stale.proposalId, 0)).toThrow(/Expected memory revision/iu);
    expect(memory.readContext(revision.memoryRevision)).toHaveLength(1);
  });
});

describe("Session terminal and repository refs", () => {
  it("gives cancellation precedence over late completion and records side effects", () => {
    const session = new SessionState(task());
    session.start();
    session.requestCancellation("operator stop");
    session.recordCandidate("b".repeat(40), sessionRefs(task().projectId, task().sessionId).candidate);
    expect(session.complete({ _tag: "CompletedResult" })._tag).toBe("Cancelled");
    expect(session.snapshot.sideEffects.some((effect) => effect.kind === "candidate")).toBe(true);
  });

  it("derives distinct WIP and candidate refs", () => {
    const refs = sessionRefs(task().projectId, task().sessionId);
    expect(refsAreDistinct(refs)).toBe(true);
    expect(refs.wip.endsWith("/wip")).toBe(true);
    expect(refs.candidate.endsWith("/wip")).toBe(false);
  });
});

describe("Dependency cache", () => {
  it("rejects a payload digest mismatch", async () => {
    const manifest = {
      _tag: "DependencyCacheManifest",
      cacheKey: "cache-key",
      runtimeDigest: digest("1"),
      platformDigest: digest("2"),
      imageDigest: digest("3"),
      repositoryDigest: digest("4"),
      lockfileDigest: digest("5"),
      payloadDigest: digest("0"),
      createdAt: "2026-08-10T00:00:00.000Z",
    } as unknown as DependencyCacheManifest;
    await expect(
      verifyDependencyCache(manifest, {
        runtimeDigest: digest("1"),
        platformDigest: digest("2"),
        imageDigest: digest("3"),
        repositoryDigest: digest("4"),
        lockfileDigest: digest("5"),
      }, new TextEncoder().encode("wrong")),
    ).rejects.toBeInstanceOf(CacheDigestMismatchError);
  });

  it("does not claim provider success when GitHub transport is absent", async () => {
    const publisher = new TrustedRepositoryPublisher(undefined);
    const grant = makeRepositoryGrant({
      grantId: `grt_${uuid}`,
      sessionId: task().sessionId,
      projectId: task().projectId,
      repository: { owner: "org", name: "repo" },
      baseCommit: task().baseCommit,
      writablePaths: ["packages/**"],
      expiresAt: "2026-08-11T00:00:00.000Z",
    });
    await expect(publisher.checkout(grant, task().sessionId)).rejects.toMatchObject({ _tag: "ProviderUnavailable" });
  });
});

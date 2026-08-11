import { describe, expect, it } from "vitest";
import { MemoryRevisionSchema, Sha256DigestSchema, TimestampSchema } from "@work-engine/protocol";
import {
  CacheDigestMismatchError,
  CloudflareProjectMemory,
  CloudflareCloudTaskClient,
  CloudTaskSchema,
  decode,
  InMemoryCloudTaskDirectory,
  ProjectMemoryDurableObject,
  ProjectMemoryState,
  ProjectMemoryProvenanceSchema,
  SessionState,
  TrustedRepositoryPublisher,
  makeRepositoryGrant,
  refsAreDistinct,
  sessionRefs,
  verifyDependencyCache,
  ProviderUnavailableError,
  SessionTerminalError,
} from "../src/index.ts";
import type {
  CloudTask,
  DependencyCacheManifest,
  PlatformCapabilities,
  SessionSnapshot,
} from "../src/index.ts";

const uuid = "00000000-0000-4000-8000-000000000001";
const digest = (hex: string) => Sha256DigestSchema.make(`sha256:${hex.repeat(64 / hex.length)}`);
const now = TimestampSchema.make("2026-08-10T00:00:00.000Z");
const initialMemoryRevision = MemoryRevisionSchema.make(0);
const capabilities: PlatformCapabilities = {
  now: () => now,
  uuid: () => uuid,
  sha256: async () => digest("f"),
};
const task = (): CloudTask =>
  decode(CloudTaskSchema, {
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
  });

const request = (payload: Record<string, unknown>, token = "test-token"): Request =>
  new Request("https://cloud-task/v1/cloud-tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
const sendAndObserve = async (
  directory: InMemoryCloudTaskDirectory,
  message: unknown,
  messageId: string,
): Promise<unknown> => {
  await directory.fetch(request({ _tag: "Spawn", sessionId: task().sessionId, task: task() }));
  const accepted = await directory.fetch(
    request({
      _tag: "Send",
      sessionId: task().sessionId,
      messageId,
      message,
    }),
  );
  expect(accepted.status).toBe(200);
  const observed = await directory.fetch(
    request({
      _tag: "Observe",
      sessionId: task().sessionId,
      afterCursor: 0,
    }),
  );
  expect(observed.status).toBe(200);
  const body = (await observed.json()) as {
    readonly observations: readonly { readonly message?: unknown }[];
  };
  return body.observations[0]?.message;
};

describe("authenticated CloudTask routing", () => {
  it("deduplicates spawn and send by caller-minted identities", async () => {
    const directory = new InMemoryCloudTaskDirectory(capabilities);
    const first = await directory.fetch(
      request({ _tag: "Spawn", sessionId: task().sessionId, task: task() }),
    );
    const second = await directory.fetch(
      request({ _tag: "Spawn", sessionId: task().sessionId, task: task() }),
    );
    expect(await first.json()).toEqual(await second.json());

    const send = {
      _tag: "Send",
      sessionId: task().sessionId,
      messageId: `msg_${uuid}`,
      message: "continue",
    };
    const accepted = await directory.fetch(request(send));
    const duplicate = await directory.fetch(request(send));
    expect(await accepted.json()).toEqual(await duplicate.json());
  });

  it("rejects a valid sessionId without caller authentication", async () => {
    const directory = new InMemoryCloudTaskDirectory(capabilities);
    const response = await directory.fetch(
      request({ _tag: "Result", sessionId: task().sessionId }, "wrong-token"),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a route session that differs from the decoded task", async () => {
    const directory = new InMemoryCloudTaskDirectory(capabilities);
    const response = await directory.fetch(
      request({
        _tag: "Spawn",
        sessionId: "ses_00000000-0000-4000-8000-000000000099",
        task: task(),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ _tag: "InvalidRequest" });
  });
});

describe("strict provider JSON boundaries", () => {
  it("rejects malformed CloudTask success envelopes", async () => {
    const client = new CloudflareCloudTaskClient(
      {
        fetch: async () =>
          Response.json({
            _tag: "Spawned",
            admission: { unexpected: true },
          }),
      } as unknown as Fetcher,
      "test-token",
    );
    await expect(client.spawn(task().sessionId, task())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("preserves typed terminal state from CloudTask failures", async () => {
    const state = {
      _tag: "Failed",
      sessionId: task().sessionId,
      cursor: 3,
      failedAt: now,
      reason: "worker failed",
    } as const;
    const client = new CloudflareCloudTaskClient(
      {
        fetch: async () =>
          Response.json(
            {
              _tag: "SessionTerminal",
              reason: "Session is terminal",
              state,
            },
            { status: 409 },
          ),
      } as unknown as Fetcher,
      "test-token",
    );
    const error = await client.result(task().sessionId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SessionTerminalError);
    expect((error as SessionTerminalError).details["state"]).toEqual(state);
  });

  it("rejects malformed Project Memory success envelopes", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json({
            _tag: "ProjectMemoryRead",
            facts: [],
            unexpected: true,
          }),
      }),
    } as unknown as DurableObjectNamespace;
    const memory = new CloudflareProjectMemory(namespace, task().projectId, {
      sessionId: task().sessionId,
    });
    await expect(memory.readContext(initialMemoryRevision)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
describe("CloudTask Send JSON values", () => {
  it("round-trips object values through request and observe", async () => {
    const value = { nested: { enabled: true }, values: [1, null] };
    await expect(
      sendAndObserve(new InMemoryCloudTaskDirectory(capabilities), value, `msg_${uuid}`),
    ).resolves.toEqual(value);
  });

  it("round-trips array values through request and observe", async () => {
    const value = ["alpha", false, { count: 2 }];
    await expect(
      sendAndObserve(new InMemoryCloudTaskDirectory(capabilities), value, `msg_${uuid}`),
    ).resolves.toEqual(value);
  });

  it("round-trips boolean values through request and observe", async () => {
    const value = false;
    await expect(
      sendAndObserve(new InMemoryCloudTaskDirectory(capabilities), value, `msg_${uuid}`),
    ).resolves.toBe(value);
  });

  it("round-trips number values through request and observe", async () => {
    const value = 42.5;
    await expect(
      sendAndObserve(new InMemoryCloudTaskDirectory(capabilities), value, `msg_${uuid}`),
    ).resolves.toBe(value);
  });

  it("round-trips null values through request and observe", async () => {
    await expect(
      sendAndObserve(new InMemoryCloudTaskDirectory(capabilities), null, `msg_${uuid}`),
    ).resolves.toBeNull();
  });
});

const provenance = () =>
  decode(ProjectMemoryProvenanceSchema, {
    _tag: "ProjectMemoryProvenance",
    source: "worker",
    observedAt: "2026-08-10T00:00:00.000Z",
  });

describe("Project Memory authority", () => {
  it("rejects stale acceptance while preserving pinned reads", () => {
    const memory = new ProjectMemoryState(task().projectId, capabilities);
    const source = provenance();
    const proposal = memory.proposeMemory(
      task().sessionId,
      initialMemoryRevision,
      "build uses Bun",
      source,
    );
    const revision = memory.acceptMemory(proposal.proposalId, initialMemoryRevision);
    expect(memory.readContext(initialMemoryRevision)).toHaveLength(0);
    expect(memory.readContext(revision.memoryRevision)).toHaveLength(1);
    const stale = memory.proposeMemory(
      task().sessionId,
      initialMemoryRevision,
      "stale claim",
      source,
    );
    expect(() => memory.acceptMemory(stale.proposalId, initialMemoryRevision)).toThrow(
      /Expected memory revision/iu,
    );
  });

  it("separates worker proposal authority from coordinator acceptance authority", async () => {
    const worker = new CloudflareProjectMemory(undefined, task().projectId, {
      sessionId: task().sessionId,
    });
    const coordinator = new CloudflareProjectMemory(undefined, task().projectId, {
      coordinatorSecret: "coordinator-secret",
    });
    await expect(
      worker.acceptMemory("mpp_00000000-0000-4000-8000-000000000001", initialMemoryRevision),
    ).rejects.toThrow(/cannot accept Project Memory proposals/iu);
    await expect(
      coordinator.proposeMemory(initialMemoryRevision, "claim", provenance()),
    ).rejects.toThrow(/cannot accept Project Memory proposals/iu);
  });
  it("does not advance the cached revision after persistence fails", async () => {
    let persisted: unknown;
    let failWrites = false;
    const fakeState = {
      storage: {
        get: async () => persisted,
        put: async (_key: string, value: unknown) => {
          if (failWrites) throw new Error("storage unavailable");
          persisted = value;
        },
      },
    } as unknown as ConstructorParameters<typeof ProjectMemoryDurableObject>[0];
    const memory = new ProjectMemoryDurableObject(
      fakeState,
      { PROJECT_MEMORY_COORDINATOR_SECRET: "coordinator-secret" },
      capabilities,
    );
    const identity = {
      "content-type": "application/json",
      "X-Project-Identity": task().projectId,
    };
    const proposalResponse = await memory.fetch(
      new Request("https://project-memory/propose", {
        method: "POST",
        headers: {
          ...identity,
          "X-Cloud-Task-Session": task().sessionId,
        },
        body: JSON.stringify({
          expectedRevision: 0,
          claim: "persisted claim",
          provenance: {
            _tag: "ProjectMemoryProvenance",
            source: "worker",
            observedAt: "2026-08-10T00:00:00.000Z",
          },
        }),
      }),
    );
    expect(proposalResponse.status).toBe(200);
    const proposal = (await proposalResponse.json()) as { readonly proposalId: string };

    failWrites = true;
    const failedAcceptance = await memory.fetch(
      new Request("https://project-memory/accept", {
        method: "POST",
        headers: {
          ...identity,
          "X-Project-Memory-Coordinator": "coordinator-secret",
        },
        body: JSON.stringify({
          proposalId: proposal.proposalId,
          expectedRevision: 0,
        }),
      }),
    );
    expect(failedAcceptance.ok).toBe(false);

    failWrites = false;
    const readAfterFailure = await memory.fetch(
      new Request("https://project-memory/read", {
        method: "POST",
        headers: identity,
        body: JSON.stringify({ atRevision: 1, query: "" }),
      }),
    );
    expect(readAfterFailure.status).toBe(409);
    expect(await readAfterFailure.json()).toMatchObject({
      _tag: "MemoryRevisionUnavailable",
    });
  });
});

describe("Session terminal and repository refs", () => {
  it("gives cancellation precedence over late completion and records side effects", () => {
    const session = new SessionState(task(), capabilities);
    session.start();
    session.requestCancellation("operator stop");
    session.recordCandidate(
      "b".repeat(40),
      sessionRefs(task().projectId, task().sessionId).candidate,
    );
    expect(session.complete({ _tag: "CompletedResult" })._tag).toBe("Cancelled");
    expect(session.snapshot.sideEffects.some((effect) => effect.kind === "candidate")).toBe(true);
  });

  it("derives distinct WIP and candidate refs", () => {
    const refs = sessionRefs(task().projectId, task().sessionId);
    expect(refsAreDistinct(refs)).toBe(true);
    expect(refs.wip.endsWith("/wip")).toBe(true);
    expect(refs.candidate.endsWith("/wip")).toBe(false);
  });
  it("rejects a malformed terminal completion", () => {
    const session = new SessionState(task(), capabilities);
    session.start();
    expect(() => session.complete({ _tag: "CompletedResult" })).toThrow();
  });

  it("rejects a persisted Session with a malformed terminal result", () => {
    const persisted = new SessionState(task(), capabilities).snapshot;
    const malformed = {
      ...persisted,
      status: "completed",
      terminalResult: {
        _tag: "Completed",
        sessionId: task().sessionId,
        result: { _tag: "CompletedResult" },
      },
    } as unknown as SessionSnapshot;
    expect(() => new SessionState(task(), capabilities, malformed)).toThrow();
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
      verifyDependencyCache(
        manifest,
        {
          runtimeDigest: digest("1"),
          platformDigest: digest("2"),
          imageDigest: digest("3"),
          repositoryDigest: digest("4"),
          lockfileDigest: digest("5"),
        },
        new TextEncoder().encode("wrong"),
        capabilities,
      ),
    ).rejects.toBeInstanceOf(CacheDigestMismatchError);
  });

  it("does not claim provider success when GitHub transport is absent", async () => {
    const publisher = new TrustedRepositoryPublisher(undefined, { now: () => now });
    const grant = makeRepositoryGrant({
      grantId: `grt_${uuid}`,
      sessionId: task().sessionId,
      projectId: task().projectId,
      repository: { owner: "org", name: "repo" },
      baseCommit: task().baseCommit,
      writablePaths: ["packages/**"],
      expiresAt: "2099-08-11T00:00:00.000Z",
      issuedAt: now,
    });
    await expect(publisher.checkout(grant, task().sessionId)).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
    });
  });
});

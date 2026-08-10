import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type {
  ArtifactReceipt,
  ContentManifestEntry,
  EffectId,
  SessionId,
  SessionStartSpec,
  Sha256Digest,
  WorkspaceReady,
} from "@work-engine/protocol";
import {
  ArtifactReceiptSchema,
  ContentManifestSchema,
  EffectIdSchema,
  ProjectIdSchema,
  ResourceIdSchema,
  SessionIdSchema,
  WorkIdSchema,
  AgentProfileIdSchema,
  digestManifest,
  sha256,
} from "@work-engine/protocol";
import type { ArtifactError, ArtifactStore } from "@work-engine/runtime";
import {
  InMemoryReadinessProbe,
  MemoryStartClaimStore,
  SessionHostService,
  type SessionHostLifecycleCallbacks,
  type SessionProcess,
  type SessionProcessController,
  WorkspaceCustodian,
  ensurePrivateRuntime,
  scrubSessionEnvironment,
  validateWritableScope,
} from "@work-engine/session-host";

const projectId = ProjectIdSchema.make("prj_00000000-0000-4000-8000-000000000001");
const workId = WorkIdSchema.make("wrk_00000000-0000-4000-8000-000000000002");
const profileId = AgentProfileIdSchema.make("prf_00000000-0000-4000-8000-000000000003");
const resourceId = ResourceIdSchema.make("res_00000000-0000-4000-8000-000000000004");
const ready: WorkspaceReady = {
  _tag: "WorkspaceReady",
  instanceId: "instance-a",
  containerGeneration: "generation-a",
  imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  readyAt: "2026-08-10T00:00:00.000Z",
};

const specFor = (sessionId: SessionId, effectId: EffectId): SessionStartSpec => ({
  _tag: "SessionStartSpec",
  sessionId,
  effectId,
  projectId,
  workId,
  profileId,
  attempt: 0,
  deadline: "2099-08-10T00:00:00.000Z",
  outputLimit: 32_000,
  toolBudget: 100,
  workspaceLease: {
    _tag: "WorkspaceLease",
    resourceId,
    sessionId,
    mode: "write",
    acquiredAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2099-08-10T00:00:00.000Z",
    effectId,
  },
});

class FakeController implements SessionProcessController {
  starts = 0;
  readonly processes = new Map<string, SessionProcess>();
  readonly cancelled: SessionId[] = [];
  readonly exited = new Set<SessionId>();

  findExisting(claim: { readonly launchId: string }): Promise<SessionProcess | undefined> {
    return Promise.resolve(this.processes.get(claim.launchId));
  }

  spawn(
    spec: SessionStartSpec,
    launchId: string,
    processReference: string,
  ): Promise<SessionProcess> {
    this.starts += 1;
    const process: SessionProcess = {
      reference: processReference,
      launchId,
      sessionId: spec.sessionId,
      startedAt: "2026-08-10T00:00:00.000Z",
    };
    this.processes.set(launchId, process);
    return Promise.resolve(process);
  }

  cancel(sessionId: SessionId): Promise<void> {
    this.cancelled.push(sessionId);
    this.exited.add(sessionId);
    return Promise.resolve();
  }

  isExited(sessionId: SessionId): Promise<boolean> {
    return Promise.resolve(this.exited.has(sessionId));
  }
}

const hostFor = (
  controller: FakeController,
  lifecycle?: SessionHostLifecycleCallbacks,
): SessionHostService =>
  new SessionHostService({
    claims: new MemoryStartClaimStore(),
    processController: controller,
    readiness: new InMemoryReadinessProbe(ready),
    ...(lifecycle === undefined ? {} : { lifecycle }),
  });

it("returns the identical receipt and one process for duplicate start delivery", async () => {
  const controller = new FakeController();
  const host = hostFor(controller);
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000005");
  const effectId = EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000006");
  const spec = specFor(sessionId, effectId);
  const first = await Effect.runPromise(host.start(spec));
  const duplicate = await Effect.runPromise(host.start(spec));
  expect(duplicate).toEqual(first);
  expect(controller.starts).toBe(1);
});

it("reconciles a persisted claim without spawning a second OMP", async () => {
  const controller = new FakeController();
  const claims = new MemoryStartClaimStore();
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000007");
  const effectId = EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000008");
  const spec = specFor(sessionId, effectId);
  const claim = {
    _tag: "StartClaim" as const,
    key: `${sessionId}:${effectId}`,
    launchId: effectId,
    sessionId,
    effectId,
    spec,
    receipt: {
      _tag: "SessionHostReceipt" as const,
      sessionId,
      effectId,
      acceptedAt: "2026-08-10T00:00:00.000Z",
      processReference: `omp:${sessionId}:${effectId}`,
    },
    state: "spawn_requested" as const,
    requestedAt: "2026-08-10T00:00:00.000Z",
    processReference: `omp:${sessionId}:${effectId}`,
  };
  await claims.put(claim);
  controller.processes.set(effectId, {
    reference: claim.processReference,
    launchId: effectId,
    sessionId,
    startedAt: "2026-08-10T00:00:00.000Z",
  });
  const host = new SessionHostService({
    claims,
    processController: controller,
    readiness: new InMemoryReadinessProbe(ready),
  });
  const receipt = await Effect.runPromise(host.start(spec));
  expect(receipt).toEqual(claim.receipt);
  expect(controller.starts).toBe(0);
});

it("scrubs Herdr variables and keeps the trusted runtime private", async () => {
  const environment = scrubSessionEnvironment({
    HERDR_ENV: "1",
    HERDR_BIN_PATH: "/bad",
    HERDR_SOCKET_PATH: "/bad.sock",
    HERDR_PANE_ID: "p",
    PATH: "/usr/bin",
  });
  expect(environment).toEqual({ PATH: "/usr/bin" });
  const root = await mkdtemp(join(tmpdir(), "work-engine-runtime-"));
  await ensurePrivateRuntime(root, join(root, "missing.sock"));
  expect((await stat(root)).mode & 0o777).toBe(0o700);
});

it("enforces first-terminal-wins across cancellation and completion", async () => {
  const controller = new FakeController();
  const host = hostFor(controller);
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000009");
  const spec = specFor(sessionId, EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000010"));
  await Effect.runPromise(host.start(spec));
  const [cancel, complete] = await Promise.all([
    Effect.runPromise(host.cancel(sessionId, "operator-cancelled")),
    Effect.runPromise(host.reportTerminal(sessionId, "completed", "done")),
  ]);
  expect(cancel).toEqual(complete);
  const snapshot = await host.snapshot();
  expect(snapshot.claims[0]?.terminalStatus).toBe("interrupted");
});

it("reports process loss as an interrupted Session", async () => {
  const controller = new FakeController();
  const host = hostFor(controller);
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000011");
  await Effect.runPromise(
    host.start(specFor(sessionId, EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000012"))),
  );
  await Effect.runPromise(host.observeProcessLoss(sessionId));
  expect((await host.snapshot()).claims[0]?.terminalStatus).toBe("interrupted");
});

it("flushes frozen work and terminal reports before SIGTERM shutdown", async () => {
  const events: string[] = [];
  const controller = new FakeController();
  const host = new SessionHostService({
    claims: new MemoryStartClaimStore(),
    processController: controller,
    readiness: new InMemoryReadinessProbe(ready),
    lifecycle: {
      flushPending: async () => events.push("flush"),
      onTerminal: async () => events.push("terminal"),
    },
  });
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000013");
  await Effect.runPromise(
    host.start(specFor(sessionId, EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000014"))),
  );
  await host.shutdown("sigterm");
  expect(events).toEqual(["flush", "terminal", "flush"]);
});

it("rejects candidate paths outside the writable scope", () => {
  expect(() =>
    validateWritableScope(["src/greeting.ts", "README.md"], ["src/greeting.ts"]),
  ).toThrow(/README/);
});

it("keeps a finalized candidate immutable and records host check provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-engine-custody-"));
  const files = new Map<string, Uint8Array>([
    [
      "package.json",
      new TextEncoder().encode('{"scripts":{"check":"bun test test/greeting.test.ts"}}\n'),
    ],
    [
      "src/greeting.ts",
      new TextEncoder().encode(
        "export const greeting = (name: string): string => `Hello ${name}`;\n",
      ),
    ],
    [
      "test/greeting.test.ts",
      new TextEncoder().encode(
        'import { expect, test } from "bun:test";\ntest("greeting", () => expect(1).toBe(1));\n',
      ),
    ],
  ]);
  const artifactStore = new MemoryArtifactStore();
  await artifactStore.seed(files);
  const entries: ContentManifestEntry[] = [];
  for (const [path, bytes] of files)
    entries.push({ path, digest: await sha256(bytes), bytes: bytes.byteLength });
  const baseManifest = ContentManifestSchema.make({
    _tag: "ContentManifest",
    entries,
    digest: await digestManifest(entries),
  });
  const custody = new WorkspaceCustodian({
    baseRoot: join(root, "base"),
    worktreeRoot: join(root, "worktrees"),
    snapshotRoot: join(root, "snapshots"),
    artifactStore,
    baseManifest,
    requiredCheck: "bun run check",
    writableScope: ["src/greeting.ts"],
  });
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000015");
  const spec = specFor(sessionId, EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000016"));
  const session = await custody.prepare(spec);
  await writeFile(
    join(session.worktreePath, "src/greeting.ts"),
    "export const greeting = (name: string): string => `Hello, ${name}!`;\n",
  );
  await custody.markProcessExited(sessionId);
  const frozen = await custody.finalize({ sessionId, reason: "candidate.finalize" });
  expect(frozen.check.command).toBe("bun run check");
  expect(frozen.check.candidateDigest).toBe(frozen.candidateManifest.digest);
  await expect(custody.finalize({ sessionId, reason: "duplicate" })).rejects.toThrow(
    /already finalized/,
  );
});
it("observes a replaced container as a new readiness generation", async () => {
  const probe = new InMemoryReadinessProbe({ ...ready, containerGeneration: "generation-a" });
  const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000017");
  const lease = specFor(
    sessionId,
    EffectIdSchema.make("efx_00000000-0000-4000-8000-000000000018"),
  ).workspaceLease;
  const first = await probe.ensureReady(lease, 60_000);
  const replacement: WorkspaceReady = { ...first, containerGeneration: "generation-b" };
  expect(replacement.containerGeneration).not.toBe(first.containerGeneration);
});

class MemoryArtifactStore implements ArtifactStore {
  private readonly objects = new Map<
    Sha256Digest,
    { readonly bytes: Uint8Array; readonly mediaType: string }
  >();

  async seed(files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const bytes of files.values())
      await Effect.runPromise(this.put(bytes, "application/octet-stream"));
  }

  put(content: Uint8Array, mediaType: string): Effect.Effect<ArtifactReceipt, ArtifactError> {
    return Effect.promise(async () => {
      const digest = await sha256(content);
      this.objects.set(digest, { bytes: new Uint8Array(content), mediaType });
      return ArtifactReceiptSchema.make({
        _tag: "ArtifactReceipt",
        digest,
        bytes: content.byteLength,
        mediaType,
      });
    });
  }

  get(digest: Sha256Digest): Effect.Effect<Uint8Array, ArtifactError> {
    const object = this.objects.get(digest);
    return object === undefined
      ? Effect.fail({ _tag: "ArtifactMissing", digest } as ArtifactError)
      : Effect.succeed(new Uint8Array(object.bytes));
  }

  head(digest: Sha256Digest): Effect.Effect<ArtifactReceipt, ArtifactError> {
    const object = this.objects.get(digest);
    return object === undefined
      ? Effect.fail({ _tag: "ArtifactMissing", digest } as ArtifactError)
      : Effect.succeed(
          ArtifactReceiptSchema.make({
            _tag: "ArtifactReceipt",
            digest,
            bytes: object.bytes.byteLength,
            mediaType: object.mediaType,
          }),
        );
  }
}

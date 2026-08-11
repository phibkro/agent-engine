import { describe, expect, it } from "vitest";
import {
  EnvironmentCheckpointRequestSchema,
  EnvironmentCheckpointSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentPairingSchema,
  EnvironmentRecoverRequestSchema,
  EnvironmentDestroyRequestSchema,
  RuntimeVersionTupleSchema,
  Sha256DigestSchema,
  TimestampSchema,
  decodeUnknownStrict,
  type EnvironmentCheckpoint,
  type EnvironmentSnapshot,
} from "@work-engine/protocol";
import {
  EnvironmentCoordinator,
  InMemoryEnvironmentStore,
  type EnvironmentRuntime,
  type PlatformCapabilities,
} from "../src/index.ts";

const now = TimestampSchema.make("2026-08-10T00:00:00.000Z");
let uuidSequence = 1;
const capabilities: PlatformCapabilities = {
  now: () => now,
  uuid: () => `00000000-0000-4000-8000-${(uuidSequence++).toString(16).padStart(12, "0")}`,
  sha256: async () => Sha256DigestSchema.make(`sha256:${"a".repeat(64)}`),
};
const versions = decodeUnknownStrict(RuntimeVersionTupleSchema, {
  imageDigest: `sha256:${"a".repeat(64)}`,
  t3codeVersion: "0.9.0",
  sandboxSdkVersion: "0.12.5",
});
const request = decodeUnknownStrict(EnvironmentCreateRequestSchema, {
  _tag: "CreateEnvironment",
  commandId: "create-00000000-0000-4000-8000-000000000001",
  environmentId: "demo-environment",
  ownerId: "operator-1",
  repository: { owner: "example", name: "project" },
  baseCommit: "0".repeat(40),
  provider: "codex",
});

class RecordingRuntime implements EnvironmentRuntime {
  starts = 0;
  recoveries = 0;
  failCheckpoint = false;
  destroys = 0;
  failRecover = false;
  failInitialize = false;
  finalCheckpoint = false;
  checkpointCount = 0;
  deletedCheckpoints: string[] = [];

  async start(): Promise<{ readonly generationId: string }> {
    this.starts += 1;
    return { generationId: "sandbox-1" };
  }

  async initialize(): Promise<void> {
    if (this.failInitialize) throw new Error("initialization failed");
  }

  async waitUntilReady(): Promise<void> {}
  async isReady(): Promise<boolean> {
    return true;
  }
  async deleteCheckpoint(checkpoint: EnvironmentCheckpoint): Promise<void> {
    this.deletedCheckpoints.push(checkpoint.backup.id);
  }

  async mintPairing() {
    return decodeUnknownStrict(EnvironmentPairingSchema, {
      endpoint: "https://demo-environment.example.test",
      token: "pairing-token",
      expiresAt: "2026-08-10T00:10:00.000Z",
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ],
    });
  }

  async checkpoint(_snapshot?: EnvironmentSnapshot, options?: { readonly final?: boolean }) {
    this.finalCheckpoint = options?.final === true;
    if (this.failCheckpoint) throw new Error("capture failed");
    this.checkpointCount += 1;
    return decodeUnknownStrict(EnvironmentCheckpointSchema, {
      generation: 1,
      stateCapture: "quiesced",
      head: "1".repeat(40),
      versions,
      backup: {
        id: `backup-${String(this.checkpointCount)}`,
        dir: "/workspace/environment",
      },
      validated: true,
      createdAt: now,
    });
  }
  async recover() {
    this.recoveries += 1;
    if (this.failRecover) throw new Error("recovery failed");
    return { generationId: "sandbox-2" };
  }

  async destroy(): Promise<void> {
    this.destroys += 1;
  }
}

describe("Environment creation", () => {
  it("returns one durable result when the create command is retried", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });

    const first = await coordinator.create(request);
    const repeated = await coordinator.create(request);

    expect(repeated).toEqual(first);
    expect(first.snapshot.lifecycle).toBe("Ready");
    expect(first.snapshot.generation?.id).toBe("sandbox-1");
    expect(runtime.starts).toBe(1);
  });
  it("records a started generation and destroys it when initialization fails", async () => {
    const runtime = new RecordingRuntime();
    runtime.failInitialize = true;
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });

    await expect(coordinator.create(request)).rejects.toThrow("initialization failed");
    expect((await coordinator.inspect())?.generation?.id).toBe("sandbox-1");
    expect((await coordinator.inspect())?.lifecycle).toBe("Failed");
    expect(runtime.destroys).toBe(1);
  });

  it("checkpoints, replaces a lost Sandbox, and makes destruction terminal", async () => {
    const runtime = new RecordingRuntime();
    const store = new InMemoryEnvironmentStore();
    const coordinator = new EnvironmentCoordinator({
      store,
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);

    const checkpointed = await coordinator.checkpoint();
    expect(checkpointed.acceptedCheckpoint?.head).toBe("1".repeat(40));

    const recovered = await coordinator.recover(
      decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
        _tag: "RecoverEnvironment",
        commandId: "recover-00000000-0000-4000-8000-000000000001",
        environmentId: "demo-environment",
      }),
    );
    expect(recovered.generation?.id).toBe("sandbox-2");
    expect(recovered.retiredGenerationIds).toEqual(["sandbox-1"]);
    const retried = await coordinator.recover(
      decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
        _tag: "RecoverEnvironment",
        commandId: "recover-00000000-0000-4000-8000-000000000001",
        environmentId: "demo-environment",
      }),
    );
    expect(retried).toEqual(recovered);
    expect(runtime.recoveries).toBe(1);

    const destroyed = await coordinator.destroy(
      decodeUnknownStrict(EnvironmentDestroyRequestSchema, {
        _tag: "DestroyEnvironment",
        commandId: "destroy-00000000-0000-4000-8000-000000000001",
        environmentId: "demo-environment",
      }),
    );
    expect(destroyed.lifecycle).toBe("Destroyed");
    await expect(
      coordinator.recover(
        decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
          _tag: "RecoverEnvironment",
          commandId: "recover-00000000-0000-4000-8000-000000000002",
          environmentId: "demo-environment",
        }),
      ),
    ).rejects.toThrow();
  });

  it("keeps the last accepted checkpoint when a later capture fails", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);
    const accepted = await coordinator.checkpoint();
    runtime.failCheckpoint = true;
    await expect(coordinator.checkpoint()).rejects.toThrow("capture failed");
    expect((await coordinator.acceptedCheckpoint())?.backup.id).toBe(
      accepted.acceptedCheckpoint?.backup.id,
    );
    expect((await coordinator.inspect())?.lifecycle).toBe("Ready");
  });
  it("records checkpoint receipts only for explicitly supplied commands", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);

    const internal = await coordinator.checkpoint();
    expect(internal.commandReceipts).toHaveLength(1);

    const explicit = decodeUnknownStrict(EnvironmentCheckpointRequestSchema, {
      _tag: "CheckpointEnvironment",
      commandId: "checkpoint-00000000-0000-4000-8000-000000000001",
      environmentId: "demo-environment",
    });
    const publicCheckpoint = await coordinator.checkpoint(explicit);
    expect(publicCheckpoint.commandReceipts).toHaveLength(2);
    expect(publicCheckpoint.commandReceipts.at(-1)?.commandId).toBe(explicit.commandId);
  });

  it("exhausts checkpoint retries into Failed with explicit data-loss state", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);
    runtime.failCheckpoint = true;
    await expect(coordinator.checkpoint()).rejects.toThrow("capture failed");
    await expect(coordinator.checkpoint()).rejects.toThrow("capture failed");
    await expect(coordinator.checkpoint()).rejects.toThrow("capture failed");
    const failed = await coordinator.inspect();
    expect(failed?.lifecycle).toBe("Failed");
    expect(failed?.checkpointFailures).toBe(3);
    expect(failed?.checkpointRetryAt).toBeNull();
    expect(failed?.dataLossWarning).toBe(true);
  });

  it("retains only the two newest accepted checkpoints", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);
    await coordinator.checkpoint();
    await coordinator.checkpoint();
    const latest = await coordinator.checkpoint();
    expect(latest.retainedCheckpoints.map((checkpoint) => checkpoint.backup.id)).toEqual([
      "backup-2",
      "backup-3",
    ]);
    expect(runtime.deletedCheckpoints).toEqual(["backup-1"]);
  });
  it("exhausts recovery retries into Failed while preserving the accepted checkpoint", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);
    const checkpointed = await coordinator.checkpoint();
    runtime.failRecover = true;
    const recovery = decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
      _tag: "RecoverEnvironment",
      commandId: "recover-00000000-0000-4000-8000-000000000003",
      environmentId: "demo-environment",
    });
    await expect(coordinator.recover(recovery)).rejects.toThrow("recovery failed");
    await expect(coordinator.recover(recovery)).rejects.toThrow("recovery failed");
    await expect(coordinator.recover(recovery)).rejects.toThrow("recovery failed");
    const failed = await coordinator.inspect();
    expect(failed?.lifecycle).toBe("Failed");
    expect(failed?.recoveryFailures).toBe(3);
    expect(failed?.dataLossWarning).toBe(true);
    expect(failed?.acceptedCheckpoint?.backup.id).toBe(checkpointed.acceptedCheckpoint?.backup.id);
  });

  it("retains a Failed tombstone after final checkpoint failure and cleans up the runtime", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      capabilities,
    });
    await coordinator.create(request);
    runtime.failCheckpoint = true;

    const failed = await coordinator.destroy(
      decodeUnknownStrict(EnvironmentDestroyRequestSchema, {
        _tag: "DestroyEnvironment",
        commandId: "destroy-00000000-0000-4000-8000-000000000002",
        environmentId: "demo-environment",
      }),
    );

    expect(failed.lifecycle).toBe("Failed");
    expect(failed.generation?.id).toBe("sandbox-1");
    expect(runtime.finalCheckpoint).toBe(true);
    expect(runtime.destroys).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  EnvironmentCheckpointSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentPairingSchema,
  EnvironmentRecoverRequestSchema,
  EnvironmentDestroyRequestSchema,
  RuntimeVersionTupleSchema,
  decodeUnknownStrict,
} from "@work-engine/protocol";
import {
  EnvironmentCoordinator,
  InMemoryEnvironmentStore,
  type EnvironmentRuntime,
} from "../src/index.ts";

const now = "2026-08-10T00:00:00.000Z";
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

  async start(): Promise<{ readonly generationId: string }> {
    this.starts += 1;
    return { generationId: "sandbox-1" };
  }

  async initialize(): Promise<void> {}

  async waitUntilReady(): Promise<void> {}

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

  async checkpoint() {
    if (this.failCheckpoint) throw new Error("capture failed");
    return decodeUnknownStrict(EnvironmentCheckpointSchema, {
      generation: 1,
      stateCapture: "quiesced",
      head: "1".repeat(40),
      versions,
      backup: { id: "backup-1", dir: "/workspace/environment" },
      validated: true,
      createdAt: now,
    });
  }

  async recover() {
    this.recoveries += 1;
    return { generationId: "sandbox-2" };
  }

  async destroy(): Promise<void> {}
}

describe("Environment creation", () => {
  it("returns one durable result when the create command is retried", async () => {
    const runtime = new RecordingRuntime();
    const coordinator = new EnvironmentCoordinator({
      store: new InMemoryEnvironmentStore(),
      runtime,
      versions,
      now: () => now,
    });

    const first = await coordinator.create(request);
    const repeated = await coordinator.create(request);

    expect(repeated).toEqual(first);
    expect(first.snapshot.lifecycle).toBe("Ready");
    expect(first.snapshot.generation?.id).toBe("sandbox-1");
    expect(runtime.starts).toBe(1);
  });

  it("checkpoints, replaces a lost Sandbox, and makes destruction terminal", async () => {
    const runtime = new RecordingRuntime();
    const store = new InMemoryEnvironmentStore();
    const coordinator = new EnvironmentCoordinator({
      store,
      runtime,
      versions,
      now: () => now,
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
      now: () => now,
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
});

import {
  EnvironmentCheckpointSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentDestroyRequestSchema,
  EnvironmentPairingSchema,
  EnvironmentRecoverRequestSchema,
  RuntimeVersionTupleSchema,
  TimestampSchema,
  decodeUnknownStrict,
  type EnvironmentCheckpoint,
  type EnvironmentPairing,
  type EnvironmentSnapshot,
} from "../../packages/protocol/src/index.ts";
import {
  EnvironmentCoordinator,
  InMemoryEnvironmentStore,
  type EnvironmentRuntime,
} from "../../packages/cloudflare/src/environment.ts";
import { cloudflarePlatformCapabilities } from "../../packages/cloudflare/src/platform-capabilities.ts";

const timestamp = decodeUnknownStrict(TimestampSchema, "2026-08-10T00:00:00.000Z");
const versions = decodeUnknownStrict(RuntimeVersionTupleSchema, {
  imageDigest: `sha256:${"a".repeat(64)}`,
  t3codeVersion: "0.0.33",
  sandboxSdkVersion: "0.12.5",
});

class LocalTracerRuntime implements EnvironmentRuntime {
  generation = 0;
  checkpoints = 0;

  async start(): Promise<{ readonly generationId: string }> {
    this.generation += 1;
    return { generationId: `local-sandbox-${String(this.generation)}` };
  }

  async initialize(): Promise<void> {}
  async waitUntilReady(): Promise<void> {}
  async isReady(): Promise<boolean> {
    return true;
  }

  async deleteCheckpoint(): Promise<void> {}
  async mintPairing(): Promise<EnvironmentPairing> {
    return decodeUnknownStrict(EnvironmentPairingSchema, {
      endpoint: "https://local.invalid/v1/environments/local-tracer/connect",
      token: "local-pairing-token",
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

  async checkpoint(snapshot: EnvironmentSnapshot): Promise<EnvironmentCheckpoint> {
    this.checkpoints += 1;
    return decodeUnknownStrict(EnvironmentCheckpointSchema, {
      generation: snapshot.generation?.ordinal,
      stateCapture: "quiesced",
      head: "1".repeat(40),
      versions,
      backup: {
        id: `local-backup-${String(this.checkpoints)}`,
        dir: "/workspace/environment",
      },
      validated: true,
      createdAt: timestamp,
    });
  }

  async recover(): Promise<{ readonly generationId: string }> {
    this.generation += 1;
    return { generationId: `local-sandbox-${String(this.generation)}` };
  }

  async destroy(): Promise<void> {}
}

export interface LocalEnvironmentTracerEvidence {
  readonly _tag: "LocalEnvironmentTracerEvidence";
  readonly cloudflareDeployed: false;
  readonly lifecycle: ReadonlyArray<string>;
  readonly checkpointValidated: boolean;
  readonly generationReplaced: boolean;
  readonly destructionTerminal: boolean;
}

export const runLocalEnvironmentTracer = async (): Promise<LocalEnvironmentTracerEvidence> => {
  const runtime = new LocalTracerRuntime();
  const coordinator = new EnvironmentCoordinator({
    store: new InMemoryEnvironmentStore(),
    runtime,
    versions,
    capabilities: { ...cloudflarePlatformCapabilities, now: () => timestamp },
  });
  const lifecycle: string[] = [];
  const created = await coordinator.create(
    decodeUnknownStrict(EnvironmentCreateRequestSchema, {
      _tag: "CreateEnvironment",
      commandId: "create-00000000-0000-4000-8000-000000000003",
      environmentId: "local-tracer",
      ownerId: "operator-1",
      repository: { owner: "example", name: "project" },
      baseCommit: "0".repeat(40),
      provider: "codex",
    }),
  );
  lifecycle.push(created.snapshot.lifecycle);
  const checkpointed = await coordinator.checkpoint();
  lifecycle.push(checkpointed.lifecycle);
  const recovered = await coordinator.recover(
    decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
      _tag: "RecoverEnvironment",
      commandId: "recover-00000000-0000-4000-8000-000000000003",
      environmentId: "local-tracer",
    }),
  );
  lifecycle.push(recovered.lifecycle);
  const destroyed = await coordinator.destroy(
    decodeUnknownStrict(EnvironmentDestroyRequestSchema, {
      _tag: "DestroyEnvironment",
      commandId: "destroy-00000000-0000-4000-8000-000000000003",
      environmentId: "local-tracer",
    }),
  );
  lifecycle.push(destroyed.lifecycle);
  const recoveryRejected = await coordinator
    .recover(
      decodeUnknownStrict(EnvironmentRecoverRequestSchema, {
        _tag: "RecoverEnvironment",
        commandId: "recover-00000000-0000-4000-8000-000000000004",
        environmentId: "local-tracer",
      }),
    )
    .then(
      () => false,
      () => true,
    );

  return {
    _tag: "LocalEnvironmentTracerEvidence",
    cloudflareDeployed: false,
    lifecycle,
    checkpointValidated: checkpointed.acceptedCheckpoint?.validated === true,
    generationReplaced: recovered.retiredGenerationIds.includes(
      created.snapshot.generation?.id ?? "",
    ),
    destructionTerminal: destroyed.lifecycle === "Destroyed" && recoveryRejected,
  };
};

if (import.meta.main) {
  console.log(JSON.stringify(await runLocalEnvironmentTracer(), null, 2));
}

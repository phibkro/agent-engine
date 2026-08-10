import {
  EnvironmentCheckpointRequestSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentDestroyRequestSchema,
  EnvironmentPairingSchema,
  EnvironmentRecoverRequestSchema,
  EnvironmentSnapshotSchema,
  decodeUnknownStrict,
  type EnvironmentCheckpoint,
  type EnvironmentPairing,
  type EnvironmentSnapshot,
  type RuntimeVersionTuple,
} from "@work-engine/protocol";
import { InvalidRequestError } from "./errors.ts";

export interface EnvironmentStore {
  load(): Promise<EnvironmentSnapshot | undefined>;
  save(snapshot: EnvironmentSnapshot): Promise<void>;
}

export interface EnvironmentRuntime {
  start(input: {
    readonly environmentId: string;
    readonly generationOrdinal: number;
    readonly keepAlive: true;
  }): Promise<{ readonly generationId: string }>;
  initialize(input: {
    readonly repository: { readonly owner: string; readonly name: string };
    readonly baseCommit: string;
    readonly provider: "claude" | "codex";
  }): Promise<void>;
  waitUntilReady(): Promise<void>;
  mintPairing(input: { readonly environmentId: string }): Promise<EnvironmentPairing>;
  checkpoint(
    snapshot: EnvironmentSnapshot,
    options?: { readonly final?: boolean },
  ): Promise<EnvironmentCheckpoint>;
  isReady(generationId: string): Promise<boolean>;
  deleteCheckpoint(checkpoint: EnvironmentCheckpoint): Promise<void>;
  recover(input: {
    readonly snapshot: EnvironmentSnapshot;
    readonly checkpoint: EnvironmentCheckpoint;
    readonly generationOrdinal: number;
  }): Promise<{ readonly generationId: string }>;
  destroy(snapshot: EnvironmentSnapshot): Promise<void>;
}

export interface EnvironmentCoordinatorOptions {
  readonly store: EnvironmentStore;
  readonly runtime: EnvironmentRuntime;
  readonly versions: RuntimeVersionTuple;
  readonly now: () => string;
}

export interface EnvironmentCreated {
  readonly snapshot: EnvironmentSnapshot;
  readonly pairing: EnvironmentPairing;
}

const digestText = async (value: string): Promise<`sha256:${string}`> => {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const plusMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
const snapshot = (value: unknown): EnvironmentSnapshot => {
  try {
    return decodeUnknownStrict(EnvironmentSnapshotSchema, value);
  } catch {
    throw new InvalidRequestError("Persisted Environment snapshot is invalid");
  }
};

const pairing = (value: unknown): EnvironmentPairing =>
  decodeUnknownStrict(EnvironmentPairingSchema, value);

export class InMemoryEnvironmentStore implements EnvironmentStore {
  #snapshot: EnvironmentSnapshot | undefined;

  async load(): Promise<EnvironmentSnapshot | undefined> {
    return this.#snapshot === undefined ? undefined : snapshot(this.#snapshot);
  }

  async save(value: EnvironmentSnapshot): Promise<void> {
    this.#snapshot = snapshot(value);
  }
}

export class EnvironmentCoordinator {
  readonly #options: EnvironmentCoordinatorOptions;

  constructor(options: EnvironmentCoordinatorOptions) {
    this.#options = options;
  }

  async create(input: unknown): Promise<EnvironmentCreated> {
    const request = decodeUnknownStrict(EnvironmentCreateRequestSchema, input);
    const requestDigest = await digestText(JSON.stringify(request));
    const existing = await this.#options.store.load();
    if (existing !== undefined) {
      const receipt = existing.commandReceipts.find(
        (candidate) => candidate.commandId === request.commandId,
      );
      if (receipt === undefined || receipt.requestDigest !== requestDigest) {
        throw new InvalidRequestError("Environment already exists for a different create command");
      }
      if (
        typeof receipt.result === "object" &&
        receipt.result !== null &&
        "_tag" in receipt.result &&
        receipt.result["_tag"] === "EnvironmentCreateFailed"
      ) {
        throw new InvalidRequestError("Environment creation previously failed");
      }
      return {
        snapshot: existing,
        pairing: pairing(receipt.result),
      };
    }

    const createdAt = this.#options.now();
    const requested = snapshot({
      _tag: "EnvironmentSnapshot",
      environmentId: request.environmentId,
      ownerId: request.ownerId,
      repository: request.repository,
      baseCommit: request.baseCommit,
      provider: request.provider,
      lifecycle: "Starting",
      versions: this.#options.versions,
      generation: null,
      retiredGenerationIds: [],
      acceptedCheckpoint: null,
      dataLossWarning: false,
      retainedCheckpoints: [],
      checkpointFailures: 0,
      checkpointRetryAt: null,
      recoveryFailures: 0,
      recoveryRetryAt: null,
      recoveryRequest: null,
      commandReceipts: [],
      createdAt,
      lastActivityAt: createdAt,
      expiresAt: plusMilliseconds(createdAt, 8 * 60 * 60 * 1_000),
      inactivityDeadline: plusMilliseconds(createdAt, 30 * 60 * 1_000),
    });
    await this.#options.store.save(requested);

    let operation = requested;
    try {
      const generation = await this.#options.runtime.start({
        environmentId: request.environmentId,
        generationOrdinal: 1,
        keepAlive: true,
      });
      operation = snapshot({
        ...requested,
        generation: { id: generation.generationId, ordinal: 1 },
      });
      await this.#options.store.save(operation);
      await this.#options.runtime.initialize({
        repository: request.repository,
        baseCommit: request.baseCommit,
        provider: request.provider,
      });
      await this.#options.runtime.waitUntilReady();
      const mintedPairing = pairing(
        await this.#options.runtime.mintPairing({ environmentId: request.environmentId }),
      );
      const latest = await this.#requireEnvironment(request.environmentId);
      if (latest.lifecycle !== "Starting" || latest.generation?.id !== generation.generationId) {
        await this.#options.runtime.destroy(operation).catch(() => undefined);
        throw new InvalidRequestError("Environment creation was superseded");
      }
      const acceptedAt = this.#options.now();
      const ready = snapshot({
        ...operation,
        lifecycle: "Ready",
        commandReceipts: [
          {
            commandId: request.commandId,
            requestDigest,
            result: mintedPairing,
            acceptedAt,
          },
        ],
        lastActivityAt: acceptedAt,
        inactivityDeadline: plusMilliseconds(acceptedAt, 30 * 60 * 1_000),
      });
      await this.#options.store.save(ready);
      return { snapshot: ready, pairing: mintedPairing };
    } catch (cause) {
      await this.#options.runtime.destroy(operation).catch(() => undefined);
      const failedAt = this.#options.now();
      await this.#options.store.save(
        snapshot({
          ...operation,
          lifecycle: "Failed",
          commandReceipts: [
            ...operation.commandReceipts,
            {
              commandId: request.commandId,
              requestDigest,
              result: {
                _tag: "EnvironmentCreateFailed",
                reason: "Environment creation failed",
              },
              acceptedAt: failedAt,
            },
          ],
        }),
      );
      throw cause;
    }
  }

  async inspect(): Promise<EnvironmentSnapshot | undefined> {
    return this.#options.store.load();
  }
  async checkpoint(input?: unknown): Promise<EnvironmentSnapshot> {
    const current = await this.#requireSnapshot();
    const request = decodeUnknownStrict(
      EnvironmentCheckpointRequestSchema,
      input === undefined
        ? {
            _tag: "CheckpointEnvironment",
            commandId: `checkpoint-${crypto.randomUUID()}`,
            environmentId: current.environmentId,
          }
        : input,
    );
    if (current.environmentId !== request.environmentId) {
      throw new InvalidRequestError("Environment identifier does not match this coordinator");
    }
    const requestDigest = await digestText(JSON.stringify(request));
    const existingReceipt = current.commandReceipts.find(
      (receipt) => receipt.commandId === request.commandId,
    );
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestDigest !== requestDigest) {
        throw new InvalidRequestError(
          "Checkpoint command identifier was reused with different input",
        );
      }
      return current;
    }
    if (current.lifecycle !== "Ready") {
      throw new InvalidRequestError("Only a Ready Environment can checkpoint");
    }
    const checkpointing = snapshot({ ...current, lifecycle: "Checkpointing" });
    await this.#options.store.save(checkpointing);
    try {
      const acceptedCheckpoint = await this.#options.runtime.checkpoint(checkpointing);
      const latest = await this.#requireSnapshot();
      if (
        latest.lifecycle !== "Checkpointing" ||
        latest.generation?.id !== checkpointing.generation?.id
      ) {
        throw new InvalidRequestError("Checkpoint was superseded");
      }
      const candidates = [
        ...checkpointing.retainedCheckpoints,
        ...(checkpointing.acceptedCheckpoint === null ? [] : [checkpointing.acceptedCheckpoint]),
        acceptedCheckpoint,
      ];
      const distinct = [
        ...new Map(
          candidates.map((checkpoint) => [checkpoint.backup.id, checkpoint] as const),
        ).values(),
      ];
      const retainedCheckpoints = distinct.slice(-2);
      const superseded = distinct.slice(0, -2);
      const acceptedAt = this.#options.now();
      const ready = snapshot({
        ...checkpointing,
        lifecycle: "Ready",
        acceptedCheckpoint,
        retainedCheckpoints,
        dataLossWarning: false,
        checkpointFailures: 0,
        checkpointRetryAt: null,
        commandReceipts: [
          ...current.commandReceipts,
          {
            commandId: request.commandId,
            requestDigest,
            result: {
              _tag: "EnvironmentCheckpointed",
              lifecycle: "Ready",
              checkpoint: acceptedCheckpoint,
            },
            acceptedAt,
          },
        ],
        lastActivityAt: acceptedAt,
      });
      await this.#options.store.save(ready);
      await Promise.all(
        superseded.map((checkpoint) =>
          this.#options.runtime.deleteCheckpoint(checkpoint).catch(() => undefined),
        ),
      );
      return ready;
    } catch (cause) {
      const latest = await this.#requireSnapshot();
      if (latest.lifecycle === "Checkpointing") {
        const checkpointFailures = current.checkpointFailures + 1;
        const failed = checkpointFailures >= 3;
        const failedAt = this.#options.now();
        await this.#options.store.save(
          snapshot({
            ...current,
            lifecycle: failed ? "Failed" : "Ready",
            dataLossWarning: true,
            checkpointFailures,
            checkpointRetryAt: failed ? null : plusMilliseconds(failedAt, 5 * 60 * 1_000),
            ...(failed ? { inactivityDeadline: failedAt } : {}),
          }),
        );
      }
      throw cause;
    }
  }
  async recover(input: unknown): Promise<EnvironmentSnapshot> {
    const request = decodeUnknownStrict(EnvironmentRecoverRequestSchema, input);
    const current = await this.#requireEnvironment(request.environmentId);
    if (current.lifecycle === "Destroyed" || current.lifecycle === "Destroying") {
      throw new InvalidRequestError("Destroyed Environments cannot recover");
    }
    if (current.acceptedCheckpoint === null) {
      throw new InvalidRequestError("Environment has no accepted checkpoint");
    }
    if (current.generation === null) {
      throw new InvalidRequestError("Environment has no generation to replace");
    }

    const requestDigest = await digestText(JSON.stringify(request));
    if (current.lifecycle !== "Ready" && current.lifecycle !== "Failed") {
      throw new InvalidRequestError("Environment recovery is already in progress");
    }
    const existingReceipt = current.commandReceipts.find(
      (receipt) => receipt.commandId === request.commandId,
    );
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestDigest !== requestDigest) {
        throw new InvalidRequestError("Recover command identifier was reused with different input");
      }
      return current;
    }

    const recovering = snapshot({ ...current, lifecycle: "Recovering", recoveryRequest: request });
    await this.#options.store.save(recovering);
    try {
      const ordinal = current.generation.ordinal + 1;
      const replacement = await this.#options.runtime.recover({
        snapshot: recovering,
        checkpoint: current.acceptedCheckpoint,
        generationOrdinal: ordinal,
      });
      const latest = await this.#requireEnvironment(request.environmentId);
      if (
        latest.lifecycle !== "Recovering" ||
        latest.generation?.id !== recovering.generation?.id
      ) {
        await this.#options.runtime
          .destroy(
            snapshot({
              ...recovering,
              generation: { id: replacement.generationId, ordinal },
              retiredGenerationIds: [...recovering.retiredGenerationIds, current.generation.id],
            }),
          )
          .catch(() => undefined);
        throw new InvalidRequestError("Environment recovery was superseded");
      }
      const acceptedAt = this.#options.now();
      const ready = snapshot({
        ...recovering,
        lifecycle: "Ready",
        generation: { id: replacement.generationId, ordinal },
        retiredGenerationIds: [...current.retiredGenerationIds, current.generation.id],
        commandReceipts: [
          ...current.commandReceipts,
          {
            commandId: request.commandId,
            requestDigest,
            result: { generationId: replacement.generationId, lifecycle: "Ready" },
            acceptedAt,
          },
        ],
        lastActivityAt: acceptedAt,
        inactivityDeadline: plusMilliseconds(acceptedAt, 30 * 60 * 1_000),
        recoveryFailures: 0,
        recoveryRetryAt: null,
        recoveryRequest: null,
      });
      await this.#options.store.save(ready);
      return ready;
    } catch (cause) {
      const latest = await this.#requireEnvironment(request.environmentId);
      if (latest.lifecycle === "Recovering") {
        const recoveryFailures = current.recoveryFailures + 1;
        const failed = recoveryFailures >= 3;
        const failedAt = this.#options.now();
        await this.#options.store.save(
          snapshot({
            ...recovering,
            lifecycle: failed ? "Failed" : "Ready",
            dataLossWarning: true,
            recoveryFailures,
            recoveryRetryAt: failed ? null : plusMilliseconds(failedAt, 5 * 60 * 1_000),
            recoveryRequest: request,
            ...(failed ? { inactivityDeadline: failedAt } : {}),
          }),
        );
      }
      throw cause;
    }
  }

  async destroy(input: unknown): Promise<EnvironmentSnapshot> {
    const request = decodeUnknownStrict(EnvironmentDestroyRequestSchema, input);
    const current = await this.#requireEnvironment(request.environmentId);
    const requestDigest = await digestText(JSON.stringify(request));
    const existingReceipt = current.commandReceipts.find(
      (receipt) => receipt.commandId === request.commandId,
    );
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestDigest !== requestDigest) {
        throw new InvalidRequestError("Destroy command identifier was reused with different input");
      }
      return current;
    }
    if (current.lifecycle === "Destroyed") return current;

    let cleanup = snapshot({ ...current, lifecycle: "Destroying" });
    await this.#options.store.save(cleanup);
    let finalCheckpointFailed = false;
    if (current.lifecycle === "Ready") {
      try {
        const acceptedCheckpoint = await this.#options.runtime.checkpoint(cleanup, {
          final: true,
        });
        cleanup = snapshot({ ...cleanup, acceptedCheckpoint });
        await this.#options.store.save(cleanup);
      } catch {
        finalCheckpointFailed = true;
        const failedAt = this.#options.now();
        cleanup = snapshot({
          ...cleanup,
          lifecycle: "Failed",
          dataLossWarning: true,
          checkpointRetryAt: null,
          inactivityDeadline: failedAt,
          commandReceipts: [
            ...current.commandReceipts,
            {
              commandId: request.commandId,
              requestDigest,
              result: {
                _tag: "EnvironmentDestroyFailed",
                lifecycle: "Failed",
                reason: "Final checkpoint failed",
                dataLossWarning: true,
              },
              acceptedAt: failedAt,
            },
          ],
        });
        await this.#options.store.save(cleanup);
      }
    }
    try {
      await this.#options.runtime.destroy(cleanup);
    } catch (cause) {
      if (finalCheckpointFailed) {
        await this.#options.store.save(cleanup);
        return cleanup;
      }
      const failedAt = this.#options.now();
      const failed = snapshot({
        ...cleanup,
        lifecycle: "Failed",
        dataLossWarning: true,
        inactivityDeadline: failedAt,
        commandReceipts: [
          ...current.commandReceipts,
          {
            commandId: request.commandId,
            requestDigest,
            result: {
              _tag: "EnvironmentDestroyFailed",
              lifecycle: "Failed",
              reason: "Environment cleanup failed",
              dataLossWarning: true,
            },
            acceptedAt: failedAt,
          },
        ],
      });
      await this.#options.store.save(failed);
      throw cause;
    }
    if (finalCheckpointFailed) return cleanup;
    const acceptedAt = this.#options.now();
    const destroyed = snapshot({
      ...cleanup,
      lifecycle: "Destroyed",
      generation: null,
      acceptedCheckpoint: null,
      retiredGenerationIds:
        current.generation === null
          ? current.retiredGenerationIds
          : [...current.retiredGenerationIds, current.generation.id],
      commandReceipts: [
        ...current.commandReceipts,
        {
          commandId: request.commandId,
          requestDigest,
          result: { lifecycle: "Destroyed" },
          acceptedAt,
        },
      ],
    });
    await this.#options.store.save(destroyed);
    return destroyed;
  }

  async #requireSnapshot(): Promise<EnvironmentSnapshot> {
    const current = await this.#options.store.load();
    if (current === undefined) throw new InvalidRequestError("Environment does not exist");
    return current;
  }

  async recordActivity(): Promise<EnvironmentSnapshot> {
    const current = await this.#requireSnapshot();
    if (current.lifecycle !== "Ready") return current;
    const lastActivityAt = this.#options.now();
    const updated = snapshot({
      ...current,
      dataLossWarning: true,
      lastActivityAt,
      inactivityDeadline: plusMilliseconds(lastActivityAt, 30 * 60 * 1_000),
    });
    await this.#options.store.save(updated);
    return updated;
  }

  async #requireEnvironment(environmentId: string): Promise<EnvironmentSnapshot> {
    const current = await this.#requireSnapshot();
    if (current.environmentId !== environmentId) {
      throw new InvalidRequestError("Environment identifier does not match this coordinator");
    }
    return current;
  }

  async acceptedCheckpoint(): Promise<EnvironmentCheckpoint | null> {
    return (await this.#options.store.load())?.acceptedCheckpoint ?? null;
  }
}

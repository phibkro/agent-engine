import {
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
  checkpoint(snapshot: EnvironmentSnapshot): Promise<EnvironmentCheckpoint>;
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

const snapshot = (value: unknown): EnvironmentSnapshot =>
  decodeUnknownStrict(EnvironmentSnapshotSchema, value);

const pairing = (value: unknown): EnvironmentPairing =>
  decodeUnknownStrict(EnvironmentPairingSchema, value);

export class InMemoryEnvironmentStore implements EnvironmentStore {
  #snapshot: EnvironmentSnapshot | undefined;

  async load(): Promise<EnvironmentSnapshot | undefined> {
    return this.#snapshot;
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
      commandReceipts: [],
      createdAt,
      lastActivityAt: createdAt,
      expiresAt: plusMilliseconds(createdAt, 8 * 60 * 60 * 1_000),
      inactivityDeadline: plusMilliseconds(createdAt, 30 * 60 * 1_000),
    });
    await this.#options.store.save(requested);

    try {
      const generation = await this.#options.runtime.start({
        environmentId: request.environmentId,
        generationOrdinal: 1,
        keepAlive: true,
      });
      await this.#options.runtime.initialize({
        repository: request.repository,
        baseCommit: request.baseCommit,
        provider: request.provider,
      });
      await this.#options.runtime.waitUntilReady();
      const mintedPairing = pairing(
        await this.#options.runtime.mintPairing({ environmentId: request.environmentId }),
      );
      const acceptedAt = this.#options.now();
      const ready = snapshot({
        ...requested,
        lifecycle: "Ready",
        generation: { id: generation.generationId, ordinal: 1 },
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
      await this.#options.store.save(snapshot({ ...requested, lifecycle: "Failed" }));
      throw cause;
    }
  }

  async inspect(): Promise<EnvironmentSnapshot | undefined> {
    return this.#options.store.load();
  }
  async checkpoint(): Promise<EnvironmentSnapshot> {
    const current = await this.#requireSnapshot();
    if (current.lifecycle !== "Ready") {
      throw new InvalidRequestError("Only a Ready Environment can checkpoint");
    }
    const checkpointing = snapshot({ ...current, lifecycle: "Checkpointing" });
    await this.#options.store.save(checkpointing);
    try {
      const acceptedCheckpoint = await this.#options.runtime.checkpoint(checkpointing);
      const ready = snapshot({
        ...checkpointing,
        lifecycle: "Ready",
        acceptedCheckpoint,
        lastActivityAt: this.#options.now(),
      });
      await this.#options.store.save(ready);
      return ready;
    } catch (cause) {
      await this.#options.store.save(snapshot({ ...current, lifecycle: "Ready" }));
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
    const existingReceipt = current.commandReceipts.find(
      (receipt) => receipt.commandId === request.commandId,
    );
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestDigest !== requestDigest) {
        throw new InvalidRequestError("Recover command identifier was reused with different input");
      }
      return current;
    }

    const recovering = snapshot({ ...current, lifecycle: "Recovering" });
    await this.#options.store.save(recovering);
    try {
      const ordinal = current.generation.ordinal + 1;
      const replacement = await this.#options.runtime.recover({
        snapshot: recovering,
        checkpoint: current.acceptedCheckpoint,
        generationOrdinal: ordinal,
      });
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
      });
      await this.#options.store.save(ready);
      return ready;
    } catch (cause) {
      await this.#options.store.save(snapshot({ ...recovering, lifecycle: "Failed" }));
      throw cause;
    }
  }

  async destroy(input: unknown): Promise<EnvironmentSnapshot> {
    const request = decodeUnknownStrict(EnvironmentDestroyRequestSchema, input);
    let current = await this.#requireEnvironment(request.environmentId);
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
    if (current.lifecycle === "Ready") {
      current = await this.checkpoint();
    }

    const destroying = snapshot({ ...current, lifecycle: "Destroying" });
    await this.#options.store.save(destroying);
    try {
      await this.#options.runtime.destroy(destroying);
      const acceptedAt = this.#options.now();
      const destroyed = snapshot({
        ...destroying,
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
    } catch (cause) {
      await this.#options.store.save(snapshot({ ...destroying, lifecycle: "Failed" }));
      throw cause;
    }
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

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as Schema from "effect/Schema";
import type {
  EffectId,
  SessionId,
  SessionHostReceipt,
  SessionStartSpec,
  Timestamp,
} from "@work-engine/protocol";
import {
  EffectIdSchema,
  SessionHostReceiptSchema,
  SessionIdSchema,
  SessionStartSpecSchema,
  TimestampSchema,
} from "@work-engine/protocol";
import { decodeUnknownStrict } from "@work-engine/protocol";
import { sha256 } from "@work-engine/protocol";

const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema);

export const StartClaimSchema = Schema.TaggedStruct("StartClaim", {
  key: Schema.NonEmptyString,
  launchId: Schema.NonEmptyString,
  sessionId: SessionIdSchema,
  effectId: EffectIdSchema,
  spec: SessionStartSpecSchema,
  receipt: SessionHostReceiptSchema,
  state: Schema.Literals(["spawn_requested", "running", "terminal"] as const),
  requestedAt: TimestampSchema,
  startedAt: optional(TimestampSchema),
  processId: optional(Schema.Int),
  processReference: Schema.NonEmptyString,
  terminalStatus: optional(Schema.Literals(["completed", "failed", "interrupted"] as const)),
  terminalReason: optional(Schema.NonEmptyString),
  terminalAt: optional(TimestampSchema),
});
export type StartClaim = typeof StartClaimSchema.Type;

const StartClaimStoreFileSchema = Schema.TaggedStruct("StartClaimStoreFile", {
  claims: Schema.Array(StartClaimSchema),
});

type ClaimKey = `${SessionId}:${EffectId}`;

export interface StartClaimStore {
  get(key: ClaimKey): Promise<StartClaim | undefined>;
  put(claim: StartClaim): Promise<void>;
  update(key: ClaimKey, update: (claim: StartClaim) => StartClaim): Promise<StartClaim>;
  list(): Promise<readonly StartClaim[]>;
}

export const startClaimKey = (sessionId: SessionId, effectId: EffectId): ClaimKey =>
  `${sessionId}:${effectId}`;

export class MemoryStartClaimStore implements StartClaimStore {
  private readonly claims = new Map<string, StartClaim>();

  get(key: ClaimKey): Promise<StartClaim | undefined> {
    return Promise.resolve(this.claims.get(key));
  }

  put(claim: StartClaim): Promise<void> {
    this.claims.set(claim.key, claim);
    return Promise.resolve();
  }

  async update(key: ClaimKey, update: (claim: StartClaim) => StartClaim): Promise<StartClaim> {
    const existing = this.claims.get(key);
    if (existing === undefined) throw new Error(`missing start claim: ${key}`);
    const next = update(existing);
    this.claims.set(key, next);
    return next;
  }

  list(): Promise<readonly StartClaim[]> {
    return Promise.resolve([...this.claims.values()]);
  }
}

/**
 * A tiny journal used by the container. The write/rename sequence makes the
 * claim durable before a Herdr/OMP process is requested. A caller can replace
 * this store with DO/SQLite storage without changing SessionHost semantics.
 */
export class JsonFileStartClaimStore implements StartClaimStore {
  private readonly lockPath: string;
  private loaded = false;
  private readonly claims = new Map<string, StartClaim>();

  constructor(private readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  async get(key: ClaimKey): Promise<StartClaim | undefined> {
    await this.load();
    return this.claims.get(key);
  }

  async put(claim: StartClaim): Promise<void> {
    await this.withLock(async () => {
      await this.load(true);
      if (this.claims.has(claim.key)) return;
      this.claims.set(claim.key, claim);
      await this.flush();
    });
  }

  async update(key: ClaimKey, update: (claim: StartClaim) => StartClaim): Promise<StartClaim> {
    return this.withLock(async () => {
      await this.load(true);
      const existing = this.claims.get(key);
      if (existing === undefined) throw new Error(`missing start claim: ${key}`);
      const next = update(existing);
      this.claims.set(key, next);
      await this.flush();
      return next;
    });
  }

  async list(): Promise<readonly StartClaim[]> {
    await this.load();
    return [...this.claims.values()];
  }

  private async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    try {
      const source = await readFile(this.path, "utf8");
      const decoded = decodeUnknownStrict(StartClaimStoreFileSchema, JSON.parse(source) as unknown);
      this.claims.clear();
      for (const claim of decoded.claims) this.claims.set(claim.key, claim);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.claims.clear();
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      _tag: "StartClaimStoreFile",
      claims: [...this.claims.values()],
    });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async withLock<A>(operation: () => Promise<A>): Promise<A> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isAlreadyExists(error) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }
}

export const makeStartClaim = (spec: SessionStartSpec, acceptedAt: Timestamp): StartClaim => {
  const launchId = spec.effectId;
  const processReference = `omp:${spec.sessionId}:${spec.effectId}`;
  const receipt: SessionHostReceipt = {
    _tag: "SessionHostReceipt",
    sessionId: spec.sessionId,
    effectId: spec.effectId,
    acceptedAt,
    processReference,
  };
  return {
    _tag: "StartClaim",
    key: startClaimKey(spec.sessionId, spec.effectId),
    launchId,
    sessionId: spec.sessionId,
    effectId: spec.effectId,
    spec,
    receipt,
    state: "spawn_requested",
    requestedAt: acceptedAt,
    processReference,
  };
};

export const claimToJson = (claim: StartClaim): string => JSON.stringify(claim);

export const claimDigest = async (claim: StartClaim) =>
  sha256(new TextEncoder().encode(claimToJson(claim)));

const isMissingFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

export type { ClaimKey };

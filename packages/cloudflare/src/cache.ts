import {
  DependencyCacheManifestSchema,
  type DependencyCacheManifest,
} from "./contract.ts";
import { decode, record, requiredString, sha256 } from "./contract.ts";
import { CacheDigestMismatchError, CacheMissError, ProviderUnavailableError } from "./errors.ts";

export interface CacheExpectation {
  readonly runtimeDigest: string;
  readonly platformDigest: string;
  readonly imageDigest: string;
  readonly repositoryDigest: string;
  readonly lockfileDigest: string;
}

export interface CacheHit {
  readonly kind: "hit";
  readonly manifest: DependencyCacheManifest;
  readonly payload: Uint8Array;
  readonly payloadDigest: string;
}

export interface CacheMiss {
  readonly kind: "miss";
  readonly reason: string;
}

export type CacheRestore = CacheHit | CacheMiss;

const field = (manifest: DependencyCacheManifest, key: string): unknown => record(manifest)[key];

const assertMatches = (
  manifest: DependencyCacheManifest,
  expectation: CacheExpectation,
  observedPayloadDigest: string,
): void => {
  const pairs: readonly [string, unknown, string][] = [
    ["runtimeDigest", field(manifest, "runtimeDigest"), expectation.runtimeDigest],
    ["platformDigest", field(manifest, "platformDigest"), expectation.platformDigest],
    ["imageDigest", field(manifest, "imageDigest"), expectation.imageDigest],
    ["repositoryDigest", field(manifest, "repositoryDigest"), expectation.repositoryDigest],
    ["lockfileDigest", field(manifest, "lockfileDigest"), expectation.lockfileDigest],
    ["payloadDigest", field(manifest, "payloadDigest"), observedPayloadDigest],
  ];
  for (const [name, observed, expected] of pairs) {
    if (observed !== expected) {
      throw new CacheDigestMismatchError(`${name}:${expected}`, `${name}:${String(observed)}`);
    }
  }
};

export const verifyDependencyCache = async (
  manifest: DependencyCacheManifest,
  expectation: CacheExpectation,
  payload: Uint8Array,
): Promise<CacheHit> => {
  const decoded = decode(DependencyCacheManifestSchema, manifest);
  const payloadDigest = await sha256(payload);
  assertMatches(decoded, expectation, payloadDigest);
  return { kind: "hit", manifest: decoded, payload, payloadDigest };
};

export interface TrustedCacheWriter {
  write(manifest: DependencyCacheManifest, payload: Uint8Array): Promise<void>;
}

/** R2 cache adapter. Only this trusted setup boundary can write payloads. */
  readonly #bucket: R2Bucket | undefined;

  constructor(bucket: R2Bucket | undefined) {
    this.#bucket = bucket;
  }

  async restore(manifest: DependencyCacheManifest, expectation: CacheExpectation): Promise<CacheRestore> {
    if (this.#bucket === undefined) throw new ProviderUnavailableError("DependencyCache R2");
    const decoded = decode(DependencyCacheManifestSchema, manifest);
    const key = requiredString(record(decoded)["cacheKey"], "manifest.cacheKey");
    const object = await this.#bucket.get(key);
    if (object === null) return { kind: "miss", reason: `No cache payload at ${key}` };
    const payload = new Uint8Array(await object.arrayBuffer());
    try {
      return await verifyDependencyCache(decoded, expectation, payload);
    } catch (cause) {
      if (cause instanceof CacheDigestMismatchError) throw cause;
      throw new CacheDigestMismatchError(String(record(decoded)["payloadDigest"]), await sha256(payload));
    }
  }

  async write(manifest: DependencyCacheManifest, payload: Uint8Array): Promise<void> {
    if (this.#bucket === undefined) throw new ProviderUnavailableError("DependencyCache R2");
    const decoded = decode(DependencyCacheManifestSchema, manifest);
    const values = record(decoded);
    const expectation: CacheExpectation = {
      runtimeDigest: requiredString(values["runtimeDigest"], "manifest.runtimeDigest"),
      platformDigest: requiredString(values["platformDigest"], "manifest.platformDigest"),
      imageDigest: requiredString(values["imageDigest"], "manifest.imageDigest"),
      repositoryDigest: requiredString(values["repositoryDigest"], "manifest.repositoryDigest"),
      lockfileDigest: requiredString(values["lockfileDigest"], "manifest.lockfileDigest"),
    };
    await verifyDependencyCache(decoded, expectation, payload);
    const key = requiredString(values["cacheKey"], "manifest.cacheKey");
    await this.#bucket.put(key, payload, { httpMetadata: { contentType: "application/octet-stream" } });
  }
}

/** Session-facing cache boundary deliberately omits write. */
export class SessionDependencyCache {
  readonly #cache: Pick<R2DependencyCache, "restore">;
  constructor(cache: Pick<R2DependencyCache, "restore">) {
    this.#cache = cache;
  }

  restore(manifest: DependencyCacheManifest, expectation: CacheExpectation): Promise<CacheRestore> {
    return this.#cache.restore(manifest, expectation);
  }
}

/** Correct uncached fallback; setup runs only after a miss/rejection and is not a cache success. */
export const restoreOrSetup = async (
  cache: Pick<R2DependencyCache, "restore">,
  manifest: DependencyCacheManifest,
  expectation: CacheExpectation,
  setup: () => Promise<Uint8Array>,
): Promise<{ readonly source: "cache" | "uncached"; readonly payload: Uint8Array; readonly reason?: string }> => {
  try {
    const restored = await cache.restore(manifest, expectation);
    if (restored.kind === "hit") return { source: "cache", payload: restored.payload };
    const payload = await setup();
    return { source: "uncached", payload, reason: restored.reason };
  } catch (cause) {
    if (!(cause instanceof CacheDigestMismatchError) && !(cause instanceof CacheMissError)) throw cause;
    const payload = await setup();
    return { source: "uncached", payload, reason: cause.message };
  }
};

export type { DependencyCache } from "./contract.ts";

import {
  DependencyCacheManifestSchema,
  Sha256DigestSchema,
  decode,
  type DependencyCacheManifest,
  type PlatformCapabilities,
  type Sha256Digest,
} from "./contract.ts";
import { CacheDigestMismatchError, ProviderUnavailableError } from "./errors.ts";

type DigestCapability = Pick<PlatformCapabilities, "sha256">;

export interface CacheExpectation {
  readonly runtimeDigest: Sha256Digest;
  readonly platformDigest: Sha256Digest;
  readonly imageDigest: Sha256Digest;
  readonly repositoryDigest: Sha256Digest;
  readonly lockfileDigest: Sha256Digest;
}

export interface CacheHit {
  readonly kind: "hit";
  readonly manifest: DependencyCacheManifest;
  readonly payload: Uint8Array;
  readonly payloadDigest: Sha256Digest;
}

export interface CacheMiss {
  readonly kind: "miss";
  readonly reason: string;
}

export type CacheRestore = CacheHit | CacheMiss;

const assertMatches = (
  manifest: DependencyCacheManifest,
  expectation: CacheExpectation,
  observedPayloadDigest: Sha256Digest,
): void => {
  const pairs: readonly [string, string, string][] = [
    ["runtimeDigest", manifest.runtimeDigest, expectation.runtimeDigest],
    ["platformDigest", manifest.platformDigest, expectation.platformDigest],
    ["imageDigest", manifest.imageDigest, expectation.imageDigest],
    ["repositoryDigest", manifest.repositoryDigest, expectation.repositoryDigest],
    ["lockfileDigest", manifest.lockfileDigest, expectation.lockfileDigest],
    ["payloadDigest", manifest.payloadDigest, observedPayloadDigest],
  ];
  for (const [name, observed, expected] of pairs) {
    if (observed !== expected) {
      throw new CacheDigestMismatchError(`${name}:${expected}`, `${name}:${observed}`);
    }
  }
};
export const verifyDependencyCache = async (
  manifest: DependencyCacheManifest,
  expectation: CacheExpectation,
  payload: Uint8Array,
  capabilities: DigestCapability,
): Promise<CacheHit> => {
  const decoded = decode(DependencyCacheManifestSchema, manifest);
  const payloadDigest = decode(Sha256DigestSchema, await capabilities.sha256(payload));
  assertMatches(decoded, expectation, payloadDigest);
  return { kind: "hit", manifest: decoded, payload, payloadDigest };
};

export interface TrustedCacheWriter {
  write(manifest: DependencyCacheManifest, payload: Uint8Array): Promise<void>;
}

/** R2 cache adapter. Only this trusted setup boundary can write payloads. */
export class R2DependencyCache {
  #bucket: R2Bucket | undefined;
  #capabilities: DigestCapability;

  constructor(bucket: R2Bucket | undefined, capabilities: DigestCapability) {
    this.#bucket = bucket;
    this.#capabilities = capabilities;
  }

  async restore(
    manifest: DependencyCacheManifest,
    expectation: CacheExpectation,
  ): Promise<CacheRestore> {
    if (this.#bucket === undefined) throw new ProviderUnavailableError("DependencyCache R2");
    const decoded = decode(DependencyCacheManifestSchema, manifest);
    const object = await this.#bucket.get(decoded.cacheKey);
    if (object === null) return { kind: "miss", reason: `No cache payload at ${decoded.cacheKey}` };
    const payload = new Uint8Array(await object.arrayBuffer());
    return verifyDependencyCache(decoded, expectation, payload, this.#capabilities);
  }

  async write(manifest: DependencyCacheManifest, payload: Uint8Array): Promise<void> {
    if (this.#bucket === undefined) throw new ProviderUnavailableError("DependencyCache R2");
    const decoded = decode(DependencyCacheManifestSchema, manifest);
    const expectation: CacheExpectation = {
      runtimeDigest: decoded.runtimeDigest,
      platformDigest: decoded.platformDigest,
      imageDigest: decoded.imageDigest,
      repositoryDigest: decoded.repositoryDigest,
      lockfileDigest: decoded.lockfileDigest,
    };
    await verifyDependencyCache(decoded, expectation, payload, this.#capabilities);
    await this.#bucket.put(decoded.cacheKey, payload, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  }
}

/** Session-facing cache boundary deliberately omits write. */
export class SessionDependencyCache {
  #cache: Pick<R2DependencyCache, "restore">;
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
): Promise<{
  readonly source: "cache" | "uncached";
  readonly payload: Uint8Array;
  readonly reason?: string;
}> => {
  try {
    const restored = await cache.restore(manifest, expectation);
    if (restored.kind === "hit") return { source: "cache", payload: restored.payload };
    const payload = await setup();
    return { source: "uncached", payload, reason: restored.reason };
  } catch (cause) {
    if (!(cause instanceof CacheDigestMismatchError)) throw cause;
    const payload = await setup();
    return { source: "uncached", payload, reason: cause.message };
  }
};

export type { DependencyCache } from "./contract.ts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ArtifactReceiptSchema,
  Sha256DigestSchema,
  digestManifest,
  type ArtifactReceipt,
  type Sha256Digest,
} from "@work-engine/protocol";
import type { ArtifactError, ArtifactStore } from "@work-engine/runtime";

const keyFor = (digest: Sha256Digest): string => digest.replace("sha256:", "sha256/");

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

export const digestBytes = async (content: Uint8Array): Promise<Sha256Digest> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
  return Sha256DigestSchema.make(`sha256:${hex(new Uint8Array(digest))}`);
};

const metadataReceipt = (object: R2Object, digest: Sha256Digest): ArtifactReceipt | undefined => {
  const mediaType = object.httpMetadata?.contentType ?? object.customMetadata?.mediaType;
  if (mediaType === undefined || mediaType.length === 0) return undefined;
  const customDigest = object.customMetadata?.digest;
  if (customDigest !== undefined && customDigest !== digest) return undefined;
  if (
    object.customMetadata?.bytes !== undefined &&
    Number(object.customMetadata.bytes) !== object.size
  )
    return undefined;
  return ArtifactReceiptSchema.make({ digest, bytes: object.size, mediaType });
};
const observedDigest = (value: string | undefined): Sha256Digest =>
  value !== undefined && /^sha256:[0-9a-f]{64}$/u.test(value)
    ? Sha256DigestSchema.make(value)
    : Sha256DigestSchema.make("sha256:" + "0".repeat(64));

const artifactFailureMessage = (failure: ArtifactError): string => {
  switch (failure._tag) {
    case "ArtifactMissing":
      return `artifact ${failure.digest} is missing`;
    case "ArtifactConflict":
      return failure.reason;
    case "ArtifactDigestMismatch":
      return `artifact digest mismatch: expected ${failure.expected}, observed ${failure.observed}`;
    case "ArtifactUnavailable":
      return failure.reason;
  }
};

class ArtifactFailure extends Error {
  readonly failure: ArtifactError;

  constructor(failure: ArtifactError) {
    super(artifactFailureMessage(failure));
    this.name = "ArtifactFailure";
    this.failure = failure;
  }
}

const artifactErrorFromCause = (cause: unknown): ArtifactError => {
  if (cause instanceof ArtifactFailure) return cause.failure;
  if (typeof cause === "object" && cause !== null && "_tag" in cause)
    return cause as ArtifactError;
  return {
    _tag: "ArtifactUnavailable",
    reason: cause instanceof Error ? cause.message : "R2 failure",
  };
};

const effectful = <A>(operation: () => PromiseLike<A>): Effect.Effect<A, ArtifactError> =>
  Effect.tryPromise({
    try: operation,
    catch: artifactErrorFromCause,
  });

export class R2ArtifactStore implements ArtifactStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async #putPromise(content: Uint8Array, mediaType: string): Promise<ArtifactReceipt> {
    const digest = await digestBytes(content);
    const key = keyFor(digest);
    const existing = await this.#bucket.head(key);
    if (existing !== null) {
      const receipt = metadataReceipt(existing, digest);
      if (
        receipt === undefined ||
        receipt.bytes !== content.byteLength ||
        receipt.mediaType !== mediaType
      ) {
        throw new ArtifactFailure({
          _tag: "ArtifactConflict",
          digest,
          reason: "immutable R2 object metadata conflicts with the candidate",
        });
      }
      const current = await this.#bucket.get(key);
      if (current === null || !bytesEqual(await current.bytes(), content)) {
        throw new ArtifactFailure({
          _tag: "ArtifactConflict",
          digest,
          reason: "immutable R2 object bytes conflict with the candidate",
        });
      }
      return receipt;
    }

    await this.#bucket.put(key, content, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: content,
      httpMetadata: { contentType: mediaType },
      customMetadata: {
        digest,
        bytes: String(content.byteLength),
        mediaType,
      },
    });
    const verified = await this.#bucket.head(key);
    if (verified === null) {
      throw new ArtifactFailure({
        _tag: "ArtifactUnavailable",
        reason: "R2 put did not produce a head",
      });
    }
    const receipt = metadataReceipt(verified, digest);
    if (
      receipt === undefined ||
      receipt.bytes !== content.byteLength ||
      receipt.mediaType !== mediaType
    ) {
      throw new ArtifactFailure({
        _tag: "ArtifactDigestMismatch",
        expected: digest,
        observed: observedDigest(verified.customMetadata?.digest),
      });
    }
    const stored = await this.#bucket.get(key);
    if (stored === null) {
      throw new ArtifactFailure({
        _tag: "ArtifactUnavailable",
        reason: "R2 put body is unavailable",
      });
    }
    const storedBytes = await stored.bytes();
    const observed = await digestBytes(storedBytes);
    if (observed !== digest || storedBytes.byteLength !== content.byteLength) {
      throw new ArtifactFailure({
        _tag: "ArtifactDigestMismatch",
        expected: digest,
        observed,
      });
    }
    return receipt;
  }

  put(content: Uint8Array, mediaType: string): Effect.Effect<ArtifactReceipt, ArtifactError> {
    return effectful(() => this.#putPromise(content, mediaType));
  }

  async #headPromise(digest: Sha256Digest): Promise<ArtifactReceipt> {
    const parsedDigest = Sha256DigestSchema.make(digest);
    const object = await this.#bucket.head(keyFor(parsedDigest));
    if (object === null)
      throw new ArtifactFailure({ _tag: "ArtifactMissing", digest: parsedDigest });
    const receipt = metadataReceipt(object, parsedDigest);
    if (receipt === undefined) {
      throw new ArtifactFailure({
        _tag: "ArtifactDigestMismatch",
        expected: parsedDigest,
        observed: observedDigest(object.customMetadata?.digest),
      });
    }
    return receipt;
  }

  head(digest: Sha256Digest): Effect.Effect<ArtifactReceipt, ArtifactError> {
    return effectful(() => this.#headPromise(digest));
  }

  async #getPromise(digest: Sha256Digest): Promise<Uint8Array> {
    const receipt = await this.#headPromise(digest);
    const object = await this.#bucket.get(keyFor(receipt.digest));
    if (object === null)
      throw new ArtifactFailure({ _tag: "ArtifactMissing", digest: receipt.digest });
    const content = await object.bytes();
    const observed = await digestBytes(content);
    if (observed !== receipt.digest || content.byteLength !== receipt.bytes) {
      throw new ArtifactFailure({
        _tag: "ArtifactDigestMismatch",
        expected: receipt.digest,
        observed,
      });
    }
    const mediaType = object.httpMetadata?.contentType ?? object.customMetadata?.mediaType;
    if (mediaType !== receipt.mediaType) {
      throw new ArtifactFailure({
        _tag: "ArtifactConflict",
        digest: receipt.digest,
        reason: "R2 media type changed",
      });
    }
    return content;
  }

  /** Reads and verifies an artifact at the Cloudflare composition boundary. */
  getVerified(digest: Sha256Digest): Promise<Uint8Array> {
    return this.#getPromise(digest);
  }

  get(digest: Sha256Digest): Effect.Effect<Uint8Array, ArtifactError> {
    return effectful(() => this.#getPromise(digest));
  }
}

export const ArtifactStoreService = Context.Service<ArtifactStore>("work-engine/ArtifactStore");

export const ArtifactStoreLive = (bucket: R2Bucket): Layer.Layer<ArtifactStore> =>
  Layer.succeed(ArtifactStoreService, new R2ArtifactStore(bucket));

export const artifactManifestDigest = digestManifest;

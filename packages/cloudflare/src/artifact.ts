import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const error = (value: ArtifactError): Effect.Effect<never, ArtifactError> => Effect.fail(value);

export class R2ArtifactStore implements ArtifactStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  put(content: Uint8Array, mediaType: string): Effect.Effect<ArtifactReceipt, ArtifactError> {
    return Effect.tryPromise({
      try: async () => {
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
            throw {
              _tag: "ArtifactConflict",
              digest,
              reason: "immutable R2 object metadata conflicts with the candidate",
            } satisfies ArtifactError;
          }
          const current = await this.#bucket.get(key);
          if (current === null || !bytesEqual(await current.bytes(), content)) {
            throw {
              _tag: "ArtifactConflict",
              digest,
              reason: "immutable R2 object bytes conflict with the candidate",
            } satisfies ArtifactError;
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
          throw {
            _tag: "ArtifactUnavailable",
            reason: "R2 put did not produce a head",
          } satisfies ArtifactError;
        }
        const receipt = metadataReceipt(verified, digest);
        if (
          receipt === undefined ||
          receipt.bytes !== content.byteLength ||
          receipt.mediaType !== mediaType
        ) {
          throw {
            _tag: "ArtifactDigestMismatch",
            expected: digest,
            observed: verified.customMetadata?.digest ?? "sha256:" + "0".repeat(64),
          } satisfies ArtifactError;
        }
        const stored = await this.#bucket.get(key);
        if (stored === null) {
          throw {
            _tag: "ArtifactUnavailable",
            reason: "R2 put body is unavailable",
          } satisfies ArtifactError;
        }
        const storedBytes = await stored.bytes();
        const observed = await digestBytes(storedBytes);
        if (observed !== digest || storedBytes.byteLength !== content.byteLength) {
          throw {
            _tag: "ArtifactDigestMismatch",
            expected: digest,
            observed,
          } satisfies ArtifactError;
        }
        return receipt;
      },
      catch: (cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause)
          return cause as ArtifactError;
        return {
          _tag: "ArtifactUnavailable",
          reason: cause instanceof Error ? cause.message : "R2 failure",
        };
      },
    });
  }

  head(digest: Sha256Digest): Effect.Effect<ArtifactReceipt, ArtifactError> {
    return Effect.tryPromise({
      try: async () => {
        const parsedDigest = Sha256DigestSchema.make(digest);
        const object = await this.#bucket.head(keyFor(parsedDigest));
        if (object === null)
          throw { _tag: "ArtifactMissing", digest: parsedDigest } satisfies ArtifactError;
        const receipt = metadataReceipt(object, parsedDigest);
        if (receipt === undefined) {
          throw {
            _tag: "ArtifactDigestMismatch",
            expected: parsedDigest,
            observed: object.customMetadata?.digest ?? "sha256:" + "0".repeat(64),
          } satisfies ArtifactError;
        }
        return receipt;
      },
      catch: (cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause)
          return cause as ArtifactError;
        return {
          _tag: "ArtifactUnavailable",
          reason: cause instanceof Error ? cause.message : "R2 failure",
        };
      },
    });
  }

  get(digest: Sha256Digest): Effect.Effect<Uint8Array, ArtifactError> {
    return Effect.tryPromise({
      try: async () => {
        const receipt = await Effect.runPromise(this.head(digest));
        const object = await this.#bucket.get(keyFor(receipt.digest));
        if (object === null)
          throw { _tag: "ArtifactMissing", digest: receipt.digest } satisfies ArtifactError;
        const content = await object.bytes();
        const observed = await digestBytes(content);
        if (observed !== receipt.digest || content.byteLength !== receipt.bytes) {
          throw {
            _tag: "ArtifactDigestMismatch",
            expected: receipt.digest,
            observed,
          } satisfies ArtifactError;
        }
        const mediaType = object.httpMetadata?.contentType ?? object.customMetadata?.mediaType;
        if (mediaType !== receipt.mediaType) {
          throw {
            _tag: "ArtifactConflict",
            digest: receipt.digest,
            reason: "R2 media type changed",
          } satisfies ArtifactError;
        }
        return content;
      },
      catch: (cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause)
          return cause as ArtifactError;
        return {
          _tag: "ArtifactUnavailable",
          reason: cause instanceof Error ? cause.message : "R2 failure",
        };
      },
    });
  }
}

export const ArtifactStoreService = Effect.Service<ArtifactStoreService>()(
  "work-engine/ArtifactStore",
  {
    sync: () => {
      throw new Error("ArtifactStoreService must be provided by a Cloudflare layer");
    },
  },
);

export const ArtifactStoreLive = (bucket: R2Bucket): Layer.Layer<ArtifactStoreService> =>
  Layer.succeed(ArtifactStoreService, new R2ArtifactStore(bucket));

export const artifactManifestDigest = digestManifest;

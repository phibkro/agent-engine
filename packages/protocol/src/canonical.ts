import { canonicalizeEx } from "json-canonicalize";
import { Sha256DigestSchema, type Sha256Digest } from "./identifiers.ts";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** RFC 8785 JSON Canonicalization Scheme encoding. */
export const canonicalize = (value: CanonicalJsonValue): string => canonicalizeEx(value);

export const canonicalJsonBytes = (value: CanonicalJsonValue): Uint8Array =>
  new TextEncoder().encode(canonicalize(value));

/** Explicit SHA-256 capability for deterministic protocol helpers. */
export type Sha256 = (bytes: Uint8Array) => Promise<Sha256Digest>;

export const digestCanonical = async (
  value: CanonicalJsonValue,
  sha256: Sha256,
): Promise<Sha256Digest> => {
  const digest = await sha256(canonicalJsonBytes(value));
  return Sha256DigestSchema.make(digest);
};

const utf8Encoder = new TextEncoder();
export const compareUtf8PathBytes = (left: string, right: string): number => {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
};

export const sortManifestEntries = <Entry extends { readonly path: string }>(
  entries: readonly Entry[],
): readonly Entry[] =>
  entries.slice().sort((left, right) => compareUtf8PathBytes(left.path, right.path));

export const digestManifest = async (
  entries: readonly {
    readonly path: string;
    readonly digest: Sha256Digest;
    readonly bytes: number;
  }[],
  sha256: Sha256,
): Promise<Sha256Digest> => digestCanonical(sortManifestEntries(entries), sha256);

import { canonicalizeEx } from "json-canonicalize";
import { Sha256DigestSchema, type Sha256Digest } from "./identifiers.ts";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** RFC 8785 JSON Canonicalization Scheme encoding. */
export const canonicalize = (value: CanonicalJsonValue): string =>
  canonicalizeEx(value, {
    allowCircular: false,
    filterUndefined: false,
    undefinedInArrayToNull: false,
  });
export const canonicalJson = canonicalize;
export const canonicalJsonBytes = (value: CanonicalJsonValue): Uint8Array =>
  new TextEncoder().encode(canonicalize(value));

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of exact bytes, using the Web Crypto API available in Workers and browsers. */
export const sha256 = async (bytes: Uint8Array): Promise<Sha256Digest> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Sha256DigestSchema.make(`sha256:${hex(new Uint8Array(digest))}`);
};

export const sha256Bytes = sha256;
export const digestCanonical = async (value: CanonicalJsonValue): Promise<Sha256Digest> =>
  sha256(canonicalJsonBytes(value));
export const canonicalDigest = digestCanonical;
const utf8PathCompare = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

export const sortManifestEntries = <Entry extends { readonly path: string }>(
  entries: readonly Entry[],
): readonly Entry[] => entries.slice().sort((left, right) => utf8PathCompare(left.path, right.path));

export const digestManifest = async (
  entries: readonly {
    readonly path: string;
    readonly digest: Sha256Digest;
    readonly bytes: number;
  }[],
): Promise<Sha256Digest> => digestCanonical({ entries: sortManifestEntries(entries) });
export const canonicalEncode = canonicalize;
export const sha256Digest = sha256;
export const canonicalJsonDigest = digestCanonical;

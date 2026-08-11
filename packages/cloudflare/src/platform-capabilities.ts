import * as Schema from "effect/Schema";
import { Sha256DigestSchema, TimestampSchema } from "@work-engine/protocol";
import type { PlatformCapabilities } from "./contract.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

/** The single Cloudflare/Bun host adapter for capabilities required by pure state owners. */
export const cloudflarePlatformCapabilities: PlatformCapabilities = {
  now: () => decode(TimestampSchema, new Date().toISOString()),
  uuid: () => globalThis.crypto.randomUUID(),
  sha256: async (bytes) => {
    const buffer = bytes.buffer;
    const source =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    return decode(Sha256DigestSchema, `sha256:${hex}`);
  },
};

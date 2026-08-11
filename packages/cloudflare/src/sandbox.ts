import * as Schema from "effect/Schema";
import {
  NonEmptyStringSchema,
  SessionIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
  decodeUnknownStrict,
  type SessionId,
  type Timestamp,
} from "@work-engine/protocol";
import { InvalidRequestError, ProviderUnavailableError } from "./errors.ts";

const SandboxAllocateRequestSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  imageDigest: Sha256DigestSchema,
});
const SandboxTerminateRequestSchema = Schema.Struct({
  providerId: NonEmptyStringSchema,
});
const SandboxAllocationResponseSchema = Schema.Struct({
  providerId: NonEmptyStringSchema,
  workspaceRoot: NonEmptyStringSchema,
});
const SandboxTerminateResponseSchema = Schema.Struct({});
const SandboxProviderFailureSchema = Schema.TaggedStruct("SandboxProviderFailure", {
  reason: NonEmptyStringSchema,
});

export const SandboxAllocationSchema = Schema.Struct({
  providerId: NonEmptyStringSchema,
  sessionId: SessionIdSchema,
  imageDigest: Sha256DigestSchema,
  workspaceRoot: NonEmptyStringSchema,
  allocatedAt: TimestampSchema,
});
export type SandboxAllocation = typeof SandboxAllocationSchema.Type;

export interface SandboxProvider {
  allocate(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation>;
  terminate(providerId: string): Promise<void>;
}

export interface SandboxFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface SandboxClock {
  now(): Timestamp;
}

const jsonBody = (value: unknown): string => Schema.encodeSync(Schema.UnknownFromJsonString)(value);

const responseJson = async (response: Response): Promise<unknown> => {
  try {
    const body = await response.text();
    return decodeUnknownStrict(Schema.UnknownFromJsonString, body);
  } catch (cause) {
    throw new ProviderUnavailableError(
      "Cloudflare Sandbox provider",
      "invalid JSON response",
      cause,
    );
  }
};

/** Cloudflare Sandbox adapter. Missing provider bindings fail explicitly; no local shell fallback exists. */
export class CloudflareSandboxProvider implements SandboxProvider {
  readonly #binding: SandboxFetcher | undefined;
  readonly #clock: SandboxClock;

  constructor(binding: SandboxFetcher | undefined, clock: SandboxClock) {
    this.#binding = binding;
    this.#clock = clock;
  }

  async #call<S extends Schema.ConstraintDecoder<unknown>>(
    path: string,
    body: unknown,
    responseSchema: S,
  ): Promise<S["Type"]> {
    if (this.#binding === undefined) {
      throw new ProviderUnavailableError("Cloudflare Sandbox provider");
    }
    let response: Response;
    try {
      response = await this.#binding.fetch(`https://sandbox${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonBody(body),
      });
    } catch (cause) {
      throw new ProviderUnavailableError("Cloudflare Sandbox provider", "request failed", cause);
    }
    const responseBody = await responseJson(response);
    if (!response.ok) {
      try {
        decodeUnknownStrict(SandboxProviderFailureSchema, responseBody);
      } catch (cause) {
        throw new ProviderUnavailableError(
          "Cloudflare Sandbox provider",
          "invalid failure response",
          cause,
        );
      }
      throw new ProviderUnavailableError(
        "Cloudflare Sandbox provider",
        `provider returned ${response.status}`,
      );
    }
    try {
      return decodeUnknownStrict(responseSchema, responseBody);
    } catch (cause) {
      throw new ProviderUnavailableError(
        "Cloudflare Sandbox provider",
        "invalid success response",
        cause,
      );
    }
  }

  async allocate(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation> {
    const request = decodeUnknownStrict(SandboxAllocateRequestSchema, { sessionId, imageDigest });
    const value = await this.#call("/allocate", request, SandboxAllocationResponseSchema);
    return decodeUnknownStrict(SandboxAllocationSchema, {
      ...value,
      sessionId: request.sessionId,
      imageDigest: request.imageDigest,
      allocatedAt: this.#clock.now(),
    });
  }

  async terminate(providerId: string): Promise<void> {
    let request: typeof SandboxTerminateRequestSchema.Type;
    try {
      request = decodeUnknownStrict(SandboxTerminateRequestSchema, { providerId });
    } catch (cause) {
      throw new InvalidRequestError("Sandbox provider identity is invalid", cause);
    }
    await this.#call("/terminate", request, SandboxTerminateResponseSchema);
  }
}

/** Serializes replacement identities and requires predecessor termination before acceptance. */
export class SessionSandboxLifecycle {
  #provider: SandboxProvider;
  #live: SandboxAllocation | undefined;
  #predecessors: SandboxAllocation[] = [];

  constructor(provider: SandboxProvider) {
    this.#provider = provider;
  }

  get live(): SandboxAllocation | undefined {
    return this.#live;
  }

  get predecessors(): readonly SandboxAllocation[] {
    return [...this.#predecessors];
  }

  async allocate(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation> {
    if (this.#live !== undefined) return this.#live;
    const allocation = await this.#provider.allocate(sessionId, imageDigest);
    this.#live = allocation;
    return allocation;
  }

  async replace(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation> {
    const predecessor = this.#live;
    if (predecessor !== undefined) {
      await this.#provider.terminate(predecessor.providerId);
      this.#predecessors.push(predecessor);
      this.#live = undefined;
    }
    return this.allocate(sessionId, imageDigest);
  }

  async terminate(): Promise<void> {
    if (this.#live === undefined) return;
    const predecessor = this.#live;
    await this.#provider.terminate(predecessor.providerId);
    this.#predecessors.push(predecessor);
    this.#live = undefined;
  }
}

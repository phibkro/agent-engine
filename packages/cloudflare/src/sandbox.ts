import { ProviderUnavailableError, InvalidRequestError } from "./errors.ts";
import { json, record, requiredString, nowIso } from "./contract.ts";
import type { SessionId } from "./contract.ts";

export interface SandboxAllocation {
  readonly providerId: string;
  readonly sessionId: SessionId;
  readonly imageDigest: string;
  readonly workspaceRoot: string;
  readonly allocatedAt: string;
}

export interface SandboxProvider {
  allocate(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation>;
  terminate(providerId: string): Promise<void>;
}

/** Cloudflare Sandbox adapter. Missing provider bindings fail explicitly; no local shell fallback exists. */
export class CloudflareSandboxProvider implements SandboxProvider {
  readonly #binding: Fetcher | undefined;

  constructor(binding: Fetcher | undefined) {
    this.#binding = binding;
  }

  async #call(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (this.#binding === undefined) throw new ProviderUnavailableError("Cloudflare Sandbox provider");
    const response = await this.#binding.fetch(`https://sandbox${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json(body),
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new ProviderUnavailableError("Cloudflare Sandbox provider", `provider returned ${response.status}`);
    return record(value);
  }

  async allocate(sessionId: SessionId, imageDigest: string): Promise<SandboxAllocation> {
    if (imageDigest.length === 0) throw new InvalidRequestError("Sandbox image digest cannot be empty");
    const value = await this.#call("/allocate", { sessionId, imageDigest });
    return {
      providerId: requiredString(value["providerId"], "providerId"),
      sessionId,
      imageDigest,
      workspaceRoot: requiredString(value["workspaceRoot"], "workspaceRoot"),
      allocatedAt: nowIso(),
    };
  }

  async terminate(providerId: string): Promise<void> {
    if (providerId.length === 0) throw new InvalidRequestError("Sandbox provider identity cannot be empty");
    await this.#call("/terminate", { providerId });
  }
}

/** Serializes replacement identities and requires predecessor termination before acceptance. */
export class SessionSandboxLifecycle {
  readonly #provider: SandboxProvider;
  #live: SandboxAllocation | undefined;
  readonly #predecessors: SandboxAllocation[] = [];

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

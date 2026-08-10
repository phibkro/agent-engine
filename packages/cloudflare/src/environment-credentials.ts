import {
  EnvironmentCredentialLeaseSchema,
  decodeUnknownStrict,
} from "@work-engine/protocol";
import { InvalidRequestError, ProviderUnavailableError } from "./errors.ts";

type ProtocolEnvironmentCredentialLease = typeof EnvironmentCredentialLeaseSchema.Type;

export type EnvironmentCredentialLease = ProtocolEnvironmentCredentialLease & {
  readonly brokerOrigin: string;
};

export interface EnvironmentCredentialSubject {
  readonly environmentId: string;
  readonly generationId: string;
}

export interface EnvironmentCredentialBroker {
  lease(
    input: EnvironmentCredentialSubject & {
      readonly repository: { readonly owner: string; readonly name: string };
      readonly provider: "claude" | "codex";
    },
  ): Promise<EnvironmentCredentialLease>;
  revoke(input: EnvironmentCredentialSubject): Promise<void>;
}

export class FetcherEnvironmentCredentialBroker implements EnvironmentCredentialBroker {
  readonly #fetcher: { fetch(input: string, init?: RequestInit): Promise<Response> };
  readonly #endpoint: string;
  readonly #authorization: string;
  readonly #brokerOrigin: string;

  constructor(
    fetcher: { fetch(input: string, init?: RequestInit): Promise<Response> },
    endpoint: string,
    authorization: string,
  ) {
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      throw new InvalidRequestError("Credential broker endpoint is invalid");
    }
    if (endpointUrl.protocol !== "https:") {
      throw new InvalidRequestError("Credential broker endpoint must use HTTPS");
    }
    this.#fetcher = fetcher;
    this.#endpoint = endpoint;
    this.#authorization = authorization;
    this.#brokerOrigin = endpointUrl.origin;
  }

  async lease(
    input: EnvironmentCredentialSubject & {
      readonly repository: { readonly owner: string; readonly name: string };
      readonly provider: "claude" | "codex";
    },
  ): Promise<EnvironmentCredentialLease> {
    const response = await this.#request("POST", input);
    let payload: ProtocolEnvironmentCredentialLease;
    try {
      payload = decodeUnknownStrict(EnvironmentCredentialLeaseSchema, await response.json());
    } catch {
      throw new ProviderUnavailableError("Credential broker", "invalid lease response");
    }
    return { ...payload, brokerOrigin: this.#brokerOrigin };
  }

  async revoke(input: EnvironmentCredentialSubject): Promise<void> {
    await this.#request("DELETE", input);
  }

  async #request(method: "POST" | "DELETE", body: object): Promise<Response> {
    const response = await this.#fetcher.fetch(this.#endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${this.#authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ProviderUnavailableError(
        "Credential broker",
        method === "POST" ? "lease request rejected" : "revocation request rejected",
      );
    }
    return response;
  }
}

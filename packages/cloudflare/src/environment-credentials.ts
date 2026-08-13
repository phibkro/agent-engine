import * as Schema from "effect/Schema";
import {
  AgentProviderSchema,
  EnvironmentCredentialLeaseSchema,
  EnvironmentIdSchema,
  GitRepositorySchema,
  NonEmptyStringSchema,
  decodeUnknownStrict,
} from "@work-engine/protocol";
import { InvalidRequestError, ProviderUnavailableError } from "./errors.ts";

const EnvironmentCredentialSubjectSchema = Schema.Struct({
  environmentId: EnvironmentIdSchema,
  generationId: NonEmptyStringSchema,
});
const EnvironmentCredentialLeaseRequestSchema = Schema.Struct({
  ...EnvironmentCredentialSubjectSchema.fields,
  repository: GitRepositorySchema,
  provider: AgentProviderSchema,
});
const EnvironmentCredentialFailureSchema = Schema.TaggedStruct("EnvironmentCredentialFailure", {
  reason: NonEmptyStringSchema,
});
const EnvironmentCredentialLeaseFromJsonSchema = Schema.fromJsonString(
  EnvironmentCredentialLeaseSchema,
);
const EnvironmentCredentialFailureFromJsonSchema = Schema.fromJsonString(
  EnvironmentCredentialFailureSchema,
);

type ProtocolEnvironmentCredentialLease = typeof EnvironmentCredentialLeaseSchema.Type;
export interface EnvironmentCredentialSubject {
  readonly environmentId: string;
  readonly generationId: string;
}
export interface EnvironmentCredentialLeaseInput extends EnvironmentCredentialSubject {
  readonly repository: { readonly owner: string; readonly name: string };
  readonly provider: "claude" | "codex";
}

export type EnvironmentCredentialLease = ProtocolEnvironmentCredentialLease & {
  readonly brokerOrigin: string;
};

export interface EnvironmentCredentialBroker {
  lease(input: EnvironmentCredentialLeaseInput): Promise<EnvironmentCredentialLease>;
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
    } catch (cause) {
      throw new InvalidRequestError("Credential broker endpoint is invalid", cause);
    }
    if (endpointUrl.protocol !== "https:") {
      throw new InvalidRequestError("Credential broker endpoint must use HTTPS");
    }
    this.#fetcher = fetcher;
    this.#endpoint = endpoint;
    this.#authorization = authorization;
    this.#brokerOrigin = endpointUrl.origin;
  }

  async lease(input: EnvironmentCredentialLeaseInput): Promise<EnvironmentCredentialLease> {
    const response = await this.#request("POST", EnvironmentCredentialLeaseRequestSchema, input);
    let payload: ProtocolEnvironmentCredentialLease;
    try {
      payload = decodeUnknownStrict(
        EnvironmentCredentialLeaseFromJsonSchema,
        await response.text(),
      );
    } catch (cause) {
      throw new ProviderUnavailableError("Credential broker", "invalid lease response", cause);
    }
    return { ...payload, brokerOrigin: this.#brokerOrigin };
  }

  async revoke(input: EnvironmentCredentialSubject): Promise<void> {
    const response = await this.#request("DELETE", EnvironmentCredentialSubjectSchema, input);
    if (response.status !== 204) {
      throw new ProviderUnavailableError(
        "Credential broker",
        "revocation response must be an empty 204 acknowledgment",
      );
    }
    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new ProviderUnavailableError("Credential broker", "invalid revocation response", cause);
    }
    if (body !== "") {
      throw new ProviderUnavailableError(
        "Credential broker",
        "revocation response must be an empty 204 acknowledgment",
      );
    }
  }

  async #request<S extends Schema.ConstraintDecoder<unknown>>(
    method: "POST" | "DELETE",
    requestSchema: S,
    input: unknown,
  ): Promise<Response> {
    const body = decodeUnknownStrict(requestSchema, input);
    let response: Response;
    try {
      response = await this.#fetcher.fetch(this.#endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${this.#authorization}`,
          "Content-Type": "application/json",
        },
        body: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(body),
      });
    } catch (cause) {
      throw new ProviderUnavailableError("Credential broker", "request failed", cause);
    }
    if (!response.ok) {
      try {
        decodeUnknownStrict(EnvironmentCredentialFailureFromJsonSchema, await response.text());
      } catch (cause) {
        throw new ProviderUnavailableError("Credential broker", "invalid failure response", cause);
      }
      throw new ProviderUnavailableError(
        "Credential broker",
        method === "POST" ? "lease request rejected" : "revocation request rejected",
      );
    }
    return response;
  }
}

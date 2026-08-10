export interface EnvironmentCredentialLease {
  readonly generationToken: string;
  readonly brokerOrigin: string;
  readonly expiresAt: string;
}

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

const requireObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Credential broker returned an invalid response");
  }
  return value as Record<string, unknown>;
};

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Credential broker returned invalid ${field}`);
  }
  return value;
};

const requireHttpsOrigin = (value: unknown): string => {
  const url = new URL(requireNonEmptyString(value, "brokerOrigin"));
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Credential broker returned invalid brokerOrigin");
  }
  return url.origin;
};

export class FetcherEnvironmentCredentialBroker implements EnvironmentCredentialBroker {
  readonly #fetcher: { fetch(input: string, init?: RequestInit): Promise<Response> };
  readonly #endpoint: string;
  readonly #authorization: string;

  constructor(
    fetcher: { fetch(input: string, init?: RequestInit): Promise<Response> },
    endpoint: string,
    authorization: string,
  ) {
    this.#fetcher = fetcher;
    this.#endpoint = endpoint;
    this.#authorization = authorization;
  }

  async lease(
    input: EnvironmentCredentialSubject & {
      readonly repository: { readonly owner: string; readonly name: string };
      readonly provider: "claude" | "codex";
    },
  ): Promise<EnvironmentCredentialLease> {
    const response = await this.#request("POST", input);
    const payload = requireObject(await response.json());
    const expiresAt = requireNonEmptyString(payload["expiresAt"], "expiresAt");
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new Error("Credential broker returned invalid expiresAt");
    }
    return {
      generationToken: requireNonEmptyString(payload["generationToken"], "generationToken"),
      brokerOrigin: requireHttpsOrigin(payload["brokerOrigin"]),
      expiresAt,
    };
  }

  async revoke(input: EnvironmentCredentialSubject): Promise<void> {
    await this.#request("DELETE", input);
  }

  async #request(method: "POST" | "DELETE", body: unknown): Promise<Response> {
    const response = await this.#fetcher.fetch(this.#endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${this.#authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Credential broker rejected the ${method === "POST" ? "lease" : "revocation"} request with ${String(response.status)}`,
      );
    }
    return response;
  }
}

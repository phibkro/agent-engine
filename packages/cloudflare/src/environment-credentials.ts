export interface EnvironmentCredentialLease {
  readonly environment: Readonly<Record<string, string>>;
}

export interface EnvironmentCredentialBroker {
  lease(input: {
    readonly environmentId: string;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly provider: "claude" | "codex";
  }): Promise<EnvironmentCredentialLease>;
}

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

  async lease(input: {
    readonly environmentId: string;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly provider: "claude" | "codex";
  }): Promise<EnvironmentCredentialLease> {
    const response = await this.#fetcher.fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(
        `Credential broker rejected the lease request with ${String(response.status)}`,
      );
    }
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("environment" in payload)) {
      throw new Error("Credential broker returned an invalid lease");
    }
    const environment = payload.environment;
    if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
      throw new Error("Credential broker returned invalid environment variables");
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string") {
        throw new Error("Credential broker returned invalid environment variables");
      }
      values[name] = value;
    }
    if (values["GITHUB_TOKEN"] === undefined) {
      throw new Error("Credential lease does not include GITHUB_TOKEN");
    }
    return { environment: values };
  }
}

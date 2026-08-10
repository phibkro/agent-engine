import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  SessionHostReceiptSchema,
  SessionStartSpecSchema,
  WorkspaceLeaseSchema,
  WorkspaceReadySchema,
  type SessionHostReceipt,
  type SessionHost,
  type SessionStartSpec,
  type SessionId,
  type WorkspaceLease,
  type WorkspaceReady,
} from "@work-engine/protocol";
import {
  SessionHostCancelRequestSchema,
  SessionHostWireResponseSchema,
  type SessionHostWireResponse,
} from "@work-engine/runtime";
import type { SessionHostError } from "@work-engine/runtime";

const json = (value: unknown): string => JSON.stringify(value);
const decode = <S extends Schema.Top>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const mapFailure = (response: SessionHostWireResponse): SessionHostError | undefined => {
  if (response._tag !== "SessionHostWireFailure") return undefined;
  switch (response.code) {
    case "lease_expired":
      return { _tag: "LeaseExpired", resourceId: "res_unknown" as never };
    case "workspace_unavailable":
      return { _tag: "WorkspaceUnavailable", reason: response.reason };
    case "readiness_failed":
      return { _tag: "ReadinessFailed", reason: response.reason };
    case "version_mismatch":
      return { _tag: "VersionMismatch", reason: response.reason };
    case "session_not_found":
      return { _tag: "SessionNotFound", sessionId: "ses_unknown" as never };
    case "session_already_started":
      return { _tag: "SessionAlreadyStarted", sessionId: "ses_unknown" as never };
    case "process_unavailable":
      return { _tag: "ProcessUnavailable", reason: response.reason };
    case "model_unavailable":
      return { _tag: "ModelUnavailable", reason: response.reason };
    case "host_unavailable":
    case "decode_failure":
      return { _tag: "HostUnavailable", reason: response.reason };
  }
};

const readResponse = async (response: Response): Promise<SessionHostWireResponse> => {
  const payload: unknown = await response.json();
  return decode(SessionHostWireResponseSchema, payload);
};

export class CloudflareSessionHost implements SessionHost {
  readonly #binding: Fetcher;
  readonly #headers: HeadersInit;

  constructor(binding: Fetcher, headers: HeadersInit = {}) {
    this.#binding = binding;
    this.#headers = headers;
  }

  #request(path: string, body: unknown): Effect.Effect<SessionHostWireResponse, SessionHostError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await this.#binding.fetch(`https://session-host${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.#headers },
          body: json(body),
        });
        if (!response.ok) {
          throw {
            _tag: "HostUnavailable",
            reason: `Session host returned ${response.status}`,
          } satisfies SessionHostError;
        }
        const decoded = await readResponse(response);
        const failure = mapFailure(decoded);
        if (failure !== undefined) throw failure;
        return decoded;
      },
      catch: (cause) => {
        if (typeof cause === "object" && cause !== null && "_tag" in cause)
          return cause as SessionHostError;
        return {
          _tag: "HostUnavailable",
          reason: cause instanceof Error ? cause.message : "Session host request failed",
        };
      },
    });
  }

  ensureReady(lease: WorkspaceLease): Effect.Effect<WorkspaceReady, SessionHostError> {
    return this.#request(
      "/v1/session-host/workspaces/ensure-ready",
      decode(WorkspaceLeaseSchema, lease),
    ).pipe(
      Effect.flatMap((response) =>
        response._tag === "WorkspaceReady"
          ? Effect.succeed(decode(WorkspaceReadySchema, response))
          : Effect.fail({
              _tag: "HostUnavailable",
              reason: "Session host returned a non-readiness receipt",
            }),
      ),
    );
  }

  start(spec: SessionStartSpec): Effect.Effect<SessionHostReceipt, SessionHostError> {
    return this.#request(
      "/v1/session-host/sessions/start",
      decode(SessionStartSpecSchema, spec),
    ).pipe(
      Effect.flatMap((response) =>
        response._tag === "SessionHostReceipt"
          ? Effect.succeed(decode(SessionHostReceiptSchema, response))
          : Effect.fail({
              _tag: "HostUnavailable",
              reason: "Session host returned a non-start receipt",
            }),
      ),
    );
  }

  cancel(
    sessionId: SessionId,
    reason: string,
  ): Effect.Effect<SessionHostReceipt, SessionHostError> {
    return this.#request(
      "/v1/session-host/sessions/cancel",
      decode(SessionHostCancelRequestSchema, {
        _tag: "SessionHostCancelRequest",
        sessionId,
        reason,
      }),
    ).pipe(
      Effect.flatMap((response) =>
        response._tag === "SessionHostReceipt"
          ? Effect.succeed(decode(SessionHostReceiptSchema, response))
          : Effect.fail({
              _tag: "HostUnavailable",
              reason: "Session host returned a non-cancel receipt",
            }),
      ),
    );
  }
}

export const SessionHostService = Context.Service<SessionHost>("work-engine/SessionHost");

export const SessionHostLive = (
  binding: Fetcher,
  headers: HeadersInit = {},
): Layer.Layer<SessionHost> =>
  Layer.succeed(SessionHostService, new CloudflareSessionHost(binding, headers));

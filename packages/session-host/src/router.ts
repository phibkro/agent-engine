import type {
  SessionStartSpec,
  WorkspaceLease,
} from "@work-engine/protocol";
import {
  SessionHostCancelRequestSchema,
  SessionHostWireResponseSchema,
  type SessionHostCancelRequest,
  type SessionHostError,
  type SessionHostWireFailure,
  type SessionHostWireResponse,
} from "@work-engine/runtime";
import {
  SessionStartSpecSchema,
  WorkspaceLeaseSchema,
  decodeUnknownStrict,
} from "@work-engine/protocol";
import { SessionHostService } from "./host.ts";
import type { EffectExecutor } from "./execution.ts";

export const SESSION_HOST_ROUTES = {
  ensureReady: "/v1/session-host/workspaces/ensure-ready",
  start: "/v1/session-host/sessions/start",
  cancel: "/v1/session-host/sessions/cancel",
} as const;

export interface SessionHostAccessCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SessionHostRouterOptions {
  readonly host: SessionHostService;
  readonly access: SessionHostAccessCredentials;
  readonly effectExecutor: EffectExecutor;
}

/** HTTP adapter for the three shared SessionHost routes. */
export class SessionHostRouter {
  constructor(private readonly options: SessionHostRouterOptions) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.authorized(request.headers))
      return json(
        {
          _tag: "SessionHostWireFailure",
          code: "host_unavailable",
          reason: "Access service token required",
        },
        401,
      );
    if (request.method !== "POST")
      return json(
        { _tag: "SessionHostWireFailure", code: "decode_failure", reason: "POST required" },
        405,
      );
    try {
      const input = (await request.json()) as unknown;
      if (url.pathname === SESSION_HOST_ROUTES.ensureReady) {
        const lease = decodeUnknownStrict(WorkspaceLeaseSchema, input);
        return this.success(
          await this.options.effectExecutor.execute(this.options.host.ensureReady(lease)),
        );
      }
      if (url.pathname === SESSION_HOST_ROUTES.start) {
        const spec = decodeUnknownStrict(SessionStartSpecSchema, input);
        return this.success(
          await this.options.effectExecutor.execute(this.options.host.start(spec)),
        );
      }
      if (url.pathname === SESSION_HOST_ROUTES.cancel) {
        const cancellation = decodeUnknownStrict(SessionHostCancelRequestSchema, input);
        return this.success(
          await this.options.effectExecutor.execute(
            this.options.host.cancel(cancellation.sessionId, cancellation.reason),
          ),
        );
      }
      return json(
        { _tag: "SessionHostWireFailure", code: "decode_failure", reason: "route not found" },
        404,
      );
    } catch (error) {
      if (isSessionHostError(error)) return this.failure(error);
      return json(
        { _tag: "SessionHostWireFailure", code: "decode_failure", reason: errorMessage(error) },
        400,
      );
    }
  }

  private authorized(headers: Headers): boolean {
    if (headers.has("authorization")) return false;
    return (
      headers.get("CF-Access-Client-Id") === this.options.access.clientId &&
      headers.get("CF-Access-Client-Secret") === this.options.access.clientSecret
    );
  }

  private success(value: SessionHostWireResponse): Response {
    try {
      const decoded = decodeUnknownStrict(SessionHostWireResponseSchema, value);
      return json(decoded, 200);
    } catch (error) {
      return json(
        { _tag: "SessionHostWireFailure", code: "decode_failure", reason: errorMessage(error) },
        500,
      );
    }
  }

  private failure(error: SessionHostError): Response {
    const code = wireCode(error);
    const status = errorStatus(error);
    return json({ _tag: "SessionHostWireFailure", code, reason: wireReason(error) }, status);
  }
}

export const decodeEnsureReadyRequest = (input: unknown): WorkspaceLease =>
  decodeUnknownStrict(WorkspaceLeaseSchema, input);
export const decodeStartRequest = (input: unknown): SessionStartSpec =>
  decodeUnknownStrict(SessionStartSpecSchema, input);
export const decodeCancelRequest = (input: unknown): SessionHostCancelRequest =>
  decodeUnknownStrict(SessionHostCancelRequestSchema, input);

const wireCode = (error: SessionHostError): SessionHostWireFailure["code"] => {
  switch (error._tag) {
    case "LeaseExpired":
      return "lease_expired";
    case "WorkspaceUnavailable":
      return "workspace_unavailable";
    case "ReadinessFailed":
      return "readiness_failed";
    case "VersionMismatch":
      return "version_mismatch";
    case "SessionNotFound":
      return "session_not_found";
    case "SessionAlreadyStarted":
      return "session_already_started";
    case "ProcessUnavailable":
      return "process_unavailable";
    case "ModelUnavailable":
      return "model_unavailable";
    case "HostUnavailable":
      return "host_unavailable";
  }
};
const wireReason = (error: SessionHostError): string => {
  switch (error._tag) {
    case "LeaseExpired":
      return `lease expired: ${error.resourceId}`;
    case "SessionNotFound":
    case "SessionAlreadyStarted":
      return `session ${error.sessionId}`;
    default:
      return error.reason;
  }
};

const errorStatus = (error: SessionHostError): number => {
  switch (error._tag) {
    case "LeaseExpired":
    case "SessionAlreadyStarted":
      return 409;
    case "SessionNotFound":
      return 404;
    case "ReadinessFailed":
    case "WorkspaceUnavailable":
    case "ProcessUnavailable":
    case "ModelUnavailable":
    case "HostUnavailable":
      return 503;
    case "VersionMismatch":
      return 424;
  }
};

const isSessionHostError = (error: unknown): error is SessionHostError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  [
    "LeaseExpired",
    "WorkspaceUnavailable",
    "ReadinessFailed",
    "VersionMismatch",
    "SessionNotFound",
    "SessionAlreadyStarted",
    "ProcessUnavailable",
    "ModelUnavailable",
    "HostUnavailable",
  ].includes(String(error._tag));
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

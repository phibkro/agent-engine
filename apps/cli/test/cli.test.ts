import { describe, expect, test } from "vitest";
import { Cause, Effect, Layer, Schema } from "effect";
import * as Redacted from "effect/Redacted";
import { makeCloudTaskClient, type CloudTaskClientError } from "../src/client.ts";
import {
  decodeOperatorConfig,
  OperatorCredentialFileSchema,
  type ConfigFileSystem,
} from "../src/config.ts";
import { executeInvocation, parseInvocation } from "../src/commands.ts";
import { handleMcpRequest, runMcp } from "../src/mcp.ts";
import { exitCodeFor, failureEnvelope, renderJson } from "../src/output.ts";
import {
  CloudTaskClient as CloudTaskClientService,
  CloudTaskUnauthorized,
  type CloudTaskClient,
} from "@work-engine/runtime";
import { AcceptedCursorSchema, MessageIdSchema, SessionIdSchema } from "@work-engine/protocol";

const config = {
  baseUrl: "https://work.example",
  accessClientId: Redacted.make("access-client"),
  accessClientSecret: Redacted.make("access-secret"),
  cloudTaskToken: Redacted.make("cloud-task-token"),
} as const;

const sessionId = SessionIdSchema.make("ses_00000000-0000-4000-8000-000000000001");
const messageId = MessageIdSchema.make("msg_00000000-0000-4000-8000-000000000002");

const successfulResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const failureResponse = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = { "content-type": "application/json" },
): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });

const fakeFiles = (
  files: Readonly<Record<string, string>>,
  mode = 0o600,
  uid = 1000,
): ConfigFileSystem => ({
  readText: (path) =>
    path in files
      ? Effect.succeed(files[path] as string)
      : Effect.fail({ _tag: "ConfigIoFailure" as const, path, reason: "ENOENT" }),
  inspect: (path) =>
    path in files
      ? Effect.succeed({ uid, mode })
      : Effect.fail({ _tag: "ConfigIoFailure" as const, path, reason: "ENOENT" }),
  currentUid: () => uid,
});

describe("0002 CLI public interface", () => {
  test("parses exactly the five session operations", () => {
    expect(
      parseInvocation(["session", "spawn", "--session-id", sessionId, "--task-file", "task.json"]),
    ).toEqual({
      operation: "spawn",
      options: { "session-id": sessionId, "task-file": "task.json" },
    });
    expect(
      parseInvocation([
        "session",
        "send",
        "--session-id",
        sessionId,
        "--message-id",
        messageId,
        "--message",
        "continue",
      ]),
    ).toEqual({
      operation: "send",
      options: { "session-id": sessionId, "message-id": messageId, message: "continue" },
    });
    expect(
      parseInvocation(["session", "observe", "--session-id", sessionId, "--after", "3"]),
    ).toMatchObject({ operation: "observe" });
    expect(
      parseInvocation([
        "session",
        "cancel",
        "--session-id",
        sessionId,
        "--reason",
        "operator requested",
      ]),
    ).toMatchObject({ operation: "cancel" });
    expect(parseInvocation(["session", "result", "--session-id", sessionId])).toMatchObject({
      operation: "result",
    });
    expect(parseInvocation(["attach", "--session-id", sessionId])).toMatchObject({
      _tag: "UsageFailure",
    });
    expect(
      parseInvocation([
        "session",
        "send",
        "--session-id",
        sessionId,
        "--message-id",
        messageId,
        "--message",
        "a",
        "--message",
        "b",
      ]),
    ).toMatchObject({ _tag: "UsageFailure" });
  });

  test("uses caller IDs and exact authenticated routes and bodies", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(url), init: init ?? {} });
      return successfulResponse({});
    };
    const client = makeCloudTaskClient(config, { fetch: fetcher });
    const failure = await Effect.runPromiseExit(client.send(sessionId, messageId, "continue"));
    expect(failure._tag).toBe("Failure");
    expect(requests[0]?.url).toBe("https://work.example/v1/cloud-tasks");
    expect(requests[0]?.init.redirect).toBe("manual");
    const headers = requests[0]?.init.headers as Headers;
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client");
    expect(headers.get("CF-Access-Client-Secret")).toBe("access-secret");
    expect(headers.get("Authorization")).toBe("Bearer cloud-task-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
        String(requests[0]?.init.body),
      ),
    ).toEqual({
      _tag: "Send",
      sessionId,
      messageId,
      message: "continue",
    });
  });

  test("strictly rejects malformed response payloads", async () => {
    const client = makeCloudTaskClient(config, {
      fetch: async () =>
        successfulResponse({ _tag: "Observed", observations: [{ unexpected: true }] }),
    });
    const result = await Effect.runPromiseExit(client.observe(sessionId, 0));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("CloudTaskRejected");
    }
  });

  test("requires HTTPS origins without userinfo and normalizes to origin", async () => {
    const credentialPath = "/run/user/1000/work-engine.json";
    const credentialText = JSON.stringify({
      accessClientId: "access-client",
      accessClientSecret: "access-secret",
      cloudTaskToken: "cloud-task-token",
    });
    const files = fakeFiles({ [credentialPath]: credentialText });
    const normalized = await Effect.runPromise(
      decodeOperatorConfig(
        {
          WORK_ENGINE_BASE_URL: "https://work.example:8443/service?ignored=true",
          WORK_ENGINE_CREDENTIAL_FILE: credentialPath,
        },
        files,
      ),
    );
    expect(normalized.baseUrl).toBe("https://work.example:8443");

    await Promise.all(
      ["http://work.example", "https://operator:secret@work.example"].map(async (baseUrl) => {
        const result = await Effect.runPromiseExit(
          decodeOperatorConfig(
            { WORK_ENGINE_BASE_URL: baseUrl, WORK_ENGINE_CREDENTIAL_FILE: credentialPath },
            files,
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(String(result.cause)).toContain("ConfigDecodeFailure");
          expect(String(result.cause)).not.toContain("secret");
        }
      }),
    );
  });

  test("does not expose unexpected credential values on schema failure", async () => {
    const secret = "unexpected-secret-value";
    const result = await Effect.runPromiseExit(
      decodeOperatorConfig(
        {
          WORK_ENGINE_BASE_URL: "https://work.example",
          WORK_ENGINE_CREDENTIAL_FILE: "/run/user/1000/work-engine.json",
        },
        fakeFiles({
          "/run/user/1000/work-engine.json": JSON.stringify({
            accessClientId: "access-client",
            accessClientSecret: "access-secret",
            cloudTaskToken: "cloud-task-token",
            unexpected: secret,
          }),
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.cause)).toContain("credential file failed schema validation");
      expect(String(result.cause)).not.toContain(secret);
    }
  });

  test("maps canonical CloudTask failures only with their exact statuses", async () => {
    const failedAt = "2026-08-10T00:00:00.000Z";
    const terminalState = {
      _tag: "Failed",
      sessionId,
      cursor: 1,
      failedAt,
      reason: "worker failed",
    };
    const cases = [
      {
        status: 401,
        body: { _tag: "Unauthenticated", reason: "not signed in" },
        expected: { _tag: "CloudTaskUnauthorized", reason: "not signed in" },
      },
      {
        status: 403,
        body: { _tag: "Unauthorized", reason: "credentials denied" },
        expected: { _tag: "CloudTaskUnauthorized", reason: "credentials denied" },
      },
      {
        status: 400,
        body: { _tag: "InvalidRequest", reason: "invalid request" },
        expected: { _tag: "CloudTaskRejected", reason: "invalid request" },
      },
      {
        status: 404,
        body: { _tag: "SessionNotFound", reason: "session missing", sessionId },
        expected: { _tag: "CloudTaskNotFound", sessionId },
      },
      {
        status: 409,
        body: { _tag: "SessionConflict", reason: "session conflict" },
        expected: { _tag: "CloudTaskRejected", reason: "session conflict" },
      },
      {
        status: 409,
        body: { _tag: "SessionTerminal", reason: "session ended", state: terminalState },
        expected: { _tag: "CloudTaskTerminal", sessionId, state: terminalState },
      },
      {
        status: 503,
        body: { _tag: "ProviderUnavailable", reason: "provider unavailable" },
        expected: { _tag: "CloudTaskUnavailable", reason: "provider unavailable" },
      },
    ] as const;

    await Promise.all(
      cases.map(async (failure) => {
        const client = makeCloudTaskClient(config, {
          fetch: async () => failureResponse(failure.status, failure.body),
        });
        const result = await Effect.runPromiseExit(client.result(sessionId));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const [reason] = result.cause.reasons;
          expect(reason?._tag).toBe("Fail");
          if (reason !== undefined && Cause.isFailReason(reason)) {
            expect(reason.error).toMatchObject(failure.expected);
          }
        }
      }),
    );
  });

  test("turns malformed and mismatched failure envelopes into unavailable errors", async () => {
    const cases = [
      {
        status: 503,
        body: '{"_tag":"ProviderUnavailable","reason":"malformed-secret"',
        leaked: "malformed-secret",
      },
      {
        status: 400,
        body: { _tag: "ProviderUnavailable", reason: "mismatched-provider-secret" },
        leaked: "mismatched-provider-secret",
      },
      {
        status: 403,
        body: { _tag: "Unauthorized", reason: "unauthorized-secret", extra: true },
        leaked: "unauthorized-secret",
      },
    ] as const;

    await Promise.all(
      cases.map(async (failure) => {
        const client = makeCloudTaskClient(config, {
          fetch: async () => failureResponse(failure.status, failure.body),
        });
        const result = await Effect.runPromiseExit(client.result(sessionId));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const [reason] = result.cause.reasons;
          expect(reason?._tag).toBe("Fail");
          if (reason !== undefined && Cause.isFailReason(reason)) {
            expect(reason.error._tag).toBe("CloudTaskUnavailable");
            if (reason.error._tag === "CloudTaskUnavailable") {
              expect(reason.error.reason).not.toContain(failure.leaked);
            }
          }
        }
      }),
    );
  });

  test("keeps Cloudflare Access responses separate from application failures", async () => {
    const access = await Effect.runPromiseExit(
      makeCloudTaskClient(config, {
        fetch: async () =>
          failureResponse(403, "<html>Cloudflare Access denied</html>", {
            "content-type": "text/html",
          }),
      }).result(sessionId),
    );
    expect(access._tag).toBe("Failure");
    if (access._tag === "Failure") {
      const [reason] = access.cause.reasons;
      expect(reason?._tag).toBe("Fail");
      if (reason !== undefined && Cause.isFailReason(reason)) {
        expect(reason.error).toMatchObject({
          _tag: "CloudTaskUnauthorized",
          reason: "Cloudflare Access rejected the service credentials",
        });
        if (reason.error._tag === "CloudTaskUnauthorized") {
          expect(reason.error.reason).not.toContain("Cloudflare Access denied");
        }
      }
    }

    await Promise.all(
      [
        failureResponse(403, "<html>generic denial</html>", { "content-type": "text/html" }),
        failureResponse(403, '{"_tag":"Unauthorized","reason":', {
          "content-type": "application/json",
        }),
        failureResponse(302, "<html>Cloudflare Access login</html>", {
          "content-type": "text/html",
          location: "https://login.example",
        }),
      ].map(async (response) => {
        const result = await Effect.runPromiseExit(
          makeCloudTaskClient(config, { fetch: async () => response }).result(sessionId),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const [reason] = result.cause.reasons;
          expect(reason?._tag).toBe("Fail");
          if (reason !== undefined && Cause.isFailReason(reason)) {
            expect(reason.error._tag).toBe("CloudTaskUnavailable");
          }
        }
      }),
    );
  });

  test("rejects missing and non-private credential files", async () => {
    const environment = {
      WORK_ENGINE_BASE_URL: "https://work.example",
      WORK_ENGINE_CREDENTIAL_FILE: "/run/user/1000/work-engine.json",
    };
    const missing = await Effect.runPromiseExit(decodeOperatorConfig(environment, fakeFiles({})));
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") expect(String(missing.cause)).toContain("ConfigMissing");

    const nonPrivate = await Effect.runPromiseExit(
      decodeOperatorConfig(
        environment,
        fakeFiles(
          {
            "/run/user/1000/work-engine.json": JSON.stringify({
              accessClientId: "access-client",
              accessClientSecret: "access-secret",
            }),
          },
          0o640,
        ),
      ),
    );
    expect(nonPrivate._tag).toBe("Failure");
    if (nonPrivate._tag === "Failure")
      expect(String(nonPrivate.cause)).toContain("ConfigPermissions");
  });

  test("keeps decoded credentials redacted and non-encodable", async () => {
    const credentialText = JSON.stringify({
      accessClientId: "access-client",
      accessClientSecret: "access-secret",
      cloudTaskToken: "cloud-task-token",
    });
    const loaded = await Effect.runPromise(
      decodeOperatorConfig(
        {
          WORK_ENGINE_BASE_URL: "https://work.example",
          WORK_ENGINE_CREDENTIAL_FILE: "/run/user/1000/work-engine.json",
        },
        fakeFiles({ "/run/user/1000/work-engine.json": credentialText }),
      ),
    );

    expect(String(loaded.accessClientId)).not.toContain("access-client");
    expect(String(loaded.accessClientSecret)).not.toContain("access-secret");
    expect(String(loaded.cloudTaskToken)).not.toContain("cloud-task-token");
    expect(() =>
      Schema.encodeSync(OperatorCredentialFileSchema)({
        accessClientId: loaded.accessClientId,
        accessClientSecret: loaded.accessClientSecret,
        cloudTaskToken: loaded.cloudTaskToken,
      }),
    ).toThrow();
  });

  test("preserves structured JSON through MCP Send and loops in one Effect", async () => {
    const messages: unknown[] = [];
    const client: CloudTaskClient = {
      spawn: () => Effect.die("unused"),
      send: (_sessionId, _messageId, message) => {
        messages.push(message);
        return Effect.succeed(AcceptedCursorSchema.make(1));
      },
      observe: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      result: () => Effect.die("unused"),
    };
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "session_send",
      params: {
        sessionId,
        messageId,
        message: { nested: [true, null, 42] },
      },
    };

    await expect(Effect.runPromise(handleMcpRequest(client, request))).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: 1,
    });

    const input = [JSON.stringify(request), "{", undefined];
    const output: string[] = [];
    await Effect.runPromise(
      runMcp(client, {
        readLine: Effect.sync(() => input.shift()),
        writeLine: (line) =>
          Effect.sync(() => {
            output.push(line);
          }),
      }),
    );

    expect(messages).toEqual([{ nested: [true, null, 42] }, { nested: [true, null, 42] }]);
    expect(
      output.map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line)),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, result: 1 },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON-RPC input" },
      },
    ]);
  });

  test("executes commands from the provided live client Layer", async () => {
    const client: CloudTaskClient = {
      spawn: () => Effect.die("unused"),
      send: () => Effect.succeed(AcceptedCursorSchema.make(7)),
      observe: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      result: () => Effect.die("unused"),
    };
    const invocation = parseInvocation([
      "session",
      "send",
      "--session-id",
      sessionId,
      "--message-id",
      messageId,
      "--message",
      "continue",
    ]);
    expect("_tag" in invocation).toBe(false);
    if ("_tag" in invocation) return;

    await expect(
      Effect.runPromise(
        executeInvocation(invocation).pipe(
          Effect.provide(Layer.succeed(CloudTaskClientService, client)),
        ),
      ),
    ).resolves.toBe(7);
  });

  test("renders typed failures without a fallback reason", () => {
    const failure: CloudTaskClientError = new CloudTaskUnauthorized({
      reason: "Access denied",
    });
    const envelope = failureEnvelope("result", failure);
    expect(envelope.failure).toEqual(failure);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(renderJson(envelope)),
    ).toMatchObject({
      ok: false,
      failure: { _tag: "CloudTaskUnauthorized", reason: "Access denied" },
    });
    expect(exitCodeFor(failure)).toBeGreaterThan(0);
  });
});

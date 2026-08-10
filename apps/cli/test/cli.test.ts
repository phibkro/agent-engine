import { describe, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import * as Redacted from "effect/Redacted";
import { makeCloudTaskClient, type CloudTaskClientError } from "../src/client.ts";
import {
  decodeOperatorConfig,
  OperatorCredentialFileSchema,
  type ConfigFileSystem,
} from "../src/config.ts";
import { handleMcpRequest, runMcp } from "../src/mcp.ts";
import { parseInvocation } from "../src/commands.ts";
import { exitCodeFor, failureEnvelope, renderJson } from "../src/output.ts";
import { AcceptedCursorSchema, MessageIdSchema, SessionIdSchema } from "@work-engine/protocol";
import type { CloudTaskClient } from "@work-engine/runtime";

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
    const headers = requests[0]?.init.headers as Headers;
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client");
    expect(headers.get("CF-Access-Client-Secret")).toBe("access-secret");
    expect(headers.get("Authorization")).toBe("Bearer cloud-task-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
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
      output.map((line) => Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line)),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, result: 1 },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON-RPC input" },
      },
    ]);
  });

  test("renders typed failures without a fallback reason", () => {
    const failure: CloudTaskClientError = {
      _tag: "CloudTaskUnauthorized",
      reason: "Access denied",
    };
    const envelope = failureEnvelope("result", failure);
    expect(envelope.failure).toEqual(failure);
    expect(JSON.parse(renderJson(envelope))).toMatchObject({ ok: false, failure });
    expect(exitCodeFor(failure)).toBeGreaterThan(0);
  });
});

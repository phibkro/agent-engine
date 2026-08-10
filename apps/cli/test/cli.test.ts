import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { makeCloudTaskClient, type CloudTaskClientError } from "../src/client.ts";
import { decodeOperatorConfig, type ConfigFileSystem } from "../src/config.ts";
import { parseInvocation } from "../src/commands.ts";
import { exitCodeFor, failureEnvelope, renderJson } from "../src/output.ts";
import { MessageIdSchema, SessionIdSchema } from "@work-engine/protocol";

const config = {
  baseUrl: "https://work.example",
  accessClientId: "access-client",
  accessClientSecret: "access-secret",
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
    expect(requests[0]?.url).toBe(
      `https://work.example/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    );
    const headers = requests[0]?.init.headers as Headers;
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client");
    expect(headers.get("CF-Access-Client-Secret")).toBe("access-secret");
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

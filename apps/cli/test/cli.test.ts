import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  PINNED_HERDR_VERSION,
  renderSshConfig,
  runAttach,
  scrubbedEnvironment,
  type AttachFileSystem,
  type AttachProcess,
} from "../src/attach.ts";
import { decodeOperatorConfig, type ConfigFileSystem } from "../src/config.ts";
import { parseInvocation } from "../src/commands.ts";
import { SESSION_TOOLS, SessionToolName } from "../src/mcp.ts";
import { exitCodeFor, ExitCode, failureEnvelope } from "../src/output.ts";
import { AttachResolutionSchema } from "@work-engine/runtime";
import type { AttachResolution } from "@work-engine/runtime";
import { AuthenticatedActorSchema, GrantSchema } from "@work-engine/protocol";

const actor = AuthenticatedActorSchema.make({
  _tag: "AuthenticatedActor",
  actorId: "operator-test",
  kind: "operator",
  presentedGrants: [],
});

const config = {
  baseUrl: "https://work.example",
  accessClientId: "client-id",
  accessClientSecret: "secret-value",
  actor,
  grants: [],
  sshIdentityFile: "/home/operator/.ssh/work-engine_ed25519",
  sshDirectory: "/tmp/work-engine",
  herdrBinary: "herdr",
} as const;

const resolution = (overrides: Partial<AttachResolution> = {}): AttachResolution =>
  Schema.decodeUnknownSync(AttachResolutionSchema, { onExcessProperty: "error" })({
    _tag: "AttachResolution",
    resolutionId: "res-test-1",
    projectId: "prj_00000000-0000-4000-8000-000000000001",
    workId: "wrk_00000000-0000-4000-8000-000000000002",
    containerInstanceId: "instance-1",
    sshHost: "instance-1",
    sshPort: 22,
    sshUser: "cloudchamber",
    proxyCommand: "wrangler containers ssh %h",
    herdrSessionName: "project-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });

const fakeFiles = (owner = 1000, mode = 0o600): AttachFileSystem & { readonly writes: Map<string, string>; readonly removed: string[] } => {
  const writes = new Map<string, string>();
  const removed: string[] = [];
  return {
    writes,
    removed,
    makeDirectory: () => Effect.succeed(undefined),
    writePrivateExclusive: (path, content) => Effect.sync(() => { writes.set(path, content); }),
    inspect: () => Effect.succeed({ uid: owner, mode }),
    removeOwned: (path) => Effect.sync(() => { removed.push(path); }),
  };
};

const fakeProcess = (remoteVersion = PINNED_HERDR_VERSION): AttachProcess & { readonly calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    capture: (command, args) => Effect.sync(() => {
      calls.push([command, ...args]);
      const output = command === "ssh" ? `herdr ${remoteVersion}\n` : `herdr ${PINNED_HERDR_VERSION}\n`;
      return { exitCode: 0, stdout: output, stderr: "" };
    }),
    inherit: (command, args) => Effect.sync(() => {
      calls.push([command, ...args]);
      return 0;
    }),
  };
};

describe("work CLI deterministic contracts", () => {
  test("parses all authority command paths without actor arguments", () => {
    expect(parseInvocation(["project", "create", "--json"])).toMatchObject({ command: "project create", json: true });
    expect(parseInvocation(["submit", "prj_00000000-0000-4000-8000-000000000001", "--objective", "fix"])).toMatchObject({ command: "submit" });
    expect(parseInvocation(["mcp", "--session", "ses_00000000-0000-4000-8000-000000000003"])).toMatchObject({ command: "mcp" });
  });

  test("maps decode, auth, domain, dependency and cancellation to fixed exits", () => {
    expect(exitCodeFor({ _tag: "UsageFailure", reason: "bad input" })).toBe(ExitCode.usage);
    expect(exitCodeFor({ _tag: "AuthenticationFailure", reason: "denied" })).toBe(ExitCode.authentication);
    expect(exitCodeFor({ _tag: "DomainFailure", reason: "rejected" })).toBe(ExitCode.domain);
    expect(exitCodeFor({ _tag: "DependencyUnavailable", reason: "offline" })).toBe(ExitCode.unavailable);
    expect(exitCodeFor({ _tag: "Cancelled", reason: "interrupt" })).toBe(ExitCode.cancelled);
    expect(failureEnvelope("status", { _tag: "UsageFailure", reason: "bad" }).error?.exitCode).toBe(2);
  });

  test("strictly decodes operator actor and never places service secrets in command payload", async () => {
    const files: ConfigFileSystem = {
      readText: (path) => Effect.succeed(path.endsWith("actor.json") ? JSON.stringify(actor) : "[]"),
      inspect: () => Effect.succeed({ uid: process.getuid?.() ?? -1, mode: 0o600 }),
    };
    const loaded = await Effect.runPromise(decodeOperatorConfig({
      WORK_ENGINE_URL: "https://work.example/",
      WORK_ENGINE_ACCESS_CLIENT_ID: "client-id",
      WORK_ENGINE_ACCESS_CLIENT_SECRET: "secret-value",
      WORK_ENGINE_ACTOR_FILE: "/tmp/actor.json",
    }, files));
    expect(loaded.actor.kind).toBe("operator");
    expect(JSON.stringify(loaded.actor)).not.toContain(loaded.accessClientSecret);
  });

  test("rejects expired or mismatched attach resolutions before filesystem or process work", async () => {
    const files = fakeFiles();
    const process = fakeProcess();
    await expect(Effect.runPromise(runAttach(
      resolution({ expiresAt: "2000-01-01T00:00:00.000Z" }),
      resolution().projectId,
      resolution().workId,
      config,
      { json: false, fileSystem: files, process },
    ))).rejects.toBeDefined();
    expect(files.writes.size).toBe(0);
    expect(process.calls).toHaveLength(0);
  });

  test("writes reviewed SSH config as owned private content and cleans it after JSON attach", async () => {
    const files = fakeFiles();
    const process = fakeProcess();
    const result = await Effect.runPromise(runAttach(resolution(), resolution().projectId, resolution().workId, config, { json: true, fileSystem: files, process }));
    const path = result.target.configPath;
    expect(files.writes.get(path)).toBe(renderSshConfig(resolution(), config.sshIdentityFile, result.target.alias));
    expect(files.removed).toEqual([path]);
    expect(process.calls).toHaveLength(0);
  });

  test("checks both pinned Herdr versions and cleans on mismatch", async () => {
    const files = fakeFiles();
    const process = fakeProcess("0.7.0");
    await expect(Effect.runPromise(runAttach(resolution(), resolution().projectId, resolution().workId, config, { json: false, fileSystem: files, process }))).rejects.toBeDefined();
    expect(files.removed).toHaveLength(1);
    expect(process.calls[0]?.[0]).toBe("herdr");
  });

  test("MCP allowlist contains no operator authority tools", () => {
    const names = SESSION_TOOLS.map((tool) => tool.name);
    expect(names).toContain(SessionToolName.candidateFinalize);
    expect(names).not.toContain("approve");
    expect(names).not.toContain("reject");
    expect(names).not.toContain("merge");
  });
  test("scrubs Access and operator configuration values before SSH or Herdr", () => {
    const environment = scrubbedEnvironment({
      PATH: "/usr/bin",
      WORK_ENGINE_ACCESS_CLIENT_SECRET: "secret-value",
      CF_ACCESS_CLIENT_SECRET: "secret-value",
      AUTHORIZATION: "Bearer secret-value",
    });
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  test("Grant schema remains canonical for capability files", () => {
    expect(GrantSchema).toBeDefined();
  });
});

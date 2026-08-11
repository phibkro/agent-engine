import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnvironmentSnapshotSchema,
  RuntimeVersionTupleSchema,
  Sha256DigestSchema,
  TimestampSchema,
  decodeUnknownStrict,
} from "@work-engine/protocol";
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: (namespace: DurableObjectNamespace, id: string) =>
    namespace.get(namespace.idFromName(id)),
}));

import { EnvironmentDurableObject } from "../src/environment-do.ts";
import type { PlatformCapabilities } from "../src/contract.ts";
import type { CloudflareRuntimeEnv } from "../src/env.ts";
afterEach(() => {
  vi.unstubAllGlobals();
});

class TestWebSocket {
  readonly listeners = new Map<string, unknown>();
  accepted = false;

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, listener);
  }

  send(data: unknown): void {
    void data;
  }

  close(code?: number, reason?: string): void {
    void code;
    void reason;
  }
}

const now = TimestampSchema.make("2026-08-10T00:00:00.000Z");
const capabilities: PlatformCapabilities = {
  now: () => now,
  uuid: () => "00000000-0000-4000-8000-000000000001",
  sha256: async () => Sha256DigestSchema.make(`sha256:${"a".repeat(64)}`),
};
const versions = decodeUnknownStrict(RuntimeVersionTupleSchema, {
  imageDigest: `sha256:${"a".repeat(64)}`,
  t3codeVersion: "0.9.0",
  sandboxSdkVersion: "0.12.5",
});

const makeSnapshot = (overrides: Record<string, unknown> = {}) =>
  decodeUnknownStrict(EnvironmentSnapshotSchema, {
    _tag: "EnvironmentSnapshot",
    schemaVersion: "work-engine/v2",
    environmentId: "demo-environment",
    ownerId: "operator-1",
    repository: { owner: "example", name: "project" },
    baseCommit: "0".repeat(40),
    provider: "codex",
    lifecycle: "Ready",
    versions,
    generation: null,
    retiredGenerationIds: [],
    acceptedCheckpoint: null,
    dataLossWarning: false,
    retainedCheckpoints: [],
    checkpointFailures: 0,
    checkpointRetryAt: null,
    recoveryFailures: 0,
    recoveryRetryAt: null,
    recoveryRequest: null,
    commandReceipts: [],
    createdAt: now,
    lastActivityAt: now,
    expiresAt: "2026-08-10T08:00:00.000Z",
    inactivityDeadline: "2026-08-10T00:30:00.000Z",
    ...overrides,
  });

const makeState = (initial: unknown) => {
  let value = initial;
  const alarms: number[] = [];
  let deletedAlarms = 0;
  const storage = {
    get: async () => value,
    put: async (_key: string, next: unknown) => {
      value = next;
    },
    setAlarm: async (at: number) => {
      alarms.push(at);
    },
    deleteAlarm: async () => {
      deletedAlarms += 1;
    },
  };
  return {
    state: {
      storage,
      waitUntil: (promise: Promise<unknown>) => {
        void promise;
      },
    } as unknown as DurableObjectState,
    read: () => value,
    alarms,
    deletedAlarms: () => deletedAlarms,
  };
};

const emptySandboxNamespace = {
  idFromName: (name: string) => name,
  get: () => ({}),
};
const emptyDurableObjectNamespace = emptySandboxNamespace as unknown as DurableObjectNamespace;

const makeEnv = (backupBucket: unknown, sandbox = emptySandboxNamespace): CloudflareRuntimeEnv => ({
  SESSION: emptyDurableObjectNamespace,
  PROJECT_MEMORY: emptyDurableObjectNamespace,
  SANDBOX: sandbox as unknown as NonNullable<CloudflareRuntimeEnv["SANDBOX"]>,
  BACKUP_BUCKET: backupBucket as R2Bucket,
  CREDENTIAL_BROKER: { fetch: async () => Response.json({}) } as unknown as Fetcher,
  CREDENTIAL_BROKER_URL: "https://broker.example",
  CREDENTIAL_BROKER_SECRET: "broker-secret",
  ENVIRONMENT_ROUTER_SECRET: "router-secret",
  ENVIRONMENT_PUBLIC_ORIGIN: "https://environment.example",
  ENVIRONMENT_IMAGE_DIGEST: versions.imageDigest,
  T3CODE_VERSION: versions.t3codeVersion,
  SANDBOX_SDK_VERSION: versions.sandboxSdkVersion,
});

describe("EnvironmentDurableObject", () => {
  it("omits snapshot when inspect has no persisted Environment", async () => {
    const state = makeState(undefined);
    const object = new EnvironmentDurableObject(
      state.state,
      makeEnv({ list: async () => ({ objects: [], truncated: false }) }),
      capabilities,
    );

    const response = await object.fetch(
      new Request("https://work.example/v1/environments/demo-environment", {
        headers: { "X-Environment-Internal": "router-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ _tag: "EnvironmentInspected" });
  });

  it("keeps terminal cleanup terminal", async () => {
    const state = makeState(makeSnapshot({ lifecycle: "Failed", dataLossWarning: true }));
    const object = new EnvironmentDurableObject(
      state.state,
      makeEnv({ delete: async () => {} }),
      capabilities,
    );

    await object.alarm();

    expect(decodeUnknownStrict(EnvironmentSnapshotSchema, state.read()).lifecycle).toBe(
      "Destroyed",
    );
    expect(state.deletedAlarms()).toBe(1);
  });

  it("defers a due checkpoint retry while an accepted connection is active", async () => {
    vi.stubGlobal("WebSocketPair", function () {
      return { 0: new TestWebSocket(), 1: new TestWebSocket() };
    });
    const upstream = new TestWebSocket();
    const sandbox = {
      getProcess: async () => ({ getStatus: async () => "running" }),
      wsConnect: async () => ({ webSocket: upstream }) as unknown as Response,
    };
    const namespace = {
      idFromName: (name: string) => name,
      get: () => sandbox,
    };
    const state = makeState(
      makeSnapshot({
        generation: { id: "sandbox-1", ordinal: 1 },
        checkpointRetryAt: "2026-08-09T23:59:00.000Z",
      }),
    );
    const object = new EnvironmentDurableObject(state.state, makeEnv({}, namespace), capabilities);

    const response = await object.fetch(
      new Request("https://work.example/v1/environments/demo-environment/connect/api", {
        headers: {
          "X-Environment-Internal": "router-secret",
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      }),
    );
    expect(response.status).toBe(101);
    await object.alarm();

    expect(state.alarms.at(-1)).toBe(Date.parse("2026-08-10T00:30:00.000Z"));
  });
});

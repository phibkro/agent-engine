import { expect, test } from "vitest";
import {
  EnvironmentCommandRequestSchema,
  EnvironmentCredentialLeaseSchema,
  EnvironmentCreateRequestSchema,
  EnvironmentPairingSchema,
  EnvironmentPairingOutputSchema,
  SandboxProcessStateSchema,
  EnvironmentSnapshotSchema,
  decodeUnknownStrict,
} from "../src/index.ts";

const createRequest = {
  _tag: "CreateEnvironment",
  commandId: "create-00000000-0000-4000-8000-000000000001",
  environmentId: "demo-environment",
  ownerId: "operator-1",
  repository: { owner: "example", name: "project" },
  baseCommit: "0".repeat(40),
  provider: "codex",
};

test("accepts an exact environment creation request and rejects malformed authority", () => {
  expect(decodeUnknownStrict(EnvironmentCreateRequestSchema, createRequest).environmentId).toBe(
    "demo-environment",
  );
  expect(() =>
    decodeUnknownStrict(EnvironmentCreateRequestSchema, {
      ...createRequest,
      environmentId: "Demo_Environment",
    }),
  ).toThrow();
  expect(() =>
    decodeUnknownStrict(EnvironmentCreateRequestSchema, { ...createRequest, admin: true }),
  ).toThrow();
});

test("decodes one durable ready environment with a generation-scoped checkpoint", () => {
  const snapshot = {
    _tag: "EnvironmentSnapshot",
    schemaVersion: "work-engine/v2",
    environmentId: "demo-environment",
    ownerId: "operator-1",
    repository: { owner: "example", name: "project" },
    baseCommit: "0".repeat(40),
    provider: "codex",
    lifecycle: "Ready",
    versions: {
      imageDigest: `sha256:${"a".repeat(64)}`,
      t3codeVersion: "0.9.0",
      sandboxSdkVersion: "1.0.0",
    },
    generation: { id: "sandbox-generation-1", ordinal: 1 },
    retiredGenerationIds: [],
    acceptedCheckpoint: {
      generation: 1,
      stateCapture: "quiesced",
      head: "1".repeat(40),
      versions: {
        imageDigest: `sha256:${"a".repeat(64)}`,
        t3codeVersion: "0.9.0",
        sandboxSdkVersion: "1.0.0",
      },
      backup: { id: "backup-1", dir: "/workspace/environment" },
      validated: true,
      createdAt: "2026-08-10T00:00:00.000Z",
    },
    dataLossWarning: false,
    retainedCheckpoints: [],
    checkpointFailures: 0,
    checkpointRetryAt: null,
    recoveryFailures: 0,
    recoveryRetryAt: null,
    recoveryRequest: null,
    commandReceipts: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    lastActivityAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T08:00:00.000Z",
    inactivityDeadline: "2026-08-10T00:30:00.000Z",
  };

  expect(decodeUnknownStrict(EnvironmentSnapshotSchema, snapshot).lifecycle).toBe("Ready");
});

test("keeps provider secrets and process status behind strict schemas", () => {
  expect(
    decodeUnknownStrict(EnvironmentCredentialLeaseSchema, {
      generationToken: "generation-secret",
      expiresAt: "2026-08-10T00:10:00.000Z",
    }).generationToken,
  ).toBe("generation-secret");
  expect(() =>
    decodeUnknownStrict(EnvironmentCredentialLeaseSchema, {
      generationToken: "generation-secret",
      expiresAt: "2026-08-10T00:10:00.000Z",
      repositoryToken: "must-not-cross-boundary",
    }),
  ).toThrow();
  expect(
    decodeUnknownStrict(EnvironmentPairingOutputSchema, {
      token: "pairing-secret",
      expiresAt: "2026-08-10T00:10:00.000Z",
    }).token,
  ).toBe("pairing-secret");
  expect(decodeUnknownStrict(SandboxProcessStateSchema, { status: "running" }).status).toBe(
    "running",
  );
});

test("accepts only bounded lifecycle commands and ordinary T3Code pairing scopes", () => {
  expect(
    decodeUnknownStrict(EnvironmentCommandRequestSchema, {
      _tag: "RecoverEnvironment",
      commandId: "recover-00000000-0000-4000-8000-000000000001",
      environmentId: "demo-environment",
    })._tag,
  ).toBe("RecoverEnvironment");
  expect(() =>
    decodeUnknownStrict(EnvironmentCommandRequestSchema, {
      _tag: "DestroyEnvironment",
      commandId: "destroy-00000000-0000-4000-8000-000000000001",
      environmentId: "demo-environment",
      force: true,
    }),
  ).toThrow();

  expect(
    decodeUnknownStrict(EnvironmentPairingSchema, {
      endpoint: "https://demo-environment.example.test",
      token: "pairing-secret",
      expiresAt: "2026-08-10T00:10:00.000Z",
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
      ],
    }).scopes,
  ).not.toContain("access:write");
});

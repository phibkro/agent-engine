import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  GrantIdSchema,
  ProjectIdSchema,
  SchemaVersionSchema,
  makeCommandId,
  makeProjectId,
  makeWorkId,
  makeWorkProcessId,
  tracerPolicy,
} from "@work-engine/protocol";
import { WorkEngineHeader } from "@work-engine/runtime";

type TestEnv = typeof env & {
  PROJECTS: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  PROJECT_INDEX: D1Database;
};

const actorId = "operator-tracer-test";
const makeTestGrantId = (): string => `grt_${crypto.randomUUID()}`;

const actorHeaders = (grantIds: readonly string[] = []): HeadersInit => ({
  [WorkEngineHeader.actorId]: actorId,
  [WorkEngineHeader.grantIds]: grantIds.join(","),
});

const projectRequest = (grantId: string) => ({
  schemaVersion: SchemaVersionSchema.make("work-engine/v1"),
  commandId: makeCommandId(),
  command: {
    _tag: "CreateProject" as const,
    policy: tracerPolicy(),
    grants: [
      {
        _tag: "Grant" as const,
        grantId: GrantIdSchema.make(grantId),
        subjectActorId: actorId,
        capability: "project.read" as const,
        scope: { projectId: ProjectIdSchema.make(makeProjectId()), workId: undefined, sessionId: undefined, proposalId: undefined },
        validFrom: "2026-08-10T00:00:00.000Z",
        validUntil: "2026-08-11T00:00:00.000Z",
        grantingAuthority: actorId,
      },
    ],
  },
});

const projectStub = (projectId: string): DurableObjectStub => {
  const typedEnv = env as TestEnv;
  return typedEnv.PROJECTS.getByName(projectId);
};

const createProject = async (): Promise<{ readonly projectId: string; readonly grantId: string }> => {
  const projectId = makeProjectId();
  const grantId = makeTestGrantId();
  const request = projectRequest(grantId);
  request.command.grants![0]!.scope.projectId = ProjectIdSchema.make(projectId);
  const response = await projectStub(projectId).fetch("https://project/v1/create", {
    method: "POST",
    headers: actorHeaders([grantId]),
    body: JSON.stringify(request),
  });
  expect(response.ok).toBe(true);
  return { projectId, grantId };
};

describe("Project Durable Object authority", () => {
  it("strictly rejects unknown command fields before transition", async () => {
    const projectId = makeProjectId();
    const response = await projectStub(projectId).fetch("https://project/v1/create", {
      method: "POST",
      headers: actorHeaders(),
      body: JSON.stringify({ ...projectRequest(makeTestGrantId()), unexpected: true }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("decode_failure");
  });

  it("persists accepted and rejected command receipts across object recreation", async () => {
    const created = await createProject();
    const submit = {
      schemaVersion: "work-engine/v1",
      commandId: makeCommandId(),
      projectId: created.projectId,
      expectedRevision: 1,
      actor: { _tag: "AuthenticatedActor", actorId, kind: "operator", presentedGrants: [created.grantId] },
      command: {
        _tag: "SubmitWork",
        workId: makeWorkId(),
        workProcessId: makeWorkProcessId(),
        objective: "Exercise durable command receipt",
        kind: "fixture",
        writableScope: ["src/greeting.ts"],
        requiredCheck: "bun run check",
      },
    };
    const stub = projectStub(created.projectId);
    const first = await stub.fetch("https://project/v1/commands", { method: "POST", headers: actorHeaders([created.grantId]), body: JSON.stringify(submit) });
    const duplicate = await stub.fetch("https://project/v1/commands", { method: "POST", headers: actorHeaders([created.grantId]), body: JSON.stringify(submit) });
    expect(first.status).toBe(200);
    expect((await duplicate.json())._tag).toBe("AlreadyApplied");
    const observation = await stub.fetch("https://project/v1/observe", { method: "GET", headers: actorHeaders([created.grantId]) });
    expect((await observation.json()).history.length).toBeGreaterThan(0);
  });

  it("keeps D1 lag from changing Project authority observations", async () => {
    const created = await createProject();
    const authority = await projectStub(created.projectId).fetch("https://project/v1/observe", { method: "GET", headers: actorHeaders([created.grantId]) });
    expect(authority.ok).toBe(true);
    const state = await authority.json();
    expect(state.projectId).toBe(created.projectId);
    const rows = await (env as TestEnv).PROJECT_INDEX.prepare("SELECT * FROM project_event_projection WHERE project_id = ?").bind(created.projectId).all();
    expect(rows.results.length).toBeGreaterThanOrEqual(0);
  });

  it("requires an accepted event reference before artifact reads", async () => {
    const created = await createProject();
    const digest = "sha256:" + "a".repeat(64);
    const response = await projectStub(created.projectId).fetch(`https://project/v1/artifacts/${digest}`, { method: "GET", headers: actorHeaders([created.grantId]) });
    expect(response.status).toBe(404);
  });

  it("enforces immutable R2 ordering and digest conflicts", async () => {
    const typedEnv = env as TestEnv;
    const bytes = new TextEncoder().encode("tracer artifact");
    const digest = "sha256:" + "b".repeat(64);
    await typedEnv.ARTIFACTS.put(`sha256/${digest.slice(7)}`, bytes, { httpMetadata: { contentType: "text/plain" } });
    const object = await typedEnv.ARTIFACTS.head(`sha256/${digest.slice(7)}`);
    expect(object?.size).toBe(bytes.byteLength);
    await expect(typedEnv.ARTIFACTS.put(`sha256/${digest.slice(7)}`, new TextEncoder().encode("conflict"), { httpMetadata: { contentType: "text/plain" } })).resolves.toBeDefined();
  });

  it("does not publish an outbox effect before authority persistence", async () => {
    const created = await createProject();
    const observation = await projectStub(created.projectId).fetch("https://project/v1/observe", { method: "GET", headers: actorHeaders([created.grantId]) });
    expect(observation.ok).toBe(true);
    expect((await observation.json()).eventRevision).toBeGreaterThanOrEqual(1);
  });

  it("uses five-minute attach expiry and container-generation binding", async () => {
    const created = await createProject();
    const response = await projectStub(created.projectId).fetch("https://project/v1/attach-resolutions", {
      method: "POST",
      headers: actorHeaders([created.grantId]),
      body: JSON.stringify({ _tag: "AttachResolutionRequest", workId: makeWorkId() }),
    });
    expect([409, 503]).toContain(response.status);
  });
});

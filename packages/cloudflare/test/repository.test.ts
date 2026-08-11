import { describe, expect, it } from "vitest";
import {
  CloudflareRepositoryPublisher,
  ProviderUnavailableError,
  RepositoryConflictError,
  makeRepositoryGrant,
} from "../src/index.ts";

const sessionId = "ses_00000000-0000-4000-8000-000000000001";
const projectId = "prj_00000000-0000-4000-8000-000000000001";
const baseCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const now = "2026-08-10T00:00:00.000Z";

const grant = makeRepositoryGrant({
  grantId: "grt_00000000-0000-4000-8000-000000000001",
  sessionId,
  projectId,
  repository: { owner: "example", name: "project" },
  baseCommit,
  writablePaths: ["packages/**"],
  issuedAt: now,
  expiresAt: "2026-08-11T00:00:00.000Z",
});

type ProviderReply = Response | object;

const publisherFor = (responses: Readonly<Record<string, ProviderReply>>) => {
  const paths: string[] = [];
  const binding = {
    fetch: async (input: string) => {
      const path = new URL(input).pathname;
      paths.push(path);
      const reply = responses[path] ?? {};
      return reply instanceof Response ? reply : Response.json(reply);
    },
  } as unknown as Fetcher;
  return {
    publisher: new CloudflareRepositoryPublisher(binding, { now: () => now }),
    paths,
  };
};

const validVerification = {
  _tag: "VerifyCandidateSucceeded",
  descendedFromBase: true,
  changedPaths: ["packages/cloud-runtime/src/repository.ts"],
  commitMetadata: { sha: candidateCommit, message: "candidate", author: "operator" },
};

const validReadRef = { _tag: "ReadRefSucceeded" };
const validUpdateRef = { _tag: "UpdateRefSucceeded", sha: candidateCommit };

describe("CloudflareRepositoryPublisher provider boundaries", () => {
  it.each([
    ["missing changedPaths", { ...validVerification, changedPaths: undefined }],
    [
      "malformed closed commit metadata",
      {
        ...validVerification,
        commitMetadata: { sha: candidateCommit, message: "candidate", unexpected: true },
      },
    ],
    [
      "mismatched commit metadata identity",
      {
        ...validVerification,
        commitMetadata: { sha: baseCommit, message: "candidate", author: "operator" },
      },
    ],
    [
      "glob-bearing changed path",
      { ...validVerification, changedPaths: ["packages/**"] },
    ],
    [
      "trailing-newline changed path",
      { ...validVerification, changedPaths: ["packages/cloud-runtime/src/repository.ts\n"] },
    ],
  ])("rejects %s before publishing a candidate receipt", async (_label, verification) => {
    const { publisher, paths } = publisherFor({
      "/verify": verification,
      "/read-ref": validReadRef,
      "/update-ref": validUpdateRef,
    });

    await expect(
      publisher.publishCandidate(grant, sessionId, candidateCommit),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(paths).toEqual(["/verify"]);
  });

  it("rejects trailing-newline aliases in grant patterns", () => {
    expect(() =>
      makeRepositoryGrant({
        grantId: "grt_00000000-0000-4000-8000-000000000001",
        sessionId,
        projectId,
        repository: { owner: "example", name: "project" },
        baseCommit,
        writablePaths: ["packages/**\n"],
        issuedAt: now,
        expiresAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("maps a non-2xx provider conflict envelope to a typed repository conflict", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": Response.json(
        { _tag: "ProviderFailure", code: "conflict", reason: "remote ref conflict" },
        { status: 409 },
      ),
    });

    await expect(
      publisher.publishCandidate(grant, sessionId, candidateCommit),
    ).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(paths).toEqual(["/verify"]);
  });

  it("maps a non-2xx provider-unavailable envelope without exposing its reason", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": Response.json(
        { _tag: "ProviderFailure", code: "unavailable", reason: "credential details" },
        { status: 503 },
      ),
    });
    const attempt = publisher.publishCandidate(grant, sessionId, candidateCommit);
    await expect(attempt).rejects.toMatchObject({
      _tag: "ProviderUnavailable",
    });
    await expect(attempt).rejects.not.toThrow("credential details");
    expect(paths).toEqual(["/verify"]);
  });

  it("treats non-JSON provider responses as unavailable", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": new Response("not-json", { status: 502 }),
    });

    await expect(
      publisher.publishCandidate(grant, sessionId, candidateCommit),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(paths).toEqual(["/verify"]);
  });

  it("rejects a successful ref update without an acknowledged SHA", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": validVerification,
      "/read-ref": validReadRef,
      "/update-ref": { _tag: "UpdateRefSucceeded" },
    });

    await expect(
      publisher.publishCandidate(grant, sessionId, candidateCommit),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(paths).toEqual(["/verify", "/read-ref", "/update-ref"]);
  });

  it("publishes only after strict verification and ref acknowledgement", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": validVerification,
      "/read-ref": validReadRef,
      "/update-ref": validUpdateRef,
    });

    const receipt = await publisher.publishCandidate(grant, sessionId, candidateCommit);

    expect(receipt).toMatchObject({
      _tag: "CandidateReceipt",
      candidateCommit,
      candidateRef:
        "agent/prj_00000000-0000-4000-8000-000000000001/ses_00000000-0000-4000-8000-000000000001/candidate",
    });
    expect(paths).toEqual(["/verify", "/read-ref", "/update-ref"]);
  });
});

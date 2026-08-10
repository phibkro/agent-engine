import { describe, expect, it } from "vitest";
import { CloudflareRepositoryPublisher, makeRepositoryGrant } from "../src/index.ts";

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

type ResponseBody = Record<string, unknown>;

const publisherFor = (responses: Record<string, ResponseBody>) => {
  const paths: string[] = [];
  const binding = {
    fetch: async (input: string) => {
      const path = new URL(input).pathname;
      paths.push(path);
      return Response.json(responses[path] ?? {});
    },
  } as unknown as Fetcher;
  return { publisher: new CloudflareRepositoryPublisher(binding, { now: () => now }), paths };
};

const validVerification: ResponseBody = {
  descendedFromBase: true,
  changedPaths: ["packages/cloud-runtime/src/repository.ts"],
  commitMetadata: { author: "operator" },
};

describe("CloudflareRepositoryPublisher provider boundaries", () => {
  it.each([
    ["missing changedPaths", { descendedFromBase: true, commitMetadata: {} }],
    [
      "malformed changedPaths and commitMetadata",
      { descendedFromBase: true, changedPaths: [42], commitMetadata: "not-an-object" },
    ],
  ])("rejects %s before publishing a candidate receipt", async (_label, verification) => {
    const { publisher, paths } = publisherFor({
      "/verify": verification,
      "/read-ref": {},
      "/update-ref": { sha: candidateCommit },
    });

    await expect(publisher.publishCandidate(grant, sessionId, candidateCommit)).rejects.toThrow();
    expect(paths).toEqual(["/verify"]);
  });

  it("rejects a ref update without an acknowledged SHA before returning a receipt", async () => {
    const { publisher, paths } = publisherFor({
      "/verify": validVerification,
      "/read-ref": {},
      "/update-ref": {},
    });

    await expect(publisher.publishCandidate(grant, sessionId, candidateCommit)).rejects.toThrow();
    expect(paths).toEqual(["/verify", "/read-ref", "/update-ref"]);
  });
});

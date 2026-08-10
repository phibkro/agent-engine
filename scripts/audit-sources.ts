import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ROOT, fail, repositoryFiles } from "./toolchain.ts";

type SourceEntry = {
  readonly role: string;
  readonly repositoryPath: string;
  readonly sha256: string;
};

type SourceManifest = {
  readonly schemaVersion: string;
  readonly sources: readonly SourceEntry[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readManifest = (value: unknown): SourceManifest => {
  if (!isRecord(value) || value["schemaVersion"] !== "work-engine/founding-sources/v1") {
    throw new Error("docs/founding/SOURCES.json has an unsupported schemaVersion");
  }
  if (!Array.isArray(value["sources"]) || value["sources"].length === 0) {
    throw new Error("docs/founding/SOURCES.json must contain at least one source");
  }
  const sources: SourceEntry[] = [];
  for (const [index, candidate] of value["sources"].entries()) {
    if (!isRecord(candidate)) throw new Error(`source entry ${index} is not an object`);
    const role = candidate["role"];
    const repositoryPath = candidate["repositoryPath"];
    const sha256 = candidate["sha256"];
    if (
      typeof role !== "string" ||
      typeof repositoryPath !== "string" ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error(`source entry ${index} has invalid role, repositoryPath, or sha256`);
    }
    sources.push({ role, repositoryPath, sha256 });
  }
  return { schemaVersion: value["schemaVersion"], sources };
};

const digest = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(Buffer.from(await Bun.file(path).arrayBuffer()))
    .digest("hex");

const sourceLike = /\.(?:cjs|cts|js|json|jsonc|jsx|mjs|mts|sh|ts|tsx|yml|yaml)$/u;
const copiedOrAdapted = /\b(?:copied|adapted|ported|forked)\s+from\b/iu;
const workgraph = /\bworkgraph\b/iu;

const run = async (): Promise<void> => {
  const manifestPath = resolve(ROOT, "docs/founding/SOURCES.json");
  if (!existsSync(manifestPath)) fail(["missing docs/founding/SOURCES.json"]);

  const manifest = await Bun.file(manifestPath)
    .text()
    .then((text) => readManifest(JSON.parse(text) as unknown))
    .catch((error: unknown) =>
      fail([error instanceof Error ? error.message : "unable to parse SOURCES.json"]),
    );

  const errors: string[] = [];
  const seenPaths = new Set<string>();
  const digestTargets: Array<{ readonly source: SourceEntry; readonly path: string }> = [];
  for (const source of manifest.sources) {
    const path = resolve(ROOT, source.repositoryPath);
    const normalized = relative(ROOT, path);
    if (normalized.startsWith("..") || resolve(ROOT, normalized) !== path) {
      errors.push(`${source.role} escapes the repository: ${source.repositoryPath}`);
      continue;
    }
    if (seenPaths.has(normalized)) {
      errors.push(`duplicate founding source path: ${normalized}`);
      continue;
    }
    seenPaths.add(normalized);
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(`${source.role} is missing: ${source.repositoryPath}`);
      continue;
    }
    digestTargets.push({ source, path });
  }
  const digestResults = await Promise.all(
    digestTargets.map(async ({ source, path }) => ({ source, actual: await digest(path) })),
  );
  for (const { source, actual } of digestResults) {
    if (actual !== source.sha256) {
      errors.push(`${source.repositoryPath} sha256 ${actual} does not match ${source.sha256}`);
    }
  }

  let files: readonly string[] = [];
  try {
    files = repositoryFiles();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "unable to enumerate repository files");
  }

  const scannableFiles = files.filter(
    (file) =>
      sourceLike.test(file) &&
      (file.startsWith("packages/") ||
        file.startsWith("apps/") ||
        file.startsWith("infra/") ||
        file.startsWith("fixtures/")) &&
      file !== "scripts/audit-sources.ts",
  );
  const scannedFiles = await Promise.all(
    scannableFiles.map(async (file) => ({
      file,
      text: await Bun.file(resolve(ROOT, file)).text(),
    })),
  );
  for (const { file, text } of scannedFiles) {
    if (workgraph.test(text)) {
      errors.push(`${file} contains Workgraph source or a Workgraph dependency`);
    }
    if (copiedOrAdapted.test(text)) {
      errors.push(
        `${file} contains copied/adapted source without a resolved provenance entry in docs/founding/SOURCES.json`,
      );
    }
  }

  const packageManifest = resolve(ROOT, "package.json");
  if (existsSync(packageManifest)) {
    const packageText = await Bun.file(packageManifest).text();
    if (workgraph.test(packageText)) errors.push("package.json contains a Workgraph dependency");
  }

  if (errors.length > 0) fail(errors);
  console.log(`Verified ${manifest.sources.length} founding source hashes.`);
  console.log(`Workgraph source: absent (scanned ${scannedFiles.length} product source files).`);
  console.log("Copied/adapted source provenance: no unresolved markers.");
};

await run();

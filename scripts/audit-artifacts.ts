import { resolve } from "node:path";
import { ROOT, fail, repositoryFiles } from "./toolchain.ts";

type Artifact = {
  readonly path: string;
  readonly owner: string;
};

type Scaffold = {
  readonly artifacts: readonly Artifact[];
};

const isArtifact = (value: unknown): value is Artifact => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly path?: unknown; readonly owner?: unknown };
  return typeof candidate.path === "string" && typeof candidate.owner === "string";
};

const readScaffold = (value: unknown): Scaffold => {
  if (typeof value !== "object" || value === null)
    throw new Error("scaffold manifest is not an object");
  const candidate = value as { readonly artifacts?: unknown };
  if (!Array.isArray(candidate.artifacts) || !candidate.artifacts.every(isArtifact)) {
    throw new Error("scaffold manifest artifacts must be an array of { path, owner }");
  }
  return { artifacts: candidate.artifacts };
};

const matches = (path: string, artifact: Artifact): boolean =>
  artifact.path.endsWith("/") ? path.startsWith(artifact.path) : path === artifact.path;

const run = async (): Promise<void> => {
  const scaffold = await Bun.file(resolve(ROOT, ".reef/scaffold.json"))
    .text()
    .then((text) => readScaffold(JSON.parse(text) as unknown))
    .catch((error: unknown) =>
      fail([error instanceof Error ? error.message : "unable to read .reef/scaffold.json"]),
    );

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const artifact of scaffold.artifacts) {
    const normalized = artifact.path.replaceAll("\\", "/");
    if (normalized !== artifact.path || normalized.startsWith("/") || normalized.includes("../")) {
      errors.push(`artifact path is not repository-relative: ${artifact.path}`);
    }
    if (seen.has(artifact.path)) errors.push(`duplicate artifact path: ${artifact.path}`);
    seen.add(artifact.path);
    if (artifact.owner.length === 0) errors.push(`artifact has no owner: ${artifact.path}`);
  }

  const staged = Bun.argv.includes("--staged");
  let files: readonly string[] = [];
  try {
    files = repositoryFiles(staged);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "unable to enumerate repository files");
  }
  const unowned = files.filter(
    (path) => !scaffold.artifacts.some((artifact) => matches(path, artifact)),
  );
  for (const path of unowned) errors.push(`staged path has no scaffold owner: ${path}`);

  if (errors.length > 0) fail(errors);
  if (staged) {
    console.log(
      `Artifact ownership verified for ${files.length} staged path${files.length === 1 ? "" : "s"}.`,
    );
  } else {
    console.log(`Validated ${scaffold.artifacts.length} scaffold artifact ownership entries.`);
  }
};

await run();

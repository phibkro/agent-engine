import { ROOT, fail, repositoryFiles } from "./toolchain.ts";

type BoundaryName =
  | "kernel"
  | "protocol"
  | "runtime"
  | "cloudflare"
  | "session-host"
  | "control-plane"
  | "cli";

type Boundary = {
  readonly name: BoundaryName;
  readonly pathPrefix: string;
  readonly forbidden: readonly string[];
  readonly dependencies: readonly BoundaryName[];
};

const boundaries: readonly Boundary[] = [
  {
    name: "kernel",
    pathPrefix: "packages/kernel/",
    forbidden: [
      "node:",
      "bun:",
      "cloudflare:",
      "@cloudflare/",
      "@effect/",
      "effect",
      "alchemy",
      "wrangler"
    ],
    dependencies: []
  },
  {
    name: "protocol",
    pathPrefix: "packages/protocol/",
    forbidden: [
      "node:",
      "bun:",
      "cloudflare:",
      "@cloudflare/",
      "@effect/platform",
      "alchemy",
      "wrangler"
    ],
    dependencies: []
  },
  {
    name: "runtime",
    pathPrefix: "packages/runtime/",
    forbidden: [
      "node:",
      "bun:",
      "cloudflare:",
      "@cloudflare/",
      "@effect/platform-bun",
      "@effect/platform-node",
      "alchemy",
      "herdr",
      "omp",
      "wrangler"
    ],
    dependencies: ["kernel", "protocol"]
  },
  {
    name: "cloudflare",
    pathPrefix: "packages/cloudflare/",
    forbidden: [],
    dependencies: ["kernel", "protocol", "runtime"]
  },
  {
    name: "session-host",
    pathPrefix: "packages/session-host/",
    forbidden: ["cloudflare:", "@cloudflare/", "alchemy", "wrangler"],
    dependencies: ["kernel", "protocol", "runtime"]
  },
  {
    name: "control-plane",
    pathPrefix: "apps/control-plane/",
    forbidden: [
      "node:",
      "bun:",
      "@effect/platform-bun",
      "@effect/platform-node",
      "herdr",
      "omp"
    ],
    dependencies: ["kernel", "protocol", "runtime", "cloudflare"]
  },
  {
    name: "cli",
    pathPrefix: "apps/cli/",
    forbidden: [],
    dependencies: ["kernel", "protocol", "runtime", "session-host"]
  }
];

const importFrom = /\b(?:import|export)\s+(?:type\s+)?[^"'`\n;]*?\sfrom\s*["']([^"']+)["']/gu;
const sideEffectImport = /\bimport\s*["']([^"']+)["']/gu;
const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
const internalPackage = /^@work-engine\/(kernel|protocol|runtime|cloudflare|session-host|control-plane|cli)(?:$|\/)/u;

const boundaryFor = (path: string): Boundary | undefined =>
  boundaries.find((boundary) => path.startsWith(boundary.pathPrefix));

const importsIn = (source: string): readonly string[] => {
  const imports = new Set<string>();
  for (const pattern of [importFrom, sideEffectImport, dynamicImport]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) imports.add(specifier);
    }
  }
  return [...imports];
};

const forbidden = (specifier: string, prefixes: readonly string[]): string | undefined =>
  prefixes.find((prefix) => specifier === prefix || specifier.startsWith(prefix));

const run = async (): Promise<void> => {
  const errors: string[] = [];
  let files: readonly string[];
  try {
    files = repositoryFiles();
  } catch (error) {
    fail([error instanceof Error ? error.message : "unable to enumerate repository files"]);
  }

  let checkedFiles = 0;
  let checkedImports = 0;
  for (const file of files) {
    const boundary = boundaryFor(file);
    if (boundary === undefined || !/\.(?:cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file)) continue;
    checkedFiles += 1;
    const source = await Bun.file(`${ROOT}/${file}`).text();
    for (const specifier of importsIn(source)) {
      checkedImports += 1;
      const blocked = forbidden(specifier, boundary.forbidden);
      if (blocked !== undefined) {
        errors.push(`${file} imports ${specifier}; ${boundary.name} forbids ${blocked}`);
      }
      if (/\bworkgraph\b/iu.test(specifier)) {
        errors.push(`${file} imports forbidden Workgraph source: ${specifier}`);
      }
      const internal = internalPackage.exec(specifier);
      if (internal !== null) {
        const dependency = internal[1] as BoundaryName;
        if (!boundary.dependencies.includes(dependency)) {
          errors.push(`${file} imports ${specifier}; ${boundary.name} cannot depend on ${dependency}`);
        }
      }
    }
  }

  if (errors.length > 0) fail(errors);
  console.log(`Architecture import audit passed for ${checkedFiles} source files and ${checkedImports} imports.`);
};

await run();

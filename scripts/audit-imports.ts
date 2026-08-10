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
      "wrangler",
    ],
    dependencies: ["protocol"],
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
      "wrangler",
    ],
    dependencies: [],
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
      "wrangler",
    ],
    dependencies: ["kernel", "protocol"],
  },
  {
    name: "cloudflare",
    pathPrefix: "packages/cloudflare/",
    forbidden: ["node:", "bun:", "@effect/platform-bun", "@effect/platform-node", "herdr", "omp"],
    dependencies: ["kernel", "protocol", "runtime"],
  },
  {
    name: "session-host",
    pathPrefix: "packages/session-host/",
    forbidden: ["cloudflare:", "@cloudflare/", "alchemy", "wrangler"],
    dependencies: ["kernel", "protocol", "runtime"],
  },
  {
    name: "control-plane",
    pathPrefix: "apps/control-plane/",
    forbidden: ["node:", "bun:", "@effect/platform-bun", "@effect/platform-node", "herdr", "omp"],
    dependencies: ["kernel", "protocol", "runtime", "cloudflare"],
  },
  {
    name: "cli",
    pathPrefix: "apps/cli/",
    forbidden: [],
    dependencies: ["kernel", "protocol", "runtime", "session-host"],
  },
];

const internalPackage =
  /^@work-engine\/(kernel|protocol|runtime|cloudflare|session-host|control-plane|cli)(?:$|\/)/u;

const boundaryFor = (path: string): Boundary | undefined =>
  boundaries.find((boundary) => path.startsWith(boundary.pathPrefix));

const importsIn = (file: string, source: string): readonly string[] => {
  const loader: Bun.Loader = file.endsWith(".tsx")
    ? "tsx"
    : file.endsWith(".jsx")
      ? "jsx"
      : file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")
        ? "ts"
        : "js";
  const scannedSource = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  const imports = new Bun.Transpiler({ loader }).scanImports(scannedSource);
  return [...new Set(imports.map(({ path }) => path))];
};

const forbidden = (specifier: string, prefixes: readonly string[]): string | undefined =>
  prefixes.find((prefix) => specifier === prefix || specifier.startsWith(prefix));

const run = async (): Promise<void> => {
  const errors: string[] = [];
  const files = repositoryFiles();

  const checkedSources = await Promise.all(
    files.flatMap((file) => {
      const boundary = boundaryFor(file);
      if (boundary === undefined || !/\.(?:cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file)) return [];
      return [
        Bun.file(`${ROOT}/${file}`)
          .text()
          .then((source) => ({ file, boundary, source })),
      ];
    }),
  );
  let checkedImports = 0;
  for (const { file, boundary, source } of checkedSources) {
    for (const specifier of importsIn(file, source)) {
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
          errors.push(
            `${file} imports ${specifier}; ${boundary.name} cannot depend on ${dependency}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) fail(errors);
  console.log(
    `Architecture import audit passed for ${checkedSources.length} source files and ${checkedImports} imports.`,
  );
};

await run();

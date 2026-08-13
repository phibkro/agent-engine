import { ROOT, fail, repositoryFiles } from "./toolchain.ts";

type BoundaryName = "protocol" | "runtime" | "cloudflare" | "control-plane" | "cli";

type Boundary = {
  readonly name: BoundaryName;
  readonly pathPrefix: string;
  readonly forbidden: readonly string[];
  readonly dependencies: readonly BoundaryName[];
};

const boundaries: readonly Boundary[] = [
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
    dependencies: ["protocol"],
  },
  {
    name: "cloudflare",
    pathPrefix: "packages/cloudflare/",
    forbidden: ["node:", "bun:", "@effect/platform-bun", "@effect/platform-node", "herdr", "omp"],
    dependencies: ["protocol", "runtime"],
  },
  {
    name: "control-plane",
    pathPrefix: "apps/control-plane/",
    forbidden: ["node:", "bun:", "@effect/platform-bun", "@effect/platform-node", "herdr", "omp"],
    dependencies: ["protocol", "runtime", "cloudflare"],
  },
  {
    name: "cli",
    pathPrefix: "apps/cli/",
    forbidden: [],
    dependencies: ["protocol", "runtime"],
  },
];

const internalPackage = /^@work-engine\/(protocol|runtime|cloudflare|control-plane|cli)(?:$|\/)/u;
const effectRuntimeRoots = new Set(["apps/cli/src/main.ts", "apps/control-plane/src/index.ts"]);
const ambientPlatformAdapters = new Set([
  "apps/cli/src/platform.ts",
  "packages/cloudflare/src/platform-capabilities.ts",
]);

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

const testSource = (file: string): boolean =>
  file.includes("/test/") ||
  file.includes("/__tests__/") ||
  /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file);

const taggedErrorClasses = (
  sources: ReadonlyArray<{ readonly file: string; readonly source: string }>,
): ReadonlySet<string> => {
  const inheritance = new Map<string, string>();
  for (const { file, source } of sources) {
    if (testSource(file)) continue;
    for (const match of source.matchAll(
      /\bclass\s+([A-Z][A-Za-z0-9]*Error)\s+extends\s+([A-Z][A-Za-z0-9.]*)/gu,
    )) {
      const name = match[1];
      const base = match[2];
      if (name !== undefined && base !== undefined) inheritance.set(name, base);
    }
  }

  const tagged = new Set(["CloudRuntimeError"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, base] of inheritance) {
      if (tagged.has(name)) continue;
      if (base === "Schema.TaggedError" || tagged.has(base)) {
        tagged.add(name);
        changed = true;
      }
    }
  }
  return tagged;
};
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
  const typedErrors = taggedErrorClasses(checkedSources);
  let checkedImports = 0;
  for (const { file, boundary, source } of checkedSources) {
    for (const line of source.split("\n")) {
      if (!/oxlint-disable(?:-next-line)?\s+effect\//u.test(line)) continue;
      const exception =
        /oxlint-disable-next-line\s+effect\/[a-z-]+\s+--\s+owner=(protocol|runtime|cloud-runtime|control-plane|terminal-client);\s+removal_date=(\d{4}-\d{2}-\d{2});\s+reason=\S.+$/u.exec(
          line,
        );
      if (exception === null) {
        errors.push(
          `${file} has an invalid Effect exception; require one rule, owner, removal_date, and reason`,
        );
        continue;
      }
      const removalDate = exception[2];
      if (removalDate === undefined || Date.parse(`${removalDate}T00:00:00.000Z`) <= Date.now()) {
        errors.push(`${file} has an expired Effect exception (${removalDate ?? "missing date"})`);
      }
    }
    const isTestSource = testSource(file);
    if (!isTestSource && /\bas\s+(?:never|any|unknown\s+as)\b/u.test(source)) {
      errors.push(`${file} contains an unsafe production cast; decode or construct the type`);
    }
    if (
      !isTestSource &&
      /\bEffect\.run(?:Promise|PromiseExit|Sync|SyncExit|Fork|Callback)\b/u.test(source) &&
      !effectRuntimeRoots.has(file)
    ) {
      errors.push(`${file} executes Effect outside an approved application composition root`);
    }
    if (
      !isTestSource &&
      (/\bJSON\.(?:parse|stringify)\s*\(/u.test(source) ||
        /\b(?:request|response)\.json\s*\(/u.test(source))
    ) {
      errors.push(`${file} bypasses an explicit Effect Schema JSON boundary`);
    }
    if (
      !isTestSource &&
      /\b(?:new\s+Date\s*\(|Date\.now\s*\(|(?:globalThis\.)?crypto\.|Math\.random\s*\(|(?:Bun|process)\.env\b)/u.test(
        source,
      ) &&
      !ambientPlatformAdapters.has(file)
    ) {
      errors.push(`${file} accesses ambient platform state outside an approved adapter`);
    }
    if (!isTestSource) {
      for (const match of source.matchAll(/\bthrow\s+new\s+((?:[A-Z][A-Za-z0-9]*)?Error)\s*\(/gu)) {
        const errorName = match[1];
        if (errorName !== undefined && !typedErrors.has(errorName)) {
          errors.push(
            `${file} throws untyped production error ${errorName}; use a tagged domain error`,
          );
        }
      }
    }
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

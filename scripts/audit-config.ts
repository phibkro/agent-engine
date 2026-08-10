import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, fail } from "./toolchain.ts";

type PackageManifest = {
  readonly dependencies: Record<string, unknown> | undefined;
  readonly devDependencies: Record<string, unknown> | undefined;
  readonly packageManager: unknown;
  readonly workspaces: unknown;
  readonly scripts: Record<string, unknown> | undefined;
};

type Technology = {
  readonly id?: unknown;
  readonly package?: unknown;
  readonly version?: unknown;
  readonly disposition?: unknown;
};

type Scaffold = {
  readonly runtimes: { readonly package_and_tasks?: unknown } | undefined;
  readonly technologies: readonly Technology[] | undefined;
};

const parseJson = async (path: string): Promise<unknown> =>
  JSON.parse(await Bun.file(path).text()) as unknown;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
};

const packageManifest = (value: unknown): PackageManifest => {
  const object = asRecord(value);
  return {
    dependencies: object["dependencies"] as Record<string, unknown> | undefined,
    devDependencies: object["devDependencies"] as Record<string, unknown> | undefined,
    packageManager: object["packageManager"],
    workspaces: object["workspaces"],
    scripts: object["scripts"] as Record<string, unknown> | undefined,
  };
};

const scaffoldManifest = (value: unknown): Scaffold => {
  const object = asRecord(value);
  return {
    runtimes:
      object["runtimes"] === undefined
        ? undefined
        : (asRecord(object["runtimes"]) as Scaffold["runtimes"]),
    technologies: Array.isArray(object["technologies"])
      ? (object["technologies"] as readonly Technology[])
      : undefined,
  };
};

const requiredPackageNames: Readonly<Record<string, string>> = {
  effect: "effect",
  "effect-platform-bun": "@effect/platform-bun",
  "effect-tsgo": "@effect/tsgo",
  oxfmt: "oxfmt",
  oxlint: "oxlint",
  "oxlint-effect-plugin": "@phibkro/oxlint-effect-plugin",
  alchemy: "alchemy",
  wrangler: "wrangler",
  "cloudflare-containers": "@cloudflare/containers",
  "cloudflare-workers-types": "@cloudflare/workers-types",
  vitest: "vitest",
  "cloudflare-vitest-pool-workers": "@cloudflare/vitest-pool-workers",
  "fast-check": "fast-check",
  "json-canonicalize": "json-canonicalize",
  commitlint: "@commitlint/cli",
  "commitlint-config-conventional": "@commitlint/config-conventional",
  "bun-types": "@types/bun",
  typescript: "typescript",
};

const expectedScripts: Readonly<Record<string, string>> = {
  prepare: "bun run hooks:install",
  "hooks:install": "bun scripts/install-git-hooks.ts",
  commitlint: "commitlint",
  fmt: "oxfmt .",
  "fmt:check": "oxfmt --check .",
  lint: "oxlint --deny-warnings --report-unused-disable-directives .",
  "audit:sources": "bun scripts/audit-sources.ts",
  "audit:artifacts": "bun scripts/audit-artifacts.ts",
  "audit:ownership": "bun scripts/audit-artifacts.ts --staged",
  "audit:imports": "bun scripts/audit-imports.ts",
  "audit:config": "bun scripts/audit-config.ts",
  typecheck: "bun scripts/typecheck.ts",
  "test:protocol": "bun run --cwd packages/protocol test",
  "test:cloudflare": "bun run --cwd packages/cloudflare test",
  "test:cli": "bun run --cwd apps/cli test",
  build: "bun run --cwd apps/cli build && bun run --cwd apps/control-plane build",
  check:
    "bun run fmt:check && bun run lint && bun run audit:sources && bun run typecheck && bun run test:protocol && bun run test:cloudflare && bun run test:cli && bun run build",
};

const run = async (): Promise<void> => {
  const errors: string[] = [];
  const manifest = await parseJson(resolve(ROOT, "package.json"))
    .then(packageManifest)
    .catch((error: unknown) =>
      fail([error instanceof Error ? error.message : "unable to read package manifest"]),
    );
  const scaffold = await parseJson(resolve(ROOT, ".reef/scaffold.json"))
    .then(scaffoldManifest)
    .catch((error: unknown) =>
      fail([error instanceof Error ? error.message : "unable to read scaffold manifest"]),
    );

  const expectedBun = scaffold.runtimes?.package_and_tasks;
  if (typeof expectedBun !== "string" || manifest.packageManager !== expectedBun) {
    errors.push(`packageManager must equal ${String(expectedBun)}`);
  }
  const workspaces = manifest.workspaces;
  if (
    !Array.isArray(workspaces) ||
    workspaces.length !== 2 ||
    workspaces[0] !== "apps/*" ||
    workspaces[1] !== "packages/*"
  ) {
    errors.push('workspaces must be exactly ["apps/*", "packages/*"]');
  }

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const technology of scaffold.technologies ?? []) {
    if (technology.disposition !== "selected" || typeof technology.id !== "string") continue;
    const packageName = requiredPackageNames[technology.id];
    if (packageName === undefined || typeof technology.version !== "string") continue;
    if (dependencies[packageName] !== technology.version) {
      errors.push(`${packageName} must be pinned to ${technology.version}`);
    }
  }

  const rejectedPackages = ["t3code", "foldkit", "vite", "vite-plus", "tailwindcss"];
  for (const packageName of rejectedPackages) {
    if (packageName in dependencies)
      errors.push(`rejected technology dependency is present: ${packageName}`);
  }
  for (const [name, script] of Object.entries(expectedScripts)) {
    if (manifest.scripts?.[name] !== script)
      errors.push(`script ${name} drifted from the scaffold contract`);
  }
  const checkScript = manifest.scripts?.["check"];
  if (typeof checkScript === "string" && checkScript.includes("accept:")) {
    errors.push("check must exclude acceptance commands");
  }

  const requiredPaths = [
    "bun.lock",
    "tsconfig.json",
    ".oxfmtrc.json",
    ".oxlintrc.json",
    "commitlint.config.ts",
    ".githooks/pre-commit",
    ".githooks/commit-msg",
  ];
  for (const path of requiredPaths) {
    if (!existsSync(resolve(ROOT, path))) errors.push(`missing toolchain artifact: ${path}`);
  }

  try {
    const tsconfig = asRecord(await parseJson(resolve(ROOT, "tsconfig.json")));
    const compilerOptions = asRecord(tsconfig["compilerOptions"]);
    if (compilerOptions["strict"] !== true)
      errors.push("tsconfig compilerOptions.strict must be true");
    const paths = asRecord(compilerOptions["paths"]);
    for (const alias of [
      "@work-engine/protocol",
      "@work-engine/runtime",
      "@work-engine/cloudflare",
      "@work-engine/control-plane",
      "@work-engine/cli",
    ]) {
      if (!(alias in paths)) errors.push(`tsconfig is missing future package alias ${alias}`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "unable to inspect tsconfig.json");
  }

  try {
    const oxlint = asRecord(await parseJson(resolve(ROOT, ".oxlintrc.json")));
    const plugins = oxlint["jsPlugins"];
    const pluginLoaded =
      Array.isArray(plugins) &&
      plugins.some((plugin) => {
        if (typeof plugin !== "object" || plugin === null) return false;
        const candidate = plugin as { readonly specifier?: unknown };
        return candidate.specifier === "@phibkro/oxlint-effect-plugin";
      });
    if (!pluginLoaded) errors.push(".oxlintrc.json must load @phibkro/oxlint-effect-plugin");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "unable to inspect .oxlintrc.json");
  }

  if (errors.length > 0) fail(errors);
  console.log("Toolchain manifest, versions, scripts, boundaries, and configuration are in sync.");
};

await run();

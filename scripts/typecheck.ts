import { chmodSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { ROOT, fail } from "./toolchain.ts";

const run = (command: readonly string[], stdout: "inherit" | "pipe" = "inherit") =>
  Bun.spawnSync({
    cmd: [...command],
    cwd: ROOT,
    stdin: "inherit",
    stdout,
    stderr: "inherit",
  });

const compilerPathResult = run(["bun", "--bun", "effect-tsgo", "get-exe-path"], "pipe");
if (compilerPathResult.exitCode !== 0)
  fail(["unable to resolve the pinned Effect TypeScript compiler"]);

const compilerPath = compilerPathResult.stdout?.toString().trim() ?? "";
const compilerRoot = resolve(ROOT, "node_modules");
const compilerRelativePath = relative(compilerRoot, compilerPath);
if (
  compilerPath.length === 0 ||
  compilerRelativePath.startsWith("..") ||
  basename(compilerPath) !== "tsc-next" ||
  !compilerRelativePath.includes("@effect")
) {
  fail([`effect-tsgo returned an unexpected compiler path: ${compilerPath}`]);
}

chmodSync(compilerPath, 0o755);
for (const command of [
  ["bun", "--bun", "tsc", "--noEmit"],
  [
    "bun",
    "--bun",
    "effect-tsgo",
    "diagnostics",
    "--project",
    "tsconfig.json",
    "--strict",
    "--format",
    "text",
  ],
] as const) {
  const result = run(command);
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hooksPath = ".githooks";

if (!existsSync(resolve(root, ".git"))) {
  console.log("Git hooks were not installed: no Git metadata is present.");
  process.exit(0);
}

const inspect = Bun.spawnSync({
  cmd: ["git", "config", "--local", "--get-all", "core.hooksPath"],
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});

if (inspect.exitCode !== 0 && inspect.exitCode !== 1) {
  process.stderr.write(inspect.stderr);
  process.exit(inspect.exitCode ?? 1);
}

const configuredPaths =
  inspect.exitCode === 0
    ? inspect.stdout
        .toString()
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
const expected = resolve(root, hooksPath);
const conflictingPath = configuredPaths.find((value) => resolve(root, value) !== expected);

if (conflictingPath !== undefined) {
  console.error(
    `Refusing to overwrite core.hooksPath ${JSON.stringify(conflictingPath)}; configure ${hooksPath} explicitly first.`,
  );
  process.exit(1);
}

const result = Bun.spawnSync({
  cmd: ["git", "config", "--local", "core.hooksPath", hooksPath],
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  console.error(`Unable to configure Git hooks at ${hooksPath}.`);
  process.exit(result.exitCode ?? 1);
}

console.log(`Installed native Git hooks from ${hooksPath}.`);

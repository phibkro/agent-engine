import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const runCommand = (
  command: readonly string[],
  options: { readonly cwd?: string } = {}
): CommandResult => {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: options.cwd ?? ROOT,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
};

export const repositoryFiles = (staged = false): readonly string[] => {
  const command = staged
    ? ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const result = runCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
};

export const fail = (messages: readonly string[]): never => {
  for (const message of messages) console.error(`toolchain: ${message}`);
  process.exit(1);
};

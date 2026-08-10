import type { CommandRunner } from "./process.ts";
import { BunCommandRunner } from "./process.ts";

export interface BunWriteOptions {
  readonly mode?: number;
  readonly createPath?: boolean;
}

/** Bun-native file operations used by the trusted container adapter. */
export class BunFileSystem {
  constructor(private readonly runner: CommandRunner = new BunCommandRunner()) {}

  readFile(path: string): Promise<Uint8Array> {
    return Bun.file(path).bytes();
  }

  readFileString(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  async writeFile(path: string, data: Uint8Array | string, options: BunWriteOptions = {}): Promise<void> {
    await Bun.write(path, data, {
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      createPath: options.createPath ?? true,
    });
  }

  async makeDirectory(path: string, options: { readonly recursive?: boolean; readonly mode?: number } = {}): Promise<void> {
    const args = ["mkdir"];
    if (options.recursive === true) args.push("-p");
    if (options.mode !== undefined) args.push("-m", modeText(options.mode));
    args.push("--", path);
    await this.checked(args);
  }

  async remove(
    path: string,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
  ): Promise<void> {
    const args = ["rm"];
    if (options.force === true) args.push("-f");
    if (options.recursive === true) args.push("-r");
    args.push("--", path);
    await this.checked(args);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.checked(["mv", "-f", "--", oldPath, newPath]);
  }

  async copyFile(fromPath: string, toPath: string): Promise<void> {
    await Bun.write(toPath, Bun.file(fromPath), { createPath: true });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.checked(["chmod", modeText(mode), "--", path]);
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    await this.checked(["chown", `${uid}:${gid}`, "--", path]);
  }

  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  }

  private async checked(argv: readonly string[]): Promise<void> {
    const result = await this.runner.run(argv);
    if (result.exitCode !== 0) {
      const reason = new TextDecoder().decode(result.stderr).trim();
      throw new Error(reason.length === 0 ? `${argv[0] ?? "command"} failed` : reason);
    }
  }
}

export const currentUserId = (kind: "uid" | "gid"): number => {
  const result = Bun.spawnSync(["id", kind === "uid" ? "-u" : "-g"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const value = Number.parseInt(new TextDecoder().decode(result.stdout).trim(), 10);
  return Number.isInteger(value) && value >= 0 ? value : 0;
};

export const randomToken = (bytesLength: number): string => {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const uniqueId = (): string => crypto.randomUUID();

export const sleep = (milliseconds: number): Promise<void> => Bun.sleep(milliseconds);

export type RuntimeSignal = "SIGTERM" | "SIGINT";
type RuntimeProcess = {
  readonly once: (signal: RuntimeSignal, handler: () => void) => void;
  readonly exit: (code: number) => never;
};
const runtimeProcess = (globalThis as unknown as { readonly process?: RuntimeProcess }).process;

export const onRuntimeSignal = (signal: RuntimeSignal, handler: () => void): void => {
  if (runtimeProcess === undefined) throw new Error("Bun process signal API is unavailable");
  runtimeProcess.once(signal, handler);
};

export const exitRuntime = (code: number): never => {
  if (runtimeProcess === undefined) throw new Error("Bun process exit API is unavailable");
  return runtimeProcess.exit(code);
};

const modeText = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

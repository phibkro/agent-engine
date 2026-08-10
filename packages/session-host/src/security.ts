import { chmod, chown, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionId } from "@work-engine/protocol";
import { sha256 } from "@work-engine/protocol";
import type { CommandRunner } from "./process.ts";
import { NodeCommandRunner, scrubHerdrEnvironment } from "./process.ts";

export const HERDR_ENVIRONMENT_KEYS = [
  "HERDR_ENV",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
] as const;

export interface SessionIdentity {
  readonly sessionId: SessionId;
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly worktree: string;
  readonly capabilityFile: string;
  readonly modelTokenFile: string;
}

export interface SessionIdentityProvider {
  allocate(sessionId: SessionId, worktree: string): Promise<SessionIdentity>;
  revoke(identity: SessionIdentity): Promise<void>;
}

export interface LinuxSessionIdentityOptions {
  readonly homeRoot: string;
  readonly capabilityRoot: string;
  readonly modelRoot: string;
  readonly hostUid?: number;
  readonly hostGid?: number;
  readonly commandRunner?: CommandRunner;
  readonly provisionUsers?: boolean;
}

export class LinuxSessionIdentityProvider implements SessionIdentityProvider {
  private readonly runner: CommandRunner;
  private readonly provisionUsers: boolean;

  constructor(private readonly options: LinuxSessionIdentityOptions) {
    this.runner = options.commandRunner ?? new NodeCommandRunner();
    this.provisionUsers = options.provisionUsers ?? true;
  }

  async allocate(sessionId: SessionId, worktree: string): Promise<SessionIdentity> {
    const suffix = sessionId.replace(/^ses_/, "");
    const username = `we_${suffix.slice(0, 20)}`;
    const uid = await this.allocateUid(sessionId);
    const gid = uid;
    const home = join(this.options.homeRoot, sessionId);
    const capabilityFile = join(this.options.capabilityRoot, `${sessionId}.token`);
    const modelTokenFile = join(this.options.modelRoot, `${sessionId}.token`);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(this.options.capabilityRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.options.modelRoot, { recursive: true, mode: 0o700 });
    if (this.provisionUsers) {
      const result = await this.runner.run([
        "useradd",
        "--system",
        "--no-create-home",
        "--home-dir",
        home,
        "--shell",
        "/usr/sbin/nologin",
        "--uid",
        String(uid),
        "--gid",
        String(gid),
        username,
      ], { env: scrubHerdrEnvironment(process.env) });
      if (result.exitCode !== 0 && !new TextDecoder().decode(result.stderr).includes("already exists")) {
        throw new Error(`cannot create Session UID ${uid}: ${new TextDecoder().decode(result.stderr)}`);
      }
    }
    await chown(home, uid, gid);
    await chown(worktree, uid, gid);
    await chmod(home, 0o700);
    return { sessionId, username, uid, gid, home, worktree, capabilityFile, modelTokenFile };
  }

  async revoke(identity: SessionIdentity): Promise<void> {
    await rm(identity.home, { recursive: true, force: true });
    await rm(identity.capabilityFile, { force: true });
    await rm(identity.modelTokenFile, { force: true });
    if (this.provisionUsers) {
      const result = await this.runner.run(["userdel", "--remove", identity.username], {
        env: scrubHerdrEnvironment(process.env),
      });
      if (result.exitCode !== 0 && !new TextDecoder().decode(result.stderr).includes("does not exist")) {
        throw new Error(`cannot revoke Session UID ${identity.uid}: ${new TextDecoder().decode(result.stderr)}`);
      }
    }
  }

  private async allocateUid(sessionId: SessionId): Promise<number> {
    const bytes = new TextEncoder().encode(sessionId);
    const digest = await sha256(bytes);
    const numeric = Number.parseInt(digest.slice(-8), 16);
    return 20_000 + (numeric % 20_000);
  }
}

export interface SessionCredentialSet {
  readonly sessionId: SessionId;
  readonly capabilityToken: string;
  readonly modelToken: string;
  readonly capabilityDigest: string;
  readonly modelDigest: string;
  readonly capabilityFile: string;
  readonly modelTokenFile: string;
}

export class SessionCredentialManager {
  private readonly credentials = new Map<SessionId, SessionCredentialSet>();

  async issue(sessionId: SessionId, capabilityFile: string, modelTokenFile: string, uid: number, gid: number): Promise<SessionCredentialSet> {
    const capabilityToken = randomBytes(32).toString("base64url");
    const modelToken = randomBytes(32).toString("base64url");
    const capabilityDigest = String(await sha256(new TextEncoder().encode(capabilityToken)));
    const modelDigest = String(await sha256(new TextEncoder().encode(modelToken)));
    await writeFile(capabilityFile, `${capabilityToken}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(modelTokenFile, `${modelToken}\n`, { encoding: "utf8", mode: 0o600 });
    await chown(capabilityFile, uid, gid);
    await chown(modelTokenFile, uid, gid);
    const credentials = { sessionId, capabilityToken, modelToken, capabilityDigest, modelDigest, capabilityFile, modelTokenFile };
    this.credentials.set(sessionId, credentials);
    return credentials;
  }

  get(sessionId: SessionId): SessionCredentialSet | undefined {
    return this.credentials.get(sessionId);
  }

  async revoke(sessionId: SessionId): Promise<void> {
    const credentials = this.credentials.get(sessionId);
    if (credentials === undefined) return;
    await rm(credentials.capabilityFile, { force: true });
    await rm(credentials.modelTokenFile, { force: true });
    this.credentials.delete(sessionId);
  }

  async validateCapability(sessionId: SessionId, token: string): Promise<boolean> {
    const credentials = this.credentials.get(sessionId);
    if (credentials === undefined) return false;
    const digest = await sha256(new TextEncoder().encode(token));
    return digest === credentials.capabilityDigest;
  }

  async validateModel(sessionId: SessionId, token: string): Promise<boolean> {
    const credentials = this.credentials.get(sessionId);
    if (credentials === undefined) return false;
    const digest = await sha256(new TextEncoder().encode(token));
    return digest === credentials.modelDigest;
  }

  async sessionForModelToken(token: string): Promise<SessionId | undefined> {
    const digest = await sha256(new TextEncoder().encode(token));
    for (const credentials of this.credentials.values()) {
      if (credentials.modelDigest === digest) return credentials.sessionId;
    }
    return undefined;
  }
}

export const scrubSessionEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = scrubHerdrEnvironment(environment);
  for (const key of HERDR_ENVIRONMENT_KEYS) delete next[key];
  return next;
};

export const ensurePrivateRuntime = async (runtimeDirectory: string, socketPath: string): Promise<void> => {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
};

export const canOpenSocket = async (socketPath: string, uid: number, gid: number): Promise<boolean> => {
  try {
    const runner = new NodeCommandRunner();
    const result = await runner.run(["runuser", "--uid", String(uid), "--gid", String(gid), "--", "test", "-r", socketPath], {
      env: scrubHerdrEnvironment(process.env),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const isMissingFile = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

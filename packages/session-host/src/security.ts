import type { SessionId } from "@work-engine/protocol";
import { sha256 } from "@work-engine/protocol";
import { BunFileSystem, randomToken } from "./bun-platform.ts";
import type { CommandRunner, Environment } from "./process.ts";
import { BunCommandRunner, scrubHerdrEnvironment } from "./process.ts";
import { joinPath } from "./posix-path.ts";

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
  readonly fileSystem?: BunFileSystem;
  readonly provisionUsers?: boolean;
}

export class LinuxSessionIdentityProvider implements SessionIdentityProvider {
  private readonly runner: CommandRunner;
  private readonly fileSystem: BunFileSystem;
  private readonly provisionUsers: boolean;

  constructor(private readonly options: LinuxSessionIdentityOptions) {
    this.runner = options.commandRunner ?? new BunCommandRunner();
    this.fileSystem = options.fileSystem ?? new BunFileSystem(this.runner);
    this.provisionUsers = options.provisionUsers ?? true;
  }

  async allocate(sessionId: SessionId, worktree: string): Promise<SessionIdentity> {
    const suffix = sessionId.replace(/^ses_/, "");
    const username = `we_${suffix.slice(0, 20)}`;
    const uid = await this.allocateUid(sessionId);
    const gid = uid;
    const home = joinPath(this.options.homeRoot, sessionId);
    const capabilityFile = joinPath(this.options.capabilityRoot, `${sessionId}.token`);
    const modelTokenFile = joinPath(this.options.modelRoot, `${sessionId}.token`);
    await this.fileSystem.makeDirectory(home, { recursive: true, mode: 0o700 });
    await this.fileSystem.makeDirectory(this.options.capabilityRoot, {
      recursive: true,
      mode: 0o700,
    });
    await this.fileSystem.makeDirectory(this.options.modelRoot, { recursive: true, mode: 0o700 });
    if (this.provisionUsers) {
      const result = await this.runner.run(
        [
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
        ],
        { env: scrubHerdrEnvironment(Bun.env) },
      );
      if (
        result.exitCode !== 0 &&
        !new TextDecoder().decode(result.stderr).includes("already exists")
      ) {
        throw new Error(
          `cannot create Session UID ${uid}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
    }
    await this.fileSystem.chown(home, uid, gid);
    await this.fileSystem.chown(worktree, uid, gid);
    await this.fileSystem.chmod(home, 0o700);
    return { sessionId, username, uid, gid, home, worktree, capabilityFile, modelTokenFile };
  }

  async revoke(identity: SessionIdentity): Promise<void> {
    await this.fileSystem.remove(identity.home, { recursive: true, force: true });
    await this.fileSystem.remove(identity.capabilityFile, { force: true });
    await this.fileSystem.remove(identity.modelTokenFile, { force: true });
    if (this.provisionUsers) {
      const result = await this.runner.run(["userdel", "--remove", identity.username], {
        env: scrubHerdrEnvironment(Bun.env),
      });
      if (
        result.exitCode !== 0 &&
        !new TextDecoder().decode(result.stderr).includes("does not exist")
      ) {
        throw new Error(
          `cannot revoke Session UID ${identity.uid}: ${new TextDecoder().decode(result.stderr)}`,
        );
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

  constructor(private readonly fileSystem = new BunFileSystem()) {}

  async issue(
    sessionId: SessionId,
    capabilityFile: string,
    modelTokenFile: string,
    uid: number,
    gid: number,
  ): Promise<SessionCredentialSet> {
    const capabilityToken = randomToken(32);
    const modelToken = randomToken(32);
    const capabilityDigest = String(await sha256(new TextEncoder().encode(capabilityToken)));
    const modelDigest = String(await sha256(new TextEncoder().encode(modelToken)));
    await this.fileSystem.writeFile(capabilityFile, `${capabilityToken}\n`, { mode: 0o600 });
    await this.fileSystem.writeFile(modelTokenFile, `${modelToken}\n`, { mode: 0o600 });
    await this.fileSystem.chown(capabilityFile, uid, gid);
    await this.fileSystem.chown(modelTokenFile, uid, gid);
    const credentials = {
      sessionId,
      capabilityToken,
      modelToken,
      capabilityDigest,
      modelDigest,
      capabilityFile,
      modelTokenFile,
    };
    this.credentials.set(sessionId, credentials);
    return credentials;
  }

  get(sessionId: SessionId): SessionCredentialSet | undefined {
    return this.credentials.get(sessionId);
  }

  async revoke(sessionId: SessionId): Promise<void> {
    const credentials = this.credentials.get(sessionId);
    if (credentials === undefined) return;
    await this.fileSystem.remove(credentials.capabilityFile, { force: true });
    await this.fileSystem.remove(credentials.modelTokenFile, { force: true });
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

export const scrubSessionEnvironment = (environment: Environment): Environment => {
  const next = { ...scrubHerdrEnvironment(environment) };
  for (const key of HERDR_ENVIRONMENT_KEYS) delete next[key];
  return next;
};

export const ensurePrivateRuntime = async (
  runtimeDirectory: string,
  socketPath: string,
): Promise<void> => {
  const fileSystem = new BunFileSystem();
  await fileSystem.makeDirectory(runtimeDirectory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(runtimeDirectory, 0o700);
  try {
    await fileSystem.chmod(socketPath, 0o600);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
};

export const canOpenSocket = async (
  socketPath: string,
  uid: number,
  gid: number,
): Promise<boolean> => {
  try {
    const runner = new BunCommandRunner();
    const result = await runner.run(
      ["runuser", "--uid", String(uid), "--gid", String(gid), "--", "test", "-r", socketPath],
      {
        env: scrubHerdrEnvironment(Bun.env),
      },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const isMissingFile = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT") ||
  (error instanceof Error && /(?:ENOENT|no such file|not found)/iu.test(error.message));

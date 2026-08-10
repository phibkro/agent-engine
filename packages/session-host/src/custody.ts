import type {
  ArtifactReceipt,
  ContentManifest,
  ContentManifestEntry,
  SessionId,
  SessionStartSpec,
  Sha256Digest,
  WorkspaceViewId,
} from "@work-engine/protocol";
import {
  ArtifactReceiptSchema,
  ContentManifestSchema,
  canonicalJsonBytes,
  compareUtf8PathBytes,
  digestManifest,
  sha256,
  sortManifestEntries,
} from "@work-engine/protocol";
import type { ArtifactStore } from "@work-engine/runtime";
import { CustodyFailureError, workspaceViewId } from "./errors.ts";
import type { EffectExecutor } from "./execution.ts";
import { BunFileSystem, currentUserId } from "./bun-platform.ts";
import type { CommandResult, CommandRunner } from "./process.ts";
import { BunCommandRunner, scrubHerdrEnvironment } from "./process.ts";
import {
  dirnamePath,
  joinPath,
  pathSeparator,
  relativePath,
  resolvePath,
} from "./posix-path.ts";

export interface WorkspaceSession {
  readonly sessionId: SessionId;
  readonly worktreePath: string;
  readonly baseRepositoryPath: string;
  readonly workspaceViewId: WorkspaceViewId;
  readonly baseManifest: ContentManifest;
  readonly writableScope: readonly string[];
  readonly snapshotPath?: string;
  readonly finalized: boolean;
}

export interface FrozenCandidate {
  readonly sessionId: SessionId;
  readonly workspaceViewId: WorkspaceViewId;
  readonly worktreePath: string;
  readonly snapshotPath: string;
  readonly baseManifest: ContentManifest;
  readonly candidateManifest: ContentManifest;
  readonly changedPaths: readonly string[];
  readonly patch: ArtifactReceipt;
  readonly stdout: ArtifactReceipt;
  readonly stderr: ArtifactReceipt;
  readonly manifestArtifact: ArtifactReceipt;
  readonly check: {
    readonly command: string;
    readonly exitCode: number;
    readonly stdoutDigest: Sha256Digest;
    readonly stderrDigest: Sha256Digest;
    readonly candidateDigest: Sha256Digest;
  };
}

export interface WorkspaceCustodyOptions {
  readonly baseRoot: string;
  readonly worktreeRoot: string;
  readonly snapshotRoot: string;
  readonly artifactStore: ArtifactStore;
  readonly baseManifest: ContentManifest;
  readonly effectExecutor: EffectExecutor;
  readonly commandRunner?: CommandRunner;
  readonly fileSystem?: BunFileSystem;
  readonly requiredCheck?: string;
  readonly writableScope?: readonly string[];
  readonly hostUid?: number;
  readonly hostGid?: number;
  readonly mcpCommand?: string;
}
export interface CandidateFinalizeRequest {
  readonly sessionId: SessionId;
  readonly reason: string;
}

interface InternalWorkspaceSession {
  readonly sessionId: SessionId;
  readonly worktreePath: string;
  readonly baseRepositoryPath: string;
  readonly workspaceViewId: WorkspaceViewId;
  readonly baseManifest: ContentManifest;
  readonly writableScope: readonly string[];
  snapshotPath?: string;
  finalized: boolean;
  processExited: boolean;
}

export class WorkspaceCustodian {
  private readonly sessions = new Map<SessionId, InternalWorkspaceSession>();
  private readonly runner: CommandRunner;
  private readonly fileSystem: BunFileSystem;
  private readonly requiredCheck: string;
  private readonly hostUid: number;
  private readonly hostGid: number;

  constructor(private readonly options: WorkspaceCustodyOptions) {
    this.runner = options.commandRunner ?? new BunCommandRunner();
    this.fileSystem = options.fileSystem ?? new BunFileSystem(this.runner);
    this.requiredCheck = options.requiredCheck ?? "bun run check";
    this.hostUid = options.hostUid ?? currentUserId("uid");
    this.hostGid = options.hostGid ?? currentUserId("gid");
  }

  async prepare(spec: SessionStartSpec): Promise<WorkspaceSession> {
    const existing = this.sessions.get(spec.sessionId);
    if (existing !== undefined) return existing;
    await this.fileSystem.makeDirectory(this.options.baseRoot, { recursive: true, mode: 0o700 });
    await this.fileSystem.makeDirectory(this.options.worktreeRoot, {
      recursive: true,
      mode: 0o700,
    });
    await this.fileSystem.makeDirectory(this.options.snapshotRoot, {
      recursive: true,
      mode: 0o700,
    });
    const baseRepositoryPath = joinPath(
      this.options.baseRoot,
      digestHex(this.options.baseManifest.digest),
    );
    await this.materializeBase(baseRepositoryPath);
    const worktreePath = joinPath(this.options.worktreeRoot, spec.sessionId);
    await this.fileSystem.remove(worktreePath, { recursive: true, force: true });
    await this.runGit(["worktree", "add", "--detach", worktreePath, "HEAD"], baseRepositoryPath);
    await this.writeMcpConfig(worktreePath, spec.sessionId);
    const session: InternalWorkspaceSession = {
      sessionId: spec.sessionId,
      worktreePath,
      baseRepositoryPath,
      workspaceViewId: workspaceViewId(spec.sessionId),
      baseManifest: this.options.baseManifest,
      writableScope:
        this.options.writableScope ??
        (spec.workspaceLease.mode === "write" ? ["src/greeting.ts"] : []),
      finalized: false,
      processExited: false,
    };
    this.sessions.set(spec.sessionId, session);
    return session;
  }

  async markProcessExited(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new CustodyFailureError({
        _tag: "SnapshotUnavailable",
        reason: `unknown session: ${sessionId}`,
      });
    session.processExited = true;
  }

  async finalize(request: CandidateFinalizeRequest): Promise<FrozenCandidate> {
    const session = this.sessions.get(request.sessionId);
    if (session === undefined)
      throw new CustodyFailureError({
        _tag: "SnapshotUnavailable",
        reason: `unknown session: ${request.sessionId}`,
      });
    if (session.finalized)
      throw new CustodyFailureError({
        _tag: "CandidateAlreadyFinalized",
        sessionId: request.sessionId,
      });
    if (!session.processExited)
      throw new CustodyFailureError({
        _tag: "CandidateFinalizeBeforeExit",
        sessionId: request.sessionId,
      });
    const changedPaths = validateWritableScope(
      await this.changedPaths(session.worktreePath),
      session.writableScope,
    );
    const snapshotPath = joinPath(this.options.snapshotRoot, request.sessionId);
    await this.revoke(request.sessionId);
    await this.copyTrackedFiles(session.worktreePath, snapshotPath);
    await this.makeReadOnly(snapshotPath);
    await this.ensureHostOwnership(snapshotPath);
    const candidateManifest = await this.manifestFor(snapshotPath);
    const manifestBytes = canonicalJsonBytes({ entries: candidateManifest.entries });
    const manifestArtifact = await this.uploadVerified(manifestBytes, "application/json");
    const patchResult = await this.runGit(
      ["diff", "--binary", "--full-index", "--no-ext-diff", "--", "src/greeting.ts"],
      session.worktreePath,
    );
    const patch = await this.uploadVerified(patchResult.stdout, "text/x-diff");
    const check = await this.runCheck(snapshotPath);
    const stdout = await this.uploadVerified(check.stdout, "text/plain; charset=utf-8");
    const stderr = await this.uploadVerified(check.stderr, "text/plain; charset=utf-8");
    session.finalized = true;
    session.snapshotPath = snapshotPath;
    return {
      sessionId: request.sessionId,
      workspaceViewId: session.workspaceViewId,
      worktreePath: session.worktreePath,
      snapshotPath,
      baseManifest: session.baseManifest,
      candidateManifest,
      changedPaths: sortUtf8(changedPaths),
      patch,
      stdout,
      stderr,
      manifestArtifact,
      check: {
        command: this.requiredCheck,
        exitCode: check.exitCode,
        stdoutDigest: stdout.digest,
        stderrDigest: stderr.digest,
        candidateDigest: candidateManifest.digest,
      },
    };
  }

  async revoke(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    await this.makeReadOnly(session.worktreePath);
    const snapshotPath = session.snapshotPath;
    if (snapshotPath !== undefined) await this.ensureHostOwnership(snapshotPath);
  }

  async removeSession(sessionId: SessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    await this.fileSystem.remove(session.worktreePath, { recursive: true, force: true });
    if (session.snapshotPath !== undefined)
      await this.fileSystem.remove(session.snapshotPath, { recursive: true, force: true });
    this.sessions.delete(sessionId);
  }

  get(sessionId: SessionId): WorkspaceSession | undefined {
    return this.sessions.get(sessionId);
  }

  private async materializeBase(baseRepositoryPath: string): Promise<void> {
    const marker = joinPath(baseRepositoryPath, ".git", "HEAD");
    try {
      await this.fileSystem.readFile(marker);
      return;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await this.fileSystem.makeDirectory(baseRepositoryPath, { recursive: true, mode: 0o700 });
    await forEachSequential(sortManifestEntries(this.options.baseManifest.entries), async (entry) => {
      const path = safePath(baseRepositoryPath, entry.path);
      const bytes = await this.getArtifact(entry.digest);
      if (bytes.byteLength !== entry.bytes) {
        throw new CustodyFailureError({
          _tag: "BaseArtifactUnavailable",
          reason: `length mismatch for ${entry.path}`,
        });
      }
      const observed = await sha256(bytes);
      if (observed !== entry.digest) {
        throw new CustodyFailureError({
          _tag: "BaseArtifactUnavailable",
          reason: `digest mismatch for ${entry.path}`,
        });
      }
      await this.fileSystem.makeDirectory(dirnamePath(path), { recursive: true, mode: 0o700 });
      await this.fileSystem.writeFile(path, bytes, { mode: 0o600 });
    });
    await this.runGit(["init", "--initial-branch=main"], baseRepositoryPath);
    await this.runGit(["config", "user.email", "work-engine@localhost"], baseRepositoryPath);
    await this.runGit(["config", "user.name", "Work Engine"], baseRepositoryPath);
    await this.runGit(["add", "--all"], baseRepositoryPath);
    await this.runGit(["commit", "--message", "tracer base"], baseRepositoryPath);
  }

  private async copyTrackedFiles(worktreePath: string, snapshotPath: string): Promise<void> {
    await this.fileSystem.makeDirectory(snapshotPath, { recursive: true, mode: 0o700 });
    const listed = await this.runGit(["ls-files", "-z"], worktreePath);
    const paths = decodeNulSeparated(listed.stdout);
    await forEachSequential(paths, async (path) => {
      const source = safePath(worktreePath, path);
      const target = safePath(snapshotPath, path);
      await this.fileSystem.makeDirectory(dirnamePath(target), { recursive: true, mode: 0o700 });
      await this.fileSystem.copyFile(source, target);
      await this.fileSystem.chmod(target, 0o400);
    });
  }

  private async makeReadOnly(path: string): Promise<void> {
    await this.fileSystem.chmod(path, 0o555);
    const listed = await this.runner.run(["find", path, "-type", "f"], {
      env: scrubHerdrEnvironment(Bun.env),
    });
    if (listed.exitCode !== 0)
      throw new CustodyFailureError({
        _tag: "SnapshotUnavailable",
        reason: "cannot enumerate snapshot files",
      });
    await forEachSequential(decodeLines(listed.stdout), (file) => this.fileSystem.chmod(file, 0o444));
    const directories = await this.runner.run(["find", path, "-type", "d"], {
      env: scrubHerdrEnvironment(Bun.env),
    });
    if (directories.exitCode !== 0)
      throw new CustodyFailureError({
        _tag: "SnapshotUnavailable",
        reason: "cannot enumerate snapshot directories",
      });
    await forEachSequential(
      decodeLines(directories.stdout).toReversed(),
      (directory) => this.fileSystem.chmod(directory, 0o555),
    );
  }

  private async ensureHostOwnership(path: string): Promise<void> {
    try {
      await this.fileSystem.chown(path, this.hostUid, this.hostGid);
      const listed = await this.runner.run(["find", path, "-print"], {
        env: scrubHerdrEnvironment(Bun.env),
      });
      if (listed.exitCode !== 0) throw new Error("cannot enumerate ownership");
      await forEachSequential(decodeLines(listed.stdout), (item) =>
        this.fileSystem.chown(item, this.hostUid, this.hostGid),
      );
    } catch (error) {
      throw new CustodyFailureError({ _tag: "SnapshotUnavailable", reason: errorMessage(error) });
    }
  }

  private async changedPaths(worktreePath: string): Promise<readonly string[]> {
    const unstaged = await this.runGit(["diff", "--name-only", "--no-renames"], worktreePath);
    const staged = await this.runGit(
      ["diff", "--cached", "--name-only", "--no-renames"],
      worktreePath,
    );
    const untracked = await this.runGit(
      ["ls-files", "--others", "--exclude-standard"],
      worktreePath,
    );
    return sortUtf8([
      ...decodeLines(unstaged.stdout),
      ...decodeLines(staged.stdout),
      ...decodeLines(untracked.stdout),
    ]);
  }

  private async manifestFor(root: string): Promise<ContentManifest> {
    const listed = await this.runner.run(["find", root, "-type", "f", "-print"], {
      env: scrubHerdrEnvironment(Bun.env),
    });
    if (listed.exitCode !== 0)
      throw new CustodyFailureError({
        _tag: "SnapshotUnavailable",
        reason: "cannot enumerate candidate files",
      });
    const entries: ContentManifestEntry[] = [];
    await forEachSequential(decodeLines(listed.stdout), async (absolute) => {
      const path = relativePath(root, absolute).split(pathSeparator).join("/");
      if (path.length === 0 || path === ".mcp.json") return;
      const bytes = new Uint8Array(await this.fileSystem.readFile(absolute));
      entries.push({ path, digest: await sha256(bytes), bytes: bytes.byteLength });
    });
    const sorted = sortManifestEntries(entries);
    const digest = await digestManifest(sorted);
    return ContentManifestSchema.make({ _tag: "ContentManifest", digest, entries: sorted });
  }

  private async runCheck(snapshotPath: string): Promise<CommandResult> {
    const [executable, ...args] = this.requiredCheck.split(/\s+/u);
    if (executable === undefined)
      throw new CustodyFailureError({
        _tag: "WorkspaceCommandFailed",
        command: [this.requiredCheck],
        reason: "empty check command",
      });
    return this.runner.run([executable, ...args], {
      cwd: snapshotPath,
      env: scrubHerdrEnvironment(Bun.env),
    });
  }

  private async runGit(
    args: readonly string[],
    cwd: string,
    requireSuccess = true,
  ): Promise<CommandResult> {
    const result = await this.runner.run(["git", ...args], {
      cwd,
      env: scrubHerdrEnvironment(Bun.env),
    });
    if (requireSuccess && result.exitCode !== 0) {
      throw new CustodyFailureError({
        _tag: "WorkspaceCommandFailed",
        command: ["git", ...args],
        reason: errorMessage(new TextDecoder().decode(result.stderr)),
      });
    }
    return result;
  }

  private async getArtifact(digest: Sha256Digest): Promise<Uint8Array> {
    try {
      return await this.options.effectExecutor.execute(this.options.artifactStore.get(digest));
    } catch (error) {
      throw new CustodyFailureError({
        _tag: "BaseArtifactUnavailable",
        reason: errorMessage(error),
      });
    }
  }

  private async uploadVerified(content: Uint8Array, mediaType: string): Promise<ArtifactReceipt> {
    const expected = await sha256(content);
    let receipt: ArtifactReceipt;
    try {
      receipt = await this.options.effectExecutor.execute(
        this.options.artifactStore.put(content, mediaType),
      );
    } catch (error) {
      throw new CustodyFailureError({ _tag: "ArtifactUploadFailed", reason: errorMessage(error) });
    }
    if (receipt.digest !== expected || receipt.bytes !== content.byteLength) {
      throw new CustodyFailureError({
        _tag: "ArtifactVerificationFailed",
        digest: expected,
        reason: "put receipt mismatch",
      });
    }
    let head: ArtifactReceipt;
    try {
      head = await this.options.effectExecutor.execute(this.options.artifactStore.head(expected));
    } catch (error) {
      throw new CustodyFailureError({
        _tag: "ArtifactVerificationFailed",
        digest: expected,
        reason: errorMessage(error),
      });
    }
    if (
      head.digest !== expected ||
      head.bytes !== content.byteLength ||
      head.mediaType !== mediaType
    ) {
      throw new CustodyFailureError({
        _tag: "ArtifactVerificationFailed",
        digest: expected,
        reason: "head receipt mismatch",
      });
    }
    return ArtifactReceiptSchema.make({
      _tag: "ArtifactReceipt",
      digest: expected,
      bytes: content.byteLength,
      mediaType,
    });
  }

  private async writeMcpConfig(worktreePath: string, sessionId: SessionId): Promise<void> {
    const command = this.options.mcpCommand ?? "/opt/work-engine/bin/work";
    const config = {
      mcpServers: {
        "work-engine": {
          command,
          args: ["mcp", "--session", sessionId],
          env: { WORK_ENGINE_CAPABILITY_FILE: joinPath(worktreePath, ".work-engine-capability") },
        },
      },
    };
    const path = joinPath(worktreePath, ".mcp.json");
    await this.fileSystem.writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const excluded = await this.runGit(
      ["rev-parse", "--git-path", "info/exclude"],
      worktreePath,
      false,
    );
    if (excluded.exitCode === 0) {
      const excludePath = new TextDecoder().decode(excluded.stdout).trim();
      if (excludePath.length > 0) {
        const current = await this.fileSystem.readFileString(excludePath).catch(() => "");
        if (!current.split(/\r?\n/u).includes(".mcp.json"))
          await this.fileSystem.writeFile(
            excludePath,
            `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.mcp.json\n`,
            { mode: 0o600 },
          );
      }
    }
  }
}

export const validateWritableScope = (
  changedPaths: readonly string[],
  writableScope: readonly string[],
): readonly string[] => {
  const allowed = new Set(writableScope);
  const outOfScope = sortUtf8(changedPaths.filter((path) => !allowed.has(path)));
  if (outOfScope.length > 0)
    throw new CustodyFailureError({ _tag: "CandidateScopeViolation", changedPaths: outOfScope });
  return sortUtf8(changedPaths);
};

const safePath = (root: string, path: string): string => {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
    throw new CustodyFailureError({ _tag: "WorkspacePathRejected", path });
  const resolved = resolvePath(root, path);
  const rootResolved = resolvePath(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${pathSeparator}`))
    throw new CustodyFailureError({ _tag: "WorkspacePathRejected", path });
  return resolved;
};

const forEachSequential = async <A>(
  values: readonly A[],
  operation: (value: A) => Promise<void>,
  index = 0,
): Promise<void> => {
  const value = values[index];
  if (value === undefined) return;
  await operation(value);
  await forEachSequential(values, operation, index + 1);
};

const decodeLines = (bytes: Uint8Array): readonly string[] =>
  new TextDecoder()
    .decode(bytes)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
const decodeNulSeparated = (bytes: Uint8Array): readonly string[] =>
  new TextDecoder()
    .decode(bytes)
    .split("\0")
    .filter((path) => path.length > 0);
const sortUtf8 = (paths: readonly string[]): readonly string[] =>
  [...new Set(paths)].toSorted(compareUtf8PathBytes);
const digestHex = (value: string): string => value.replace(/[^a-z0-9]/giu, "").slice(-64);
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isMissingFile = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT") ||
  (error instanceof Error && /(?:ENOENT|no such file|not found)/iu.test(error.message));

import type { SessionStartSpec, SessionId } from "@work-engine/protocol";
import type { StartClaim } from "./persistence.ts";
import { CustodyFailureError } from "./errors.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Environment;
  readonly uid?: number;
  readonly gid?: number;
  readonly timeoutMs?: number;
}

export interface CommandRunner {
  run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

const collect = async (stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> => {
  if (stream === null) return new Uint8Array();
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

export class BunCommandRunner implements CommandRunner {
  async run(argv: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
    const [executable, ...args] = argv;
    if (executable === undefined || executable.length === 0)
      throw new Error("command requires an executable");
    if (options.uid !== undefined || options.gid !== undefined)
      throw new Error("Bun command execution does not support uid/gid options");
    const child = Bun.spawn([executable, ...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = collect(child.stdout);
    const stderrPromise = collect(child.stderr);
    const exitCode = await waitForExit(child, options.timeoutMs);
    return {
      exitCode,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
  }
}

const waitForExit = async (
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number | undefined,
): Promise<number> => {
  const exit = child.exited;
  if (timeoutMs === undefined) return exit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(124);
    }, timeoutMs);
  });
  const result = await Promise.race([exit, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
};

export interface SessionProcess {
  readonly reference: string;
  readonly launchId: string;
  readonly sessionId: SessionId;
  readonly pid?: number;
  readonly startedAt: string;
}

export interface SessionProcessController {
  findExisting(claim: StartClaim): Promise<SessionProcess | undefined>;
  spawn(
    spec: SessionStartSpec,
    launchId: string,
    processReference: string,
  ): Promise<SessionProcess>;
  cancel(sessionId: SessionId, reason: string): Promise<void>;
  isExited(sessionId: SessionId): Promise<boolean>;
}

export interface ProcessSupervisor {
  find(launchId: string): Promise<SessionProcess | undefined>;
  track(process: SessionProcess): Promise<void>;
  cancel(sessionId: SessionId, reason: string): Promise<void>;
  isExited(sessionId: SessionId): Promise<boolean>;
}

export class MemoryProcessSupervisor implements ProcessSupervisor {
  private readonly processes = new Map<string, SessionProcess>();
  private readonly terminal = new Set<SessionId>();

  find(launchId: string): Promise<SessionProcess | undefined> {
    return Promise.resolve(this.processes.get(launchId));
  }

  track(process: SessionProcess): Promise<void> {
    this.processes.set(process.launchId, process);
    this.terminal.delete(process.sessionId);
    return Promise.resolve();
  }

  cancel(sessionId: SessionId): Promise<void> {
    this.terminal.add(sessionId);
    return Promise.resolve();
  }

  isExited(sessionId: SessionId): Promise<boolean> {
    return Promise.resolve(this.terminal.has(sessionId));
  }

  markExited(sessionId: SessionId): void {
    this.terminal.add(sessionId);
  }
}

export interface HerdrSessionControllerOptions {
  readonly runner: CommandRunner;
  readonly supervisor: ProcessSupervisor;
  readonly sessionName: string;
  readonly runtimeDirectory: string;
  readonly workspaceDirectory: string;
  readonly herdrBinary?: string;
  readonly roleFor?: (spec: SessionStartSpec) => "manager" | "worker";
  readonly environment?: Environment;
}

interface HerdrIdentifier {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

/**
 * Trusted adapter around the reviewed Herdr named-agent API. OMP is started
 * only after the claim has been journalled by SessionHostService.
 */
export class HerdrSessionController implements SessionProcessController {
  private projectWorkspace: string | undefined;
  private readonly herdrBinary: string;

  constructor(private readonly options: HerdrSessionControllerOptions) {
    this.herdrBinary = options.herdrBinary ?? "herdr";
  }

  async findExisting(claim: StartClaim): Promise<SessionProcess | undefined> {
    return this.options.supervisor.find(claim.launchId);
  }

  async spawn(
    spec: SessionStartSpec,
    launchId: string,
    processReference: string,
  ): Promise<SessionProcess> {
    const topology = await this.ensureProjectTopology(spec);
    const role = this.options.roleFor?.(spec) ?? "worker";
    const agentName = `${role}-${spec.sessionId}`;
    const started = await this.runHerdr([
      "agent",
      "start",
      agentName,
      "--kind",
      "omp",
      "--pane",
      topology.paneId,
    ]);
    if (started.exitCode !== 0) {
      throw new CustodyFailureError({
        _tag: "WorkspaceCommandFailed",
        command: [
          this.herdrBinary,
          "agent",
          "start",
          agentName,
          "--kind",
          "omp",
          "--pane",
          topology.paneId,
        ],
        reason: decodeOutput(started.stderr, "Herdr agent start failed"),
      });
    }
    const process: SessionProcess = {
      reference: processReference,
      launchId,
      sessionId: spec.sessionId,
      startedAt: new Date().toISOString(),
    };
    await this.options.supervisor.track(process);
    return process;
  }

  async cancel(sessionId: SessionId, reason: string): Promise<void> {
    await this.options.supervisor.cancel(sessionId, reason);
  }

  isExited(sessionId: SessionId): Promise<boolean> {
    return this.options.supervisor.isExited(sessionId);
  }

  private async ensureProjectTopology(spec: SessionStartSpec): Promise<HerdrIdentifier> {
    if (this.projectWorkspace !== undefined) {
      return this.createTab(this.projectWorkspace, spec);
    }
    const workspace = await this.runHerdr([
      "workspace",
      "create",
      "--cwd",
      this.options.workspaceDirectory,
      "--label",
      `project-${spec.projectId}`,
      "--no-focus",
    ]);
    if (workspace.exitCode !== 0) {
      throw new CustodyFailureError({
        _tag: "WorkspaceCommandFailed",
        command: [this.herdrBinary, "workspace", "create"],
        reason: decodeOutput(workspace.stderr, "Herdr workspace create failed"),
      });
    }
    const workspaceId = parseIdentifier(workspace.stdout, "workspaceId");
    this.projectWorkspace = workspaceId;
    return this.createTab(workspaceId, spec);
  }

  private async createTab(workspaceId: string, spec: SessionStartSpec): Promise<HerdrIdentifier> {
    const tab = await this.runHerdr([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      this.options.workspaceDirectory,
      "--label",
      `session-${spec.sessionId}`,
      "--no-focus",
    ]);
    if (tab.exitCode !== 0) {
      throw new CustodyFailureError({
        _tag: "WorkspaceCommandFailed",
        command: [this.herdrBinary, "tab", "create"],
        reason: decodeOutput(tab.stderr, "Herdr tab create failed"),
      });
    }
    return parseTabIdentifiers(tab.stdout, workspaceId);
  }

  private async runHerdr(args: readonly string[]): Promise<CommandResult> {
    return this.options.runner.run(
      [this.herdrBinary, "--session", this.options.sessionName, ...args],
      {
        cwd: this.options.runtimeDirectory,
        env: scrubHerdrEnvironment(this.options.environment ?? Bun.env),
      },
    );
  }
}

export const scrubHerdrEnvironment = (environment: Environment): Environment => {
  const next = { ...environment };
  delete next.HERDR_ENV;
  delete next.HERDR_BIN_PATH;
  delete next.HERDR_SOCKET_PATH;
  delete next.HERDR_PANE_ID;
  return next;
};

export const parseIdentifier = (bytes: Uint8Array, field: string): string => {
  const text = decodeOutput(bytes, `missing Herdr ${field}`);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
    if (typeof parsed === "object" && parsed !== null && field in parsed) {
      const value = parsed[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Herdr also supports a plain identifier response; use it below.
  }
  const [first] = text.split(/\s+/u);
  if (first === undefined || first.length === 0)
    throw new Error(`Herdr response did not contain ${field}`);
  return first;
};

const parseTabIdentifiers = (bytes: Uint8Array, workspaceId: string): HerdrIdentifier => {
  const text = decodeOutput(bytes, "missing Herdr tab identifiers");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const tabId = typeof record.tabId === "string" ? record.tabId : undefined;
      const paneId = typeof record.paneId === "string" ? record.paneId : undefined;
      if (tabId !== undefined && paneId !== undefined) return { workspaceId, tabId, paneId };
    }
  } catch {
    // Plain tab/pane output is accepted below.
  }
  const [tabId, paneId] = text.split(/\s+/u);
  if (tabId === undefined || paneId === undefined)
    throw new Error("Herdr response did not contain tab and pane identifiers");
  return { workspaceId, tabId, paneId };
};

const decodeOutput = (bytes: Uint8Array, fallback: string): string => {
  const text = new TextDecoder().decode(bytes).trim();
  return text.length === 0 ? fallback : text;
};

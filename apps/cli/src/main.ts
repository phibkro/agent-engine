#!/usr/bin/env bun
import { Cause, Effect, Exit, Schema } from "effect";
import { SessionIdSchema } from "@work-engine/protocol";
import {
  executeInvocation,
  loadClientForInvocation,
  parseInvocation,
  type ParsedInvocation,
} from "./commands.ts";
import { loadSessionCapability } from "./config.ts";
import { runMcp } from "./mcp.ts";
import {
  failureEnvelope,
  renderInteractive,
  renderJson,
  successEnvelope,
  type CliFailure,
  type ResultEnvelope,
} from "./output.ts";

const stdout = Bun.stdout.writer();
const stderr = Bun.stderr.writer();

const writeStdout = (text: string): void => {
  stdout.write(`${text}\n`);
  stdout.flush();
};

const writeStderr = (text: string): void => {
  stderr.write(`${text}\n`);
  stderr.flush();
};

const unknownFailure = (error: unknown): CliFailure => {
  if (typeof error === "object" && error !== null && "_tag" in error) return error as CliFailure;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "SIGINT")) {
    return { _tag: "Cancelled", reason: "operator cancelled the command" };
  }
  return {
    _tag: "TransportFailure",
    reason: error instanceof Error ? error.message : String(error),
  };
};

const emit = (invocation: ParsedInvocation, envelope: ResultEnvelope): void => {
  if (invocation.json) {
    writeStdout(renderJson(envelope));
  } else if (envelope.ok) {
    writeStdout(renderInteractive(invocation.command, envelope.data));
  } else if (envelope.error !== undefined) {
    writeStderr(`${invocation.command}: ${envelope.error.reason}`);
  }
};

const runMcpRoot = (invocation: ParsedInvocation): Effect.Effect<void, CliFailure> =>
  Effect.gen(function* () {
    const sessionValue = invocation.flags.get("session");
    if (typeof sessionValue !== "string") {
      return yield* Effect.fail({
        _tag: "UsageFailure",
        reason: "mcp requires --session <session-id>",
      } as const);
    }
    const sessionId = yield* Schema.decodeUnknownEffect(SessionIdSchema, {
      onExcessProperty: "error",
    })(sessionValue).pipe(
      Effect.mapError((error) => ({
        _tag: "UsageFailure" as const,
        reason: `invalid Session id: ${String(error)}`,
      })),
    );
    const capability = yield* loadSessionCapability(sessionId);
    const input = (async function* (): AsyncIterable<string> {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of Bun.stdin.stream()) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) yield line;
      }
      if (buffered.length > 0) yield buffered;
    })();
    yield* runMcp(capability, {
      input,
      write: (line) => Effect.sync(() => writeStdout(line)),
    });
  });

export const runCli = (argv: ReadonlyArray<string>): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const parsed = parseInvocation(argv);
    if ("_tag" in parsed) {
      const envelope = failureEnvelope("usage", parsed);
      if (argv.includes("--json")) writeStdout(renderJson(envelope));
      else writeStderr(envelope.error?.reason ?? "usage failure");
      return envelope.error?.exitCode ?? 2;
    }
    writeStderr(`${parsed.command}: contacting Work Engine`);
    const result = yield* Effect.exit(
      parsed.command === "mcp"
        ? runMcpRoot(parsed)
        : Effect.gen(function* () {
            const loaded = yield* loadClientForInvocation(parsed);
            return yield* executeInvocation(parsed, loaded.client, loaded.config);
          }),
    );
    if (Exit.isSuccess(result)) {
      const envelope = successEnvelope(parsed.command, result.value);
      emit(parsed, envelope);
      return 0;
    }
    const failure = unknownFailure(Exit.isFailure(result) ? Cause.squash(result.cause) : result);
    const envelope = failureEnvelope(parsed.command, failure);
    emit(parsed, envelope);
    return envelope.error?.exitCode ?? 5;
  });

export const main = async (): Promise<void> => {
  const exitCode = await Effect.runPromise(runCli(Bun.argv.slice(2)));
  // oxlint-disable-next-line effect/no-cross-runtime -- Bun has no native exit-code setter.
  process.exitCode = exitCode;
};

if (import.meta.main) {
  await main();
}

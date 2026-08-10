#!/usr/bin/env bun
import { Effect, type Exit } from "effect";
import { executeInvocation, parseInvocation } from "./commands.ts";
import { makeCloudTaskClient } from "./client.ts";
import { loadOperatorConfig } from "./config.ts";
import {
  exitCodeFor,
  failureEnvelope,
  renderJson,
  successEnvelope,
  type CliFailure,
  type ResultEnvelope,
} from "./output.ts";

export const CLI_VERSION = "work-engine 0.0.0";

const stdout = Bun.stdout.writer();
const stderr = Bun.stderr.writer();

const writeStdout = (text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    stdout.write(`${text}\n`);
    stdout.flush();
  });

const writeStderr = (text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    stderr.write(`${text}\n`);
    stderr.flush();
  });

const unexpectedFailure = (error: unknown): CliFailure => ({
  _tag: "UnexpectedFailure",
  reason: error instanceof Error ? error.message : String(error),
});

export interface CliDependencies {
  readonly loadConfig?: typeof loadOperatorConfig;
  readonly makeClient?: typeof makeCloudTaskClient;
}

export const runCli = (
  argv: ReadonlyArray<string>,
  dependencies: CliDependencies = {},
): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const parsed = parseInvocation(argv);
    if ("_tag" in parsed) {
      const envelope = failureEnvelope("result", parsed);
      yield* writeStdout(renderJson(envelope));
      return exitCodeFor(parsed);
    }
    const configResult = yield* (dependencies.loadConfig ?? loadOperatorConfig).pipe(Effect.result);
    if (configResult._tag === "Failure") {
      yield* writeStdout(renderJson(failureEnvelope("result", configResult.failure)));
      return exitCodeFor(configResult.failure);
    }
    const config = configResult.success;
    const client = (dependencies.makeClient ?? makeCloudTaskClient)(config);
    const result = yield* executeInvocation(parsed, client).pipe(Effect.result);
    if (result._tag === "Failure") {
      const failure: CliFailure = result.failure;
      yield* writeStdout(renderJson(failureEnvelope(parsed.operation, failure)));
      return exitCodeFor(failure);
    }
    yield* writeStdout(renderJson(successEnvelope(parsed.operation, result.success)));
    return 0;
  }).pipe(
    Effect.catchCause((error) => {
      const failure = unexpectedFailure(error);
      return writeStderr(renderJson(failureEnvelope("result", failure))).pipe(
        Effect.as(exitCodeFor(failure)),
      );
    }),
  );

export const main = (argv: ReadonlyArray<string> = Bun.argv.slice(2)): Effect.Effect<void> =>
  runCli(argv).pipe(
    Effect.flatMap((exit) => (exit === 0 ? Effect.void : Effect.sync(() => Bun.exit(exit)))),
  );

if (import.meta.main) {
  await Effect.runPromise(main());
}

export type CliExit = Exit.Exit<number, never>;
export type CliEnvelope = ResultEnvelope;

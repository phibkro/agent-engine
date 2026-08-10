#!/usr/bin/env bun
import { Effect, Exit } from "effect";
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

const writeStdout = (text: string): void => {
  stdout.write(`${text}\n`);
  stdout.flush();
};

const writeStderr = (text: string): void => {
  stderr.write(`${text}\n`);
  stderr.flush();
};

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
      writeStdout(renderJson(envelope));
      return exitCodeFor(parsed);
    }
    const config = yield* (dependencies.loadConfig ?? loadOperatorConfig).pipe(
      Effect.mapError(unexpectedFailure),
    );
    const client = (dependencies.makeClient ?? makeCloudTaskClient)(config);
    const result = yield* executeInvocation(parsed, client).pipe(Effect.either);
    if (result._tag === "Left") {
      const failure: CliFailure = result.left;
      writeStdout(renderJson(failureEnvelope(parsed.operation, failure)));
      return exitCodeFor(failure);
    }
    writeStdout(renderJson(successEnvelope(parsed.operation, result.right)));
    return 0;
  }).pipe(
    Effect.catchAll((error) => {
      const failure = unexpectedFailure(error);
      writeStderr(JSON.stringify(failureEnvelope("result", failure)));
      return Effect.succeed(exitCodeFor(failure));
    }),
  );

export const main = async (): Promise<void> => {
  const exit = await Effect.runPromise(runCli(Bun.argv.slice(2)));
  if (exit !== 0) process.exitCode = exit;
};

if (import.meta.main) {
  await main();
}

export type CliExit = Exit.Exit<number, never>;
export type CliEnvelope = ResultEnvelope;

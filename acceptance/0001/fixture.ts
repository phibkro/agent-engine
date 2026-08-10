import { Schema } from "effect";
import {
  TracerFixtureManifestSchema,
  canonicalize,
  digestManifest,
  sha256,
  sortManifestEntries,
  type Sha256Digest,
  type TracerFixtureEntry,
  type TracerFixtureManifest,
} from "../../packages/protocol/src/index.ts";

const ROOT = `${import.meta.dirname}/../..`;
const FIXTURE_ROOT = `${ROOT}/fixtures/tracer-0001`;
const FIXTURE_PATHS = ["package.json", "src/greeting.ts", "test/greeting.test.ts"] as const;
const CANDIDATE_GREETING = "export const greeting = (name: string): string => `Hello, ${name}!`;\n";
const encoder = new TextEncoder();

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface FixtureVerification {
  readonly manifest: TracerFixtureManifest;
  readonly patch: Uint8Array;
  readonly stdoutDigest: Sha256Digest;
  readonly stderrDigest: Sha256Digest;
}

const capture = async (command: ReadonlyArray<string>, cwd: string): Promise<CommandCapture> => {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]);
  return { exitCode, stdout, stderr };
};

const command = async (argv: ReadonlyArray<string>, cwd: string): Promise<CommandCapture> => {
  const result = await capture(argv, cwd);
  if (result.exitCode !== 0) {
    const reason = new TextDecoder().decode(result.stderr);
    throw new Error(`${argv.join(" ")} failed with ${result.exitCode}: ${reason}`);
  }
  return result;
};

const entriesFor = async (
  contents: Readonly<Record<(typeof FIXTURE_PATHS)[number], Uint8Array>>,
): Promise<ReadonlyArray<TracerFixtureEntry>> =>
  sortManifestEntries(
    await Promise.all(
      FIXTURE_PATHS.map(async (path) => ({
        path,
        digest: await sha256(contents[path]),
        bytes: contents[path].byteLength,
      })),
    ),
  );

const snapshotFor = async (
  contents: Readonly<Record<(typeof FIXTURE_PATHS)[number], Uint8Array>>,
) => {
  const entries = await entriesFor(contents);
  return {
    digest: await digestManifest(entries),
    bytes: encoder.encode(canonicalize(entries)).byteLength,
    entries,
  } as const;
};

const readBaseContents = async () =>
  Object.fromEntries(
    await Promise.all(
      FIXTURE_PATHS.map(async (path) => [
        path,
        new Uint8Array(await Bun.file(`${FIXTURE_ROOT}/${path}`).arrayBuffer()),
      ]),
    ),
  ) as Record<(typeof FIXTURE_PATHS)[number], Uint8Array>;

const makeTempDirectory = async (): Promise<string> => {
  const result = await command(["mktemp", "-d"], ROOT);
  return new TextDecoder().decode(result.stdout).trim();
};

const removeTempDirectory = async (path: string): Promise<void> => {
  await command(["rm", "-rf", "--", path], ROOT);
};

const materialize = async (
  root: string,
  contents: Readonly<Record<(typeof FIXTURE_PATHS)[number], Uint8Array>>,
): Promise<void> => {
  await command(["mkdir", "-p", `${root}/src`, `${root}/test`], ROOT);
  await Promise.all(FIXTURE_PATHS.map((path) => Bun.write(`${root}/${path}`, contents[path])));
};

const assertEqual = (actual: unknown, expected: unknown, label: string): void => {
  if (canonicalize(actual as never) !== canonicalize(expected as never)) {
    throw new Error(`${label} does not match fixtures/tracer-0001/manifest.json`);
  }
};

export const verifyFixture = async (): Promise<FixtureVerification> => {
  const committed = Schema.decodeUnknownSync(TracerFixtureManifestSchema, {
    onExcessProperty: "error",
  })(JSON.parse(await Bun.file(`${FIXTURE_ROOT}/manifest.json`).text()) as unknown);
  const baseContents = await readBaseContents();
  const candidateContents = {
    ...baseContents,
    "src/greeting.ts": encoder.encode(CANDIDATE_GREETING),
  };
  const base = await snapshotFor(baseContents);
  const candidate = await snapshotFor(candidateContents);
  const temp = await makeTempDirectory();
  try {
    await materialize(temp, baseContents);
    await command(["git", "init", "-q"], temp);
    await command(["git", "add", ...FIXTURE_PATHS], temp);
    const tracked = await command(["git", "ls-files"], temp);
    const trackedPaths = new TextDecoder().decode(tracked.stdout).trim().split("\n");
    assertEqual(trackedPaths, FIXTURE_PATHS.toSorted(), "fixture tracked paths");

    const baseCheck = await capture(["bun", "run", "check"], temp);
    if (baseCheck.exitCode === 0) throw new Error("fixture base check unexpectedly passed");

    await Bun.write(`${temp}/src/greeting.ts`, candidateContents["src/greeting.ts"]);
    const candidateCheck = await capture(["bun", "run", "check"], temp);
    if (candidateCheck.exitCode !== 0) {
      throw new Error("fixture candidate check did not pass");
    }
    const patchResult = await command(
      ["git", "diff", "--binary", "--full-index", "--no-ext-diff", "--", "src/greeting.ts"],
      temp,
    );
    const generated = {
      schemaVersion: "work-engine/tracer-0001",
      objective:
        'Make `greeting("Ada")` return `Hello, Ada!`. Modify only `src/greeting.ts`. Run `bun run check`.',
      check: "bun run check",
      writableScope: ["src/greeting.ts"],
      base,
      candidate,
      patch: {
        digest: await sha256(patchResult.stdout),
        bytes: patchResult.stdout.byteLength,
      },
    } as const;
    assertEqual(generated, committed, "fixture manifest");
    return {
      manifest: committed,
      patch: patchResult.stdout,
      stdoutDigest: await sha256(candidateCheck.stdout),
      stderrDigest: await sha256(candidateCheck.stderr),
    };
  } finally {
    await removeTempDirectory(temp);
  }
};

if (import.meta.main) {
  const verified = await verifyFixture();
  await Bun.write(Bun.stdout, `${JSON.stringify(verified.manifest)}\n`);
}

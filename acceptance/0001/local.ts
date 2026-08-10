import { sha256 } from "../../packages/protocol/src/index.ts";
import { verifyFixture } from "./fixture.ts";
import {
  readEvidenceFile,
  validateEvidenceAgainstLiveProject,
  writeCanonicalEvidence,
} from "./validate.ts";

const ROOT = `${import.meta.dirname}/../..`;
const IMAGE_TAG = "work-engine-tracer-0001:local";

interface Capture {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const capture = async (argv: ReadonlyArray<string>, cwd = ROOT): Promise<Capture> => {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]);
  return { exitCode, stdout, stderr };
};

const run = async (argv: ReadonlyArray<string>, cwd = ROOT): Promise<Capture> => {
  const result = await capture(argv, cwd);
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`${argv.join(" ")} failed with ${result.exitCode}: ${stderr}`);
  }
  return result;
};

const output = (result: Capture): string =>
  `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`;

const requireVersion = async (
  command: ReadonlyArray<string>,
  expected: string,
): Promise<string> => {
  const observed = output(await run(command)).trim();
  if (!observed.includes(expected)) {
    throw new Error(
      `${command.join(" ")} reported ${JSON.stringify(observed)}, expected ${expected}`,
    );
  }
  return observed;
};

const containerSmoke = async (): Promise<void> => {
  await run([
    "docker",
    "build",
    "--file",
    "infra/project-container/Dockerfile",
    "--tag",
    IMAGE_TAG,
    ".",
  ]);
  const script = [
    "herdr --version | grep -F 0.8.0",
    "omp --version | grep -F 17.2.3",
    "work --version | grep -F 0.0.0",
    "grep -F 'resume_agents_on_restore = false' /etc/herdr/herdr.toml",
    'test "$(stat -c %a /run/work-engine)" = 700',
    'test "$(stat -c %u /run/work-engine)" = "$(id -u work-engine-host)"',
    "useradd --system --create-home work-engine-session-a",
    "useradd --system --create-home work-engine-session-b",
    "install -o work-engine-session-a -g work-engine-session-a -m 0600 /dev/null /tmp/session-a-token",
    "! runuser -u work-engine-session-b -- test -r /tmp/session-a-token",
    "install -o work-engine-host -g work-engine-host -m 0600 /dev/null /run/work-engine/herdr.sock",
    "! runuser -u work-engine-session-a -- test -r /run/work-engine/herdr.sock",
  ].join(" && ");
  await run(["docker", "run", "--rm", "--entrypoint", "/bin/sh", IMAGE_TAG, "-ceu", script]);
};

const main = async (): Promise<void> => {
  const fixture = await verifyFixture();
  await run(["bun", "run", "test:kernel"]);
  await run(["bun", "run", "test:cloudflare"]);
  await run(["bun", "run", "test:session-host"]);
  await requireVersion(["herdr", "--version"], "0.8.0");
  await requireVersion(["omp", "--version"], "17.2.3");
  const integration = await requireVersion(["herdr", "integration", "status"], "omp");
  await containerSmoke();

  const capturePath = Bun.env["WORK_ENGINE_ACCEPTANCE_CAPTURE"];
  if (capturePath === undefined || capturePath.length === 0) {
    throw new Error(
      "WORK_ENGINE_ACCEPTANCE_CAPTURE is required; it must contain evidence from the real local workerd, Container, Herdr, OMP, and Workers AI journey",
    );
  }
  const evidence = await readEvidenceFile(capturePath, "local");
  await validateEvidenceAgainstLiveProject(evidence);
  await writeCanonicalEvidence(evidence);
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({
      status: "accepted",
      mode: "local",
      fixtureDigest: fixture.manifest.candidate.digest,
      patchDigest: fixture.manifest.patch.digest,
      integrationDigest: await sha256(new TextEncoder().encode(integration)),
    })}\n`,
  );
};

await main();

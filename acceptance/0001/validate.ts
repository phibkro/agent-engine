import { Schema } from "effect";
import {
  AuthenticatedActorSchema,
  CloudTracerEvidenceSchema,
  LocalTracerEvidenceSchema,
  ProjectObservationSchema,
  canonicalize,
  type CloudTracerEvidence,
  type LocalTracerEvidence,
  type ProjectObservation,
  type TracerAcceptanceEvidence,
} from "../../packages/protocol/src/index.ts";
import { WorkEngineHeader } from "../../packages/runtime/src/index.ts";
import { verifyFixture } from "./fixture.ts";

const ROOT = `${import.meta.dirname}/../..`;

const fail = (reason: string): never => {
  throw new Error(reason);
};

const requireCondition = (condition: boolean, reason: string): void => {
  if (!condition) fail(reason);
};

export const decodeAcceptanceEvidence = (
  input: unknown,
  mode: "local" | "cloud",
): LocalTracerEvidence | CloudTracerEvidence =>
  Schema.decodeUnknownSync(
    mode === "local" ? LocalTracerEvidenceSchema : CloudTracerEvidenceSchema,
    {
      onExcessProperty: "error",
    },
  )(input);

const sameObservation = (left: ProjectObservation, right: ProjectObservation): boolean =>
  canonicalize(left) === canonicalize(right);

export const validateEvidenceInvariants = async (
  evidence: TracerAcceptanceEvidence,
): Promise<void> => {
  const fixture = await verifyFixture();
  const { identities, artifacts, attach, runtime } = evidence;
  requireCondition(attach.projectId === identities.projectId, "attach Project identity drifted");
  requireCondition(attach.workId === identities.workId, "attach Work identity drifted");
  requireCondition(
    evidence.preRestart.projectId === identities.projectId &&
      evidence.postRestart.projectId === identities.projectId &&
      evidence.postReplacement.projectId === identities.projectId,
    "observation Project identity drifted",
  );
  requireCondition(
    evidence.finalEventRevision === evidence.postReplacement.eventRevision,
    "final event revision is not the live replacement observation",
  );
  requireCondition(
    evidence.finalContentRevision === evidence.postReplacement.contentRevision,
    "final content revision is not the live replacement observation",
  );
  requireCondition(
    evidence.postReplacement.canonicalContent?.digest === evidence.acceptedCandidateDigest,
    "replacement observation does not reference the accepted candidate",
  );
  requireCondition(
    evidence.preRestart.canonicalContent?.digest === evidence.acceptedCandidateDigest &&
      evidence.postRestart.canonicalContent?.digest === evidence.acceptedCandidateDigest,
    "Herdr restart changed accepted Project content",
  );
  requireCondition(
    runtime.containerGenerationBefore !== runtime.containerGenerationAfter,
    "Container replacement did not change generation",
  );
  requireCondition(
    runtime.compatibilityFlags.includes("containers_pid_namespace"),
    "required containers_pid_namespace flag is absent",
  );
  requireCondition(
    identities.retrySessionId !== undefined &&
      identities.retrySessionId !== identities.workerSessionId,
    "retry did not receive a distinct Session identity",
  );
  requireCondition(identities.gateIds.length > 0, "no Gate identities were captured");
  requireCondition(evidence.commandReceipts.length > 0, "no command receipts were captured");
  requireCondition(evidence.evidenceIds.length > 0, "no Evidence identities were captured");
  requireCondition(evidence.whyReferences.length > 0, "work why returned no canonical references");
  requireCondition(
    artifacts.changedPaths.length === 1 && artifacts.changedPaths[0] === "src/greeting.ts",
    "candidate changed paths do not equal the frozen writable scope",
  );
  requireCondition(
    artifacts.baseManifestDigest === fixture.manifest.base.digest &&
      artifacts.candidateManifestDigest === fixture.manifest.candidate.digest &&
      artifacts.patchDigest === fixture.manifest.patch.digest,
    "deployed artifact digests do not match the committed fixture",
  );
  requireCondition(
    evidence.acceptedCandidateDigest === fixture.manifest.candidate.digest,
    "accepted candidate is not the committed fixture candidate",
  );
  const controls = evidence.controls;
  requireCondition(
    controls.replayStable &&
      controls.wrongCandidateCheckRejected &&
      controls.outOfScopeCandidateRejected &&
      controls.frozenSnapshotImmutable &&
      controls.sessionIsolationEnforced &&
      controls.duplicateStartStable &&
      controls.herdrRestartInterrupted &&
      controls.replacementPreservedCandidate,
    "one or more negative controls did not hold",
  );
};

const readRequiredEnvironment = (name: string): string => {
  const value = Bun.env[name];
  return value === undefined || value.length === 0 ? fail(`${name} is required`) : value;
};

export const observeLiveProject = async (
  evidence: LocalTracerEvidence | CloudTracerEvidence,
): Promise<ProjectObservation> => {
  const baseUrl =
    evidence._tag === "CloudTracerEvidence"
      ? evidence.deployedUrl
      : readRequiredEnvironment("WORK_ENGINE_URL");
  const actorPath = readRequiredEnvironment("WORK_ENGINE_ACTOR_FILE");
  const actor = Schema.decodeUnknownSync(AuthenticatedActorSchema, {
    onExcessProperty: "error",
  })(JSON.parse(await Bun.file(actorPath).text()) as unknown);
  const response = await fetch(
    new URL(
      `/v1/projects/${encodeURIComponent(evidence.identities.projectId)}/observations/current`,
      `${baseUrl}/`,
    ),
    {
      headers: {
        Accept: "application/json",
        [WorkEngineHeader.actorId]: actor.actorId,
        [WorkEngineHeader.grantIds]: actor.presentedGrants.join(","),
        [WorkEngineHeader.accessClientId]: readRequiredEnvironment("WORK_ENGINE_ACCESS_CLIENT_ID"),
        [WorkEngineHeader.accessClientSecret]: readRequiredEnvironment(
          "WORK_ENGINE_ACCESS_CLIENT_SECRET",
        ),
      },
    },
  );
  const body = await response.text();
  if (!response.ok) fail(`live observation returned HTTP ${response.status}: ${body}`);
  return Schema.decodeUnknownSync(ProjectObservationSchema, { onExcessProperty: "error" })(
    JSON.parse(body) as unknown,
  );
};

export const validateEvidenceAgainstLiveProject = async (
  evidence: LocalTracerEvidence | CloudTracerEvidence,
): Promise<void> => {
  await validateEvidenceInvariants(evidence);
  const live = await observeLiveProject(evidence);
  requireCondition(
    sameObservation(live, evidence.postReplacement),
    "committed evidence does not match the current Project observation",
  );
};

export const readEvidenceFile = async (
  path: string,
  mode: "local" | "cloud",
): Promise<LocalTracerEvidence | CloudTracerEvidence> =>
  decodeAcceptanceEvidence(JSON.parse(await Bun.file(path).text()) as unknown, mode);

export const writeCanonicalEvidence = async (
  evidence: LocalTracerEvidence | CloudTracerEvidence,
): Promise<void> => {
  await Bun.write(`${ROOT}/acceptance/0001/evidence.json`, `${canonicalize(evidence)}\n`);
};

import {
  readEvidenceFile,
  validateEvidenceAgainstLiveProject,
  writeCanonicalEvidence,
} from "./validate.ts";

const capturePath = Bun.env["WORK_ENGINE_ACCEPTANCE_CAPTURE"];
if (capturePath === undefined || capturePath.length === 0) {
  throw new Error(
    "WORK_ENGINE_ACCEPTANCE_CAPTURE is required; it must contain the real deployed Cloudflare, Container, Herdr, and OMP journey",
  );
}

const evidence = await readEvidenceFile(capturePath, "cloud");
await validateEvidenceAgainstLiveProject(evidence);
await writeCanonicalEvidence(evidence);
await Bun.write(
  Bun.stdout,
  `${JSON.stringify({
    status: "accepted",
    mode: "cloud",
    projectId: evidence.identities.projectId,
    eventRevision: evidence.finalEventRevision,
    contentRevision: evidence.finalContentRevision,
    candidateDigest: evidence.acceptedCandidateDigest,
  })}\n`,
);

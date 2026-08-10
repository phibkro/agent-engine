import type {
  ProjectObservation,
  Sha256Digest,
} from "@work-engine/protocol";
import type { ProjectState } from "./state.ts";

/** Project observations are projections only; the caller supplies the persisted source digest. */
export const projectObservation = (
  state: ProjectState,
  sourceDigest: Sha256Digest,
): ProjectObservation => ({
  _tag: "ProjectObservation",
  projectId: state.projectId,
  eventRevision: state.eventRevision,
  contentRevision: state.contentRevision,
  policy: state.policy,
  ...(state.canonicalContent === null ? {} : { canonicalContent: state.canonicalContent }),
  history: state.history,
  activeWorkIds: Object.values(state.works)
    .filter((work) => work.lifecycle === "submitted" || work.lifecycle === "active")
    .map((work) => work.workId),
  activeSessionIds: Object.values(state.sessions)
    .filter((session) => !["completed", "failed", "interrupted"].includes(session.status))
    .map((session) => session.sessionId),
  sourceDigest,
});

export const deriveObservation = projectObservation;

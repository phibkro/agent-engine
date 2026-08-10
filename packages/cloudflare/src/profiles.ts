import {
  digestCanonical,
  type CanonicalJsonValue,
  ProfileSchema,
  type CloudTask,
  type Profile,
  type ProfileId,
  type ProfileRevision,
} from "@work-engine/protocol";
import { CloudTaskSchema, decode } from "./contract.ts";
import { InvalidRequestError, SessionConflictError } from "./errors.ts";
import { SessionState, type SessionSnapshot } from "./session.ts";

export type ProfileClassName =
  | "ProjectOrchestratorSession"
  | "ProjectWorkerSession"
  | "IndependentReviewerSession";

const profileKey = (profileId: ProfileId, revision: ProfileRevision): string =>
  `${profileId}\u0000${String(revision)}`;

export const profileCatalogKey = (profileId: ProfileId, revision: ProfileRevision): string =>
  `profiles/${profileId}/revisions/${String(revision)}`;

const verifyProfileDigest = async (profile: Profile): Promise<Profile> => {
  const { profileDigest: declaredDigest, ...content } = profile;
  const canonicalContent = { ...content } satisfies CanonicalJsonValue;
  const computedDigest = await digestCanonical(canonicalContent);
  if (declaredDigest !== computedDigest) {
    throw new InvalidRequestError(
      "Profile digest does not match the canonical registered Profile content",
    );
  }
  return profile;
};

export const resolveCatalogProfile = async (
  catalog: KVNamespace | undefined,
  task: CloudTask,
): Promise<Profile> => {
  if (catalog === undefined) throw new InvalidRequestError("Profile catalog binding is required");
  const stored = await catalog.get(profileCatalogKey(task.profileId, task.profileRevision), "json");
  if (stored === null) {
    throw new InvalidRequestError("Requested Profile revision is not registered");
  }
  const profile = await verifyProfileDigest(decode(ProfileSchema, stored));
  if (
    profile.profileId !== task.profileId ||
    profile.profileRevision !== task.profileRevision ||
    profile.profileDigest !== task.profileDigest
  ) {
    throw new InvalidRequestError("Task Profile identity does not match the catalog revision");
  }
  return profile;
};

const profileClassFor = (profile: Profile): ProfileClassName => {
  if (profile.role === "reviewer") return "IndependentReviewerSession";
  if (profile.role === "orchestrator") return "ProjectOrchestratorSession";
  return "ProjectWorkerSession";
};

export class ProfileRegistry {
  #profiles = new Map<string, Profile>();

  async register(profile: Profile): Promise<void> {
    const decoded = decode(ProfileSchema, profile);
    await verifyProfileDigest(decoded);
    const key = profileKey(decoded.profileId, decoded.profileRevision);
    const previous = this.#profiles.get(key);
    if (previous !== undefined) {
      if (previous.profileDigest !== decoded.profileDigest) {
        throw new SessionConflictError("Profile revision is immutable");
      }
      return;
    }
    this.#profiles.set(key, decoded);
  }

  resolve(profileId: ProfileId, revision: ProfileRevision, digest: string): Profile {
    const profile = this.#profiles.get(profileKey(profileId, revision));
    if (profile === undefined) {
      throw new InvalidRequestError("Requested Profile revision is not registered");
    }
    if (profile.profileDigest !== digest) {
      throw new InvalidRequestError(
        "Requested Profile digest does not match the registered revision",
      );
    }
    return profile;
  }

  all(): readonly Profile[] {
    return [...this.#profiles.values()];
  }
}

export interface ProfileSessionOptions {
  readonly existing?: SessionSnapshot;
}

export class ProfileSession {
  readonly profile: Profile;
  readonly state: SessionState;
  readonly className: ProfileClassName;

  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    this.profile = decode(ProfileSchema, profile);
    const decodedTask = decode(CloudTaskSchema, task);
    if (
      decodedTask.profileId !== this.profile.profileId ||
      decodedTask.profileRevision !== this.profile.profileRevision ||
      decodedTask.profileDigest !== this.profile.profileDigest
    ) {
      throw new SessionConflictError(
        "Task Profile identity does not match the registered Profile revision",
      );
    }
    this.state = new SessionState(decodedTask, options.existing);
    this.className = profileClassFor(this.profile);
  }
}

export class ProjectOrchestratorSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "ProjectOrchestratorSession") {
      throw new InvalidRequestError("Profile is not an orchestrator Profile");
    }
  }
}

export class ProjectWorkerSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "ProjectWorkerSession") {
      throw new InvalidRequestError("Profile is not a worker Profile");
    }
  }
}

export class IndependentReviewerSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "IndependentReviewerSession") {
      throw new InvalidRequestError("Profile is not a reviewer Profile");
    }
  }
}

export const sessionClassForProfile = (profile: Profile): ProfileClassName =>
  profileClassFor(decode(ProfileSchema, profile));

export type { RuntimeProfileRegistry as ProfileRegistryService } from "./contract.ts";

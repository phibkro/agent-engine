import {
  ProfileSchema,
  type CloudTask,
  type Profile,
  type ProfileId,
  type ProfileRevision,
} from "./contract.ts";
import { decode, record, requiredString } from "./contract.ts";
import { InvalidRequestError, SessionConflictError } from "./errors.ts";
import { SessionState, type SessionSnapshot } from "./session.ts";

export type ProfileClassName =
  | "ProjectOrchestratorSession"
  | "ProjectWorkerSession"
  | "IndependentReviewerSession";

const profileKey = (profileId: string, revision: unknown): string => `${profileId}\u0000${String(revision)}`;

const profileClassFor = (profile: Profile): ProfileClassName => {
  const role = String(record(profile)["role"] ?? "");
  if (role === "reviewer") return "IndependentReviewerSession";
  if (role === "orchestrator") return "ProjectOrchestratorSession";
  return "ProjectWorkerSession";
};

export class ProfileRegistry {
  readonly #profiles = new Map<string, Profile>();

  register(profile: Profile): void {
    const decoded = decode(ProfileSchema, profile);
    const value = record(decoded);
    const profileId = requiredString(value["profileId"], "profile.profileId");
    const revision = value["profileRevision"];
    const key = profileKey(profileId, revision);
    const previous = this.#profiles.get(key);
    if (previous !== undefined) {
      const previousDigest = requiredString(record(previous)["profileDigest"], "profile.profileDigest");
      const digest = requiredString(value["profileDigest"], "profile.profileDigest");
      if (previousDigest !== digest) throw new SessionConflictError("Profile revision is immutable");
      return;
    }
    this.#profiles.set(key, decoded);
  }

  resolve(profileId: ProfileId, revision: ProfileRevision, digest: string): Profile {
    const profile = this.#profiles.get(profileKey(profileId, revision));
    if (profile === undefined) throw new InvalidRequestError("Requested Profile revision is not registered");
    if (record(profile)["profileDigest"] !== digest) {
      throw new InvalidRequestError("Requested Profile digest does not match the registered revision");
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
    const taskValue = record(task);
    const profileValue = record(this.profile);
    if (
      taskValue["profileId"] !== profileValue["profileId"] ||
      taskValue["profileRevision"] !== profileValue["profileRevision"] ||
      taskValue["profileDigest"] !== profileValue["profileDigest"]
    ) {
      throw new SessionConflictError("Task Profile identity does not match the registered Profile revision");
    }
    this.state = new SessionState(task, options.existing);
    this.className = profileClassFor(this.profile);
  }
}

export class ProjectOrchestratorSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "ProjectOrchestratorSession") throw new InvalidRequestError("Profile is not an orchestrator Profile");
  }
}

export class ProjectWorkerSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "ProjectWorkerSession") throw new InvalidRequestError("Profile is not a worker Profile");
  }
}

export class IndependentReviewerSession extends ProfileSession {
  constructor(profile: Profile, task: CloudTask, options: ProfileSessionOptions = {}) {
    super(profile, task, options);
    if (this.className !== "IndependentReviewerSession") throw new InvalidRequestError("Profile is not a reviewer Profile");
  }
}

export const sessionClassForProfile = (profile: Profile): ProfileClassName => profileClassFor(decode(ProfileSchema, profile));

export type { RuntimeProfileRegistry as ProfileRegistryService } from "./contract.ts";

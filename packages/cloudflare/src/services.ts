import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CloudTaskClient as CloudTaskClientService,
  DependencyCache as DependencyCacheService,
  ProfileRegistry as ProfileRegistryService,
  ProjectMemory as ProjectMemoryService,
  RepositoryPublisher as RepositoryPublisherService,
  type CloudTaskClient,
  type CloudTaskError,
  type DependencyCache,
  type DependencyCacheError,
  type ProfileRegistry,
  type ProfileRegistryError,
  type ProjectMemory,
  type ProjectMemoryError,
  type RepositoryPublisher,
  type RepositoryPublisherError,
} from "@work-engine/runtime";
import {
  type CloudTask,
  type DependencyCacheManifest,
  type MemoryRevision,
  type MessageId,
  type ProfileId,
  type ProfileRevision,
  type ProjectMemoryFact,
  type ProjectMemoryProvenance,
  type RepositoryGrant,
  type SessionId,
} from "./contract.ts";
import { record, requiredString, nowIso } from "./contract.ts";
import { CacheDigestMismatchError, CloudRuntimeError } from "./errors.ts";
import { R2DependencyCache, type CacheExpectation } from "./cache.ts";
import { CloudflareCloudTaskClient } from "./cloud-task.ts";
import { CloudflareProjectMemory } from "./project-memory.ts";
import { CloudflareRepositoryPublisher } from "./repository.ts";
import { ProfileRegistry as LocalProfileRegistry } from "./profiles.ts";

const cloudTaskFailure = (cause: unknown): CloudTaskError => {
  if (cause instanceof CloudRuntimeError) {
    if (cause._tag === "Unauthorized" || cause._tag === "Unauthenticated") {
      return { _tag: "CloudTaskUnauthorized", reason: cause.message };
    }
    if (cause._tag === "SessionNotFound") {
      const sessionId = cause.details["sessionId"];
      return typeof sessionId === "string"
        ? { _tag: "CloudTaskNotFound", sessionId: sessionId as never }
        : { _tag: "CloudTaskRejected", reason: cause.message };
    }
    if (
      cause._tag === "InvalidRequest" ||
      cause._tag === "SessionConflict" ||
      cause._tag === "SessionTerminal"
    ) {
      return { _tag: "CloudTaskRejected", reason: cause.message };
    }
  }
  return {
    _tag: "CloudTaskUnavailable",
    reason: cause instanceof Error ? cause.message : "Cloud-task provider unavailable",
  };
};

const memoryFailure = (cause: unknown): ProjectMemoryError => {
  if (cause instanceof CloudRuntimeError && cause._tag === "MemoryRevisionMismatch") {
    return {
      _tag: "MemoryRevisionStale",
      expectedRevision: Number(cause.details["expected"] ?? 0),
      observedRevision: Number(cause.details["observed"] ?? 0),
    };
  }
  if (cause instanceof CloudRuntimeError && cause._tag === "MemoryRevisionUnavailable") {
    return {
      _tag: "MemoryRevisionUnavailable",
      expectedRevision: Number(cause.details["revision"] ?? 0),
    };
  }
  if (cause instanceof CloudRuntimeError && cause._tag === "MemoryProposalNotFound") {
    return {
      _tag: "MemoryProposalNotFound",
      proposalId: String(cause.details["proposalId"] ?? "unknown"),
    };
  }
  if (cause instanceof CloudRuntimeError && cause._tag === "MemoryUnauthorized") {
    return { _tag: "MemoryUnauthorized", reason: cause.message };
  }
  return {
    _tag: "MemoryUnavailable",
    reason: cause instanceof Error ? cause.message : "Project Memory unavailable",
  };
};

const repositoryFailure = (cause: unknown): RepositoryPublisherError =>
  ({
    _tag:
      cause instanceof CloudRuntimeError && cause._tag === "ProviderUnavailable"
        ? "RepositoryUnavailable"
        : "RepositoryRefConflict",
    reason: cause instanceof Error ? cause.message : "Repository provider unavailable",
  }) as RepositoryPublisherError;

const cacheFailure = (cause: unknown): DependencyCacheError => {
  if (cause instanceof CacheDigestMismatchError) {
    const expected = String(cause.details["expected"] ?? "sha256:" + "0".repeat(64)).replace(
      /^payloadDigest:/u,
      "",
    );
    const observed = String(cause.details["observed"] ?? "sha256:" + "0".repeat(64)).replace(
      /^payloadDigest:/u,
      "",
    );
    return {
      _tag: "DependencyCachePayloadMismatch",
      expected: expected as never,
      observed: observed as never,
    };
  }
  return {
    _tag: "DependencyCacheUnavailable",
    reason: cause instanceof Error ? cause.message : "Dependency cache unavailable",
  };
};

const profileFailure = (
  profileId: ProfileId,
  profileRevision: ProfileRevision,
): ProfileRegistryError => ({
  _tag: "ProfileNotFound",
  profileId,
  profileRevision,
});

const cloudTaskLayerService = (adapter: CloudflareCloudTaskClient): CloudTaskClient => ({
  spawn: (sessionId: SessionId, task: CloudTask) =>
    Effect.tryPromise({
      try: async () => {
        if (record(task)["sessionId"] !== sessionId)
          throw new Error("sessionId does not match CloudTask");
        const response = record(await adapter.spawn(sessionId, task));
        return response["admission"] as never;
      },
      catch: cloudTaskFailure,
    }),
  send: (sessionId: SessionId, messageId: MessageId, message: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = record(await adapter.send(sessionId, messageId, message));
        return response["acceptedCursor"] as never;
      },
      catch: cloudTaskFailure,
    }),
  observe: (sessionId: SessionId, afterCursor: number) =>
    Effect.tryPromise({
      try: async () => {
        const response = record(await adapter.observe(sessionId, afterCursor));
        return response["observations"] as never;
      },
      catch: cloudTaskFailure,
    }),
  cancel: (sessionId: SessionId, reason: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = record(await adapter.cancel(sessionId, reason));
        return response["observation"] as never;
      },
      catch: cloudTaskFailure,
    }),
  result: (sessionId: SessionId) =>
    Effect.tryPromise({
      try: async () => {
        const response = record(await adapter.result(sessionId));
        return response["result"] as never;
      },
      catch: cloudTaskFailure,
    }),
});

export const CloudTaskClientLive = (
  binding: Fetcher | undefined,
  token: string | undefined,
): Layer.Layer<CloudTaskClient> =>
  Layer.succeed(
    CloudTaskClientService,
    cloudTaskLayerService(new CloudflareCloudTaskClient(binding, token)),
  );

export const ProjectMemoryLive = (
  namespace: DurableObjectNamespace | undefined,
  projectId: string,
  options: { readonly sessionId?: string; readonly coordinatorSecret?: string } = {},
): Layer.Layer<ProjectMemory> => {
  const adapter = new CloudflareProjectMemory(namespace, projectId, options);
  const service: ProjectMemory = {
    readContext: (atRevision: MemoryRevision, query: string) =>
      Effect.tryPromise({
        try: async () => {
          const body = record(await adapter.readContext(atRevision, query));
          return (
            Array.isArray(body["facts"]) ? body["facts"] : []
          ) as ReadonlyArray<ProjectMemoryFact>;
        },
        catch: memoryFailure,
      }),
    proposeMemory: (
      expectedRevision: MemoryRevision,
      claim: string,
      provenance: ProjectMemoryProvenance,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const body = record(await adapter.proposeMemory(expectedRevision, claim, provenance));
          return requiredString(body["proposalId"], "proposalId") as never;
        },
        catch: memoryFailure,
      }),
    acceptMemory: (proposalId, expectedRevision) =>
      Effect.tryPromise({
        try: async () => {
          const body = record(await adapter.acceptMemory(proposalId, expectedRevision));
          return Number(body["memoryRevision"]) as never;
        },
        catch: memoryFailure,
      }),
  };
  return Layer.succeed(ProjectMemoryService, service);
};

export const RepositoryPublisherLive = (
  binding: Fetcher | undefined,
): Layer.Layer<RepositoryPublisher> => {
  const adapter = new CloudflareRepositoryPublisher(binding);
  const service: RepositoryPublisher = {
    checkout: (grant: RepositoryGrant, commit: CloudTask["baseCommit"]) =>
      Effect.tryPromise({
        try: () =>
          adapter.checkout(
            grant,
            requiredString(record(grant)["sessionId"], "grant.sessionId"),
            commit,
          ),
        catch: repositoryFailure,
      }),
    checkpoint: (grant, commit, expectedRemoteCommit) =>
      Effect.tryPromise({
        try: () =>
          adapter.checkpoint(
            grant,
            requiredString(record(grant)["sessionId"], "grant.sessionId"),
            commit,
            expectedRemoteCommit,
          ),
        catch: repositoryFailure,
      }),
    publishCandidate: (grant, commit) =>
      Effect.tryPromise({
        try: () =>
          adapter.publishCandidate(
            grant,
            requiredString(record(grant)["sessionId"], "grant.sessionId"),
            commit,
          ),
        catch: repositoryFailure,
      }),
  };
  return Layer.succeed(RepositoryPublisherService, service);
};

export const DependencyCacheLive = (bucket: R2Bucket | undefined): Layer.Layer<DependencyCache> => {
  const adapter = new R2DependencyCache(bucket);
  const service: DependencyCache = {
    restore: (manifest: DependencyCacheManifest) =>
      Effect.tryPromise({
        try: async () => {
          const values = record(manifest);
          const expectation: CacheExpectation = {
            runtimeDigest: requiredString(values["runtimeDigest"], "manifest.runtimeDigest"),
            platformDigest: requiredString(values["platformDigest"], "manifest.platformDigest"),
            imageDigest: requiredString(values["imageDigest"], "manifest.imageDigest"),
            repositoryDigest: requiredString(
              values["repositoryDigest"],
              "manifest.repositoryDigest",
            ),
            lockfileDigest: requiredString(values["lockfileDigest"], "manifest.lockfileDigest"),
          };
          const restored = await adapter.restore(manifest, expectation);
          if (restored.kind === "miss") throw new Error(restored.reason);
          return {
            _tag: "DependencyCacheRestore",
            manifest: restored.manifest,
            restored: true,
            payloadDigest: restored.payloadDigest,
            verifiedAt: nowIso(),
            workspacePath: "/workspace/dependencies",
          } as never;
        },
        catch: cacheFailure,
      }),
  };
  return Layer.succeed(DependencyCacheService, service);
};

export const ProfileRegistryLive = (
  registry = new LocalProfileRegistry(),
): Layer.Layer<ProfileRegistry> => {
  const service: ProfileRegistry = {
    resolve: (profileId, profileRevision, profileDigest) =>
      Effect.try({
        try: () => registry.resolve(profileId, profileRevision, profileDigest),
        catch: () => profileFailure(profileId, profileRevision),
      }),
  };
  return Layer.succeed(ProfileRegistryService, service);
};

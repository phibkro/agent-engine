import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AcceptedCursorSchema,
  CandidateReceiptSchema,
  CheckpointReceiptSchema,
  CloudTaskResponseSchema,
  CloudTaskSchema,
  CommitShaSchema,
  DependencyCacheManifestSchema,
  DependencyCacheRestoreSchema,
  MemoryProposalIdSchema,
  MemoryRevisionSchema,
  MessageIdSchema,
  ProfileIdSchema,
  ProfileRevisionSchema,
  ProfileSchema,
  ProjectIdSchema,
  ProjectMemoryAcceptRequestSchema,
  ProjectMemoryProposeRequestSchema,
  ProjectMemoryFactSchema,
  ProjectMemoryProposalSchema,
  ProjectMemoryReadRequestSchema,
  ProjectMemoryReadResponseSchema,
  ProjectMemoryRevisionSchema,
  RepositoryGrantSchema,
  SessionAdmissionSchema,
  SessionIdSchema,
  SessionObservationSchema,
  SessionResultSchema,
  Sha256DigestSchema,
  TerminalSessionStateSchema,
  TimestampSchema,
  VerifiedWorkspaceSchema,
  type CloudTask,
  type DependencyCacheManifest,
  type MemoryProposalId,
  type MemoryRevision,
  type MessageId,
  type ProjectMemoryProvenance,
  type RepositoryGrant,
  type SessionId,
} from "@work-engine/protocol";
import { decode, type PlatformCapabilities } from "./contract.ts";
import {
  CloudTaskClient as CloudTaskClientService,
  ProjectMemory as ProjectMemoryService,
  RepositoryPublisher as RepositoryPublisherService,
  DependencyCache as DependencyCacheService,
  ProfileRegistry as ProfileRegistryService,
  CloudTaskNotFound,
  CloudTaskRejected,
  CloudTaskTerminal,
  CloudTaskUnavailable,
  CloudTaskUnauthorized,
  DependencyCacheKeyMismatch,
  DependencyCacheMissing,
  DependencyCachePayloadMismatch,
  DependencyCacheUnavailable,
  ProfileNotFound,
  ProfileDigestMismatch,
  ProfileRegistryUnavailable,
  MemoryProposalNotFound,
  MemoryRevisionStale,
  MemoryRevisionUnavailable,
  MemoryUnauthorized,
  MemoryUnavailable,
  RepositoryCommitInvalid,
  RepositoryGrantExpired,
  RepositoryGrantInvalid,
  RepositoryRefConflict,
  RepositoryScopeViolation,
  RepositoryUnavailable,
  type CloudTaskClient,
  type CloudTaskError,
  type DependencyCache,
  type DependencyCacheError,
  type DependencyCacheExpectation,
  type ProfileRegistry,
  type ProfileRegistryError,
  type ProjectMemory,
  type ProjectMemoryError,
  type RepositoryPublisher,
  type RepositoryPublisherError,
} from "@work-engine/runtime";
import { type CacheExpectation, R2DependencyCache } from "./cache.ts";
import {
  CacheDigestMismatchError,
  CacheMissError,
  CloudRuntimeError,
  InvalidRequestError,
  ProviderUnavailableError,
} from "./errors.ts";
import { CloudflareCloudTaskClient } from "./cloud-task.ts";
import { CloudflareProjectMemory } from "./project-memory.ts";
import { CloudflareRepositoryPublisher } from "./repository.ts";
import type { ProfileRegistry as LocalProfileRegistry } from "./profiles.ts";

const SessionNotFoundDetailsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
});

const SessionTerminalDetailsSchema = Schema.Struct({
  sessionId: SessionIdSchema,
  state: TerminalSessionStateSchema,
});

const MemoryRevisionUnavailableDetailsSchema = Schema.Struct({
  projectId: ProjectIdSchema,
  revision: MemoryRevisionSchema,
});

const MemoryRevisionMismatchDetailsSchema = Schema.Struct({
  expected: MemoryRevisionSchema,
  observed: MemoryRevisionSchema,
});

const ProfileRevisionNotFoundDetailsSchema = Schema.Struct({
  profileId: ProfileIdSchema,
  profileRevision: ProfileRevisionSchema,
});

const ProfileDigestMismatchDetailsSchema = Schema.Struct({
  expected: Sha256DigestSchema,
  observed: Sha256DigestSchema,
});
const MemoryProposalNotFoundDetailsSchema = Schema.Struct({
  proposalId: MemoryProposalIdSchema,
});

const RepositoryScopeViolationDetailsSchema = Schema.Struct({
  paths: Schema.NonEmptyArray(Schema.NonEmptyString),
});

const CacheDigestMismatchDetailsSchema = Schema.Struct({
  expected: Schema.NonEmptyString,
  observed: Schema.NonEmptyString,
});

const CacheMissDetailsSchema = Schema.Struct({
  cacheKey: Schema.NonEmptyString,
});

const cacheDigestPrefixes: ReadonlyArray<string> = [
  "runtimeDigest",
  "platformDigest",
  "imageDigest",
  "repositoryDigest",
  "lockfileDigest",
  "payloadDigest",
];

const decodeOrUndefined = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] | undefined => {
  try {
    return decode(schema, input);
  } catch {
    return undefined;
  }
};

const reasonOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const cloudTaskUnavailable = (reason: string): CloudTaskUnavailable =>
  new CloudTaskUnavailable({ reason });

const cloudTaskFailure = (cause: unknown): CloudTaskError => {
  if (!(cause instanceof CloudRuntimeError)) {
    return cloudTaskUnavailable("Cloud-task provider unavailable");
  }
  switch (cause._tag) {
    case "Unauthenticated":
    case "Unauthorized":
      return new CloudTaskUnauthorized({
        reason: reasonOf(cause, "Cloud-task authorization failed"),
      });
    case "SessionNotFound": {
      const details = decodeOrUndefined(SessionNotFoundDetailsSchema, cause.details);
      return details === undefined
        ? cloudTaskUnavailable("Cloud-task provider returned malformed session details")
        : new CloudTaskNotFound(details);
    }
    case "InvalidRequest":
    case "SessionConflict":
    case "SessionTerminal":
      if (cause._tag === "SessionTerminal") {
        const details = decodeOrUndefined(SessionTerminalDetailsSchema, cause.details);
        if (details !== undefined) return new CloudTaskTerminal(details);
      }
      return new CloudTaskRejected({
        reason: reasonOf(cause, "Cloud-task request was rejected"),
      });
    case "ProviderUnavailable":
      return cloudTaskUnavailable(reasonOf(cause, "Cloud-task provider unavailable"));
    default:
      return cloudTaskUnavailable("Cloud-task provider unavailable");
  }
};

const unexpectedCloudTaskResponse = (operation: string): ProviderUnavailableError =>
  new ProviderUnavailableError(
    "Cloud-task service binding",
    `Cloud-task adapter returned an unexpected ${operation} response`,
  );

const cloudTaskLayerService = (adapter: CloudflareCloudTaskClient): CloudTaskClient => ({
  spawn: (sessionId: SessionId, task: CloudTask) =>
    Effect.tryPromise({
      try: async () => {
        const decodedSessionId = decode(SessionIdSchema, sessionId);
        const decodedTask = decode(CloudTaskSchema, task);
        if (decodedTask.sessionId !== decodedSessionId) {
          throw new InvalidRequestError("sessionId does not match CloudTask");
        }
        const response = decode(
          CloudTaskResponseSchema,
          await adapter.spawn(decodedSessionId, decodedTask),
        );
        if (response._tag !== "Spawned") throw unexpectedCloudTaskResponse("spawn");
        return decode(SessionAdmissionSchema, response.admission);
      },
      catch: cloudTaskFailure,
    }),
  send: (sessionId: SessionId, messageId: MessageId, message) =>
    Effect.tryPromise({
      try: async () => {
        const response = decode(
          CloudTaskResponseSchema,
          await adapter.send(
            decode(SessionIdSchema, sessionId),
            decode(MessageIdSchema, messageId),
            message,
          ),
        );
        if (response._tag !== "Accepted") throw unexpectedCloudTaskResponse("send");
        return decode(AcceptedCursorSchema, response.acceptedCursor);
      },
      catch: cloudTaskFailure,
    }),
  observe: (sessionId: SessionId, afterCursor: number) =>
    Effect.tryPromise({
      try: async () => {
        const response = decode(
          CloudTaskResponseSchema,
          await adapter.observe(
            decode(SessionIdSchema, sessionId),
            decode(Schema.Natural, afterCursor),
          ),
        );
        if (response._tag !== "Observed") throw unexpectedCloudTaskResponse("observe");
        return response.observations.map((observation) =>
          decode(SessionObservationSchema, observation),
        );
      },
      catch: cloudTaskFailure,
    }),
  cancel: (sessionId: SessionId, reason: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = decode(
          CloudTaskResponseSchema,
          await adapter.cancel(
            decode(SessionIdSchema, sessionId),
            decode(Schema.NonEmptyString, reason),
          ),
        );
        if (response._tag !== "Cancelled") throw unexpectedCloudTaskResponse("cancel");
        return decode(SessionObservationSchema, response.observation);
      },
      catch: cloudTaskFailure,
    }),
  result: (sessionId: SessionId) =>
    Effect.tryPromise({
      try: async () => {
        const response = decode(
          CloudTaskResponseSchema,
          await adapter.result(decode(SessionIdSchema, sessionId)),
        );
        if (response._tag !== "Result") throw unexpectedCloudTaskResponse("result");
        return decode(SessionResultSchema, response.result);
      },
      catch: cloudTaskFailure,
    }),
});

const memoryFailure = (cause: unknown): ProjectMemoryError => {
  if (cause instanceof CloudRuntimeError) {
    switch (cause._tag) {
      case "MemoryRevisionMismatch": {
        const details = decodeOrUndefined(MemoryRevisionMismatchDetailsSchema, cause.details);
        return details === undefined
          ? new MemoryUnavailable({ reason: "Project Memory returned malformed revision details" })
          : new MemoryRevisionStale({
              expectedRevision: details.expected,
              observedRevision: details.observed,
            });
      }
      case "MemoryRevisionUnavailable": {
        const details = decodeOrUndefined(MemoryRevisionUnavailableDetailsSchema, cause.details);
        return details === undefined
          ? new MemoryUnavailable({ reason: "Project Memory returned malformed revision details" })
          : new MemoryRevisionUnavailable({ expectedRevision: details.revision });
      }
      case "MemoryProposalNotFound": {
        const details = decodeOrUndefined(MemoryProposalNotFoundDetailsSchema, cause.details);
        return details === undefined
          ? new MemoryUnavailable({ reason: "Project Memory returned malformed proposal details" })
          : new MemoryProposalNotFound(details);
      }
      case "MemoryUnauthorized":
        return new MemoryUnauthorized({
          reason: reasonOf(cause, "Project Memory authorization failed"),
        });
      case "ProviderUnavailable":
        return new MemoryUnavailable({ reason: reasonOf(cause, "Project Memory unavailable") });
      default:
        return new MemoryUnavailable({ reason: "Project Memory unavailable" });
    }
  }
  return new MemoryUnavailable({
    reason: reasonOf(cause, "Project Memory unavailable"),
  });
};

const projectMemoryLayer = (adapter: CloudflareProjectMemory): ProjectMemory => ({
  readContext: (atRevision: MemoryRevision, query: string) =>
    Effect.tryPromise({
      try: async () => {
        const request = decode(ProjectMemoryReadRequestSchema, { atRevision, query });
        const response = decode(
          ProjectMemoryReadResponseSchema,
          await adapter.readContext(request.atRevision, request.query),
        );
        return response.facts.map((fact) => decode(ProjectMemoryFactSchema, fact));
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
        const request = decode(ProjectMemoryProposeRequestSchema, {
          expectedRevision,
          claim,
          provenance,
        });
        const response = decode(
          ProjectMemoryProposalSchema,
          await adapter.proposeMemory(request.expectedRevision, request.claim, request.provenance),
        );
        return response.proposalId;
      },
      catch: memoryFailure,
    }),
  acceptMemory: (proposalId: MemoryProposalId, expectedRevision: MemoryRevision) =>
    Effect.tryPromise({
      try: async () => {
        const request = decode(ProjectMemoryAcceptRequestSchema, {
          proposalId,
          expectedRevision,
        });
        const response = decode(
          ProjectMemoryRevisionSchema,
          await adapter.acceptMemory(request.proposalId, request.expectedRevision),
        );
        return response.memoryRevision;
      },
      catch: memoryFailure,
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
): Layer.Layer<ProjectMemory, ProjectMemoryError> =>
  Layer.effect(
    ProjectMemoryService,
    Effect.try({
      try: () => projectMemoryLayer(new CloudflareProjectMemory(namespace, projectId, options)),
      catch: memoryFailure,
    }),
  );

const repositoryFailure = (
  grant: RepositoryGrant | undefined,
  cause: unknown,
  now: string,
): RepositoryPublisherError => {
  if (!(cause instanceof CloudRuntimeError)) {
    return new RepositoryUnavailable({
      reason: reasonOf(cause, "Repository provider unavailable"),
    });
  }
  switch (cause._tag) {
    case "RepositoryGrantInvalid":
      if (grant !== undefined && grant.expiresAt <= now) {
        return new RepositoryGrantExpired({ grantId: grant.grantId });
      }
      return grant === undefined
        ? new RepositoryUnavailable({ reason: "Repository provider unavailable" })
        : new RepositoryGrantInvalid({
            grantId: grant.grantId,
            reason: reasonOf(cause, "Repository grant is invalid"),
          });
    case "RepositoryAncestryViolation":
      return new RepositoryCommitInvalid({
        reason: reasonOf(cause, "Repository commit is invalid"),
      });
    case "RepositoryScopeViolation": {
      const details = decodeOrUndefined(RepositoryScopeViolationDetailsSchema, cause.details);
      return details === undefined
        ? new RepositoryUnavailable({
            reason: "Repository provider returned malformed scope details",
          })
        : new RepositoryScopeViolation({ path: details.paths[0] });
    }
    case "RepositoryConflict":
      return new RepositoryRefConflict({
        reason: reasonOf(cause, "Repository ref conflict"),
      });
    case "ProviderUnavailable":
      return new RepositoryUnavailable({
        reason: reasonOf(cause, "Repository provider unavailable"),
      });
    default:
      return new RepositoryUnavailable({ reason: "Repository provider unavailable" });
  }
};

export const RepositoryPublisherLive = (
  binding: Fetcher | undefined,
  capabilities: Pick<PlatformCapabilities, "now">,
): Layer.Layer<RepositoryPublisher> => {
  const adapter = new CloudflareRepositoryPublisher(binding, { now: capabilities.now });
  const service: RepositoryPublisher = {
    checkout: (grant: RepositoryGrant, commit: CloudTask["baseCommit"]) =>
      Effect.tryPromise({
        try: async () => {
          const decodedGrant = decode(RepositoryGrantSchema, grant);
          const decodedCommit = decode(CommitShaSchema, commit);
          return decode(
            VerifiedWorkspaceSchema,
            await adapter.checkout(decodedGrant, decodedGrant.sessionId, decodedCommit),
          );
        },
        catch: (cause) =>
          repositoryFailure(
            decodeOrUndefined(RepositoryGrantSchema, grant),
            cause,
            capabilities.now(),
          ),
      }),
    checkpoint: (
      grant: RepositoryGrant,
      commit: CloudTask["baseCommit"],
      expectedRemoteCommit: CloudTask["baseCommit"],
    ) =>
      Effect.tryPromise({
        try: async () => {
          const decodedGrant = decode(RepositoryGrantSchema, grant);
          const decodedCommit = decode(CommitShaSchema, commit);
          const decodedExpectedRemoteCommit = decode(CommitShaSchema, expectedRemoteCommit);
          return decode(
            CheckpointReceiptSchema,
            await adapter.checkpoint(
              decodedGrant,
              decodedGrant.sessionId,
              decodedCommit,
              decodedExpectedRemoteCommit,
            ),
          );
        },
        catch: (cause) =>
          repositoryFailure(
            decodeOrUndefined(RepositoryGrantSchema, grant),
            cause,
            capabilities.now(),
          ),
      }),
    publishCandidate: (grant: RepositoryGrant, commit: CloudTask["baseCommit"]) =>
      Effect.tryPromise({
        try: async () => {
          const decodedGrant = decode(RepositoryGrantSchema, grant);
          const decodedCommit = decode(CommitShaSchema, commit);
          return decode(
            CandidateReceiptSchema,
            await adapter.publishCandidate(decodedGrant, decodedGrant.sessionId, decodedCommit),
          );
        },
        catch: (cause) =>
          repositoryFailure(
            decodeOrUndefined(RepositoryGrantSchema, grant),
            cause,
            capabilities.now(),
          ),
      }),
  };
  return Layer.succeed(RepositoryPublisherService, service);
};

const cacheDigestValue = (
  value: string,
): { readonly kind: "key" | "payload"; readonly digest: string } | undefined => {
  if (value.startsWith("sha256:")) return { kind: "payload", digest: value };
  for (const prefix of cacheDigestPrefixes) {
    const marker = `${prefix}:`;
    if (value.startsWith(marker)) {
      return {
        kind: prefix === "payloadDigest" ? "payload" : "key",
        digest: value.slice(marker.length),
      };
    }
  }
  return undefined;
};

const cacheFailure = (cause: unknown): DependencyCacheError => {
  if (cause instanceof CacheDigestMismatchError) {
    const details = decodeOrUndefined(CacheDigestMismatchDetailsSchema, cause.details);
    if (details === undefined) {
      return new DependencyCacheUnavailable({
        reason: "Dependency cache returned malformed digest details",
      });
    }
    const expected = cacheDigestValue(details.expected);
    const observed = cacheDigestValue(details.observed);
    if (expected === undefined || observed === undefined || expected.kind !== observed.kind) {
      return new DependencyCacheUnavailable({
        reason: "Dependency cache returned malformed digest details",
      });
    }
    const expectedDigest = decodeOrUndefined(Sha256DigestSchema, expected.digest);
    const observedDigest = decodeOrUndefined(Sha256DigestSchema, observed.digest);
    if (expectedDigest === undefined || observedDigest === undefined) {
      return new DependencyCacheUnavailable({
        reason: "Dependency cache returned malformed digest details",
      });
    }
    return expected.kind === "payload"
      ? new DependencyCachePayloadMismatch({
          expected: expectedDigest,
          observed: observedDigest,
        })
      : new DependencyCacheKeyMismatch({
          expected: expectedDigest,
          observed: observedDigest,
        });
  }
  if (cause instanceof CacheMissError) {
    const details = decodeOrUndefined(CacheMissDetailsSchema, cause.details);
    return details === undefined
      ? new DependencyCacheUnavailable({
          reason: "Dependency cache returned malformed miss details",
        })
      : new DependencyCacheMissing({ cacheKey: details.cacheKey });
  }
  return new DependencyCacheUnavailable({
    reason: reasonOf(cause, "Dependency cache unavailable"),
  });
};

const cacheExpectation = (expectation: DependencyCacheExpectation): CacheExpectation => ({
  runtimeDigest: decode(Sha256DigestSchema, expectation.runtimeDigest),
  platformDigest: decode(Sha256DigestSchema, expectation.platformDigest),
  imageDigest: decode(Sha256DigestSchema, expectation.imageDigest),
  repositoryDigest: decode(Sha256DigestSchema, expectation.repositoryDigest),
  lockfileDigest: decode(Sha256DigestSchema, expectation.lockfileDigest),
});

export const DependencyCacheLive = (
  bucket: R2Bucket | undefined,
  capabilities: Pick<PlatformCapabilities, "now" | "sha256">,
): Layer.Layer<DependencyCache> => {
  const adapter = new R2DependencyCache(bucket, capabilities);
  const service: DependencyCache = {
    restore: (manifest: DependencyCacheManifest, expectation) =>
      Effect.tryPromise({
        try: async () => {
          const decodedManifest = decode(DependencyCacheManifestSchema, manifest);
          const restored = await adapter.restore(decodedManifest, cacheExpectation(expectation));
          if (restored.kind === "miss") {
            throw new CacheMissError(decodedManifest.cacheKey, restored.reason);
          }
          const verifiedAt = decode(TimestampSchema, capabilities.now());
          return decode(DependencyCacheRestoreSchema, {
            _tag: "DependencyCacheRestore",
            manifest: restored.manifest,
            restored: true,
            payloadDigest: restored.payloadDigest,
            verifiedAt,
            workspacePath: "/workspace/dependencies",
          });
        },
        catch: cacheFailure,
      }),
  };
  return Layer.succeed(DependencyCacheService, service);
};

const profileFailure = (cause: unknown): ProfileRegistryError => {
  if (!(cause instanceof CloudRuntimeError)) {
    return new ProfileRegistryUnavailable({
      reason: reasonOf(cause, "Profile registry unavailable"),
    });
  }
  switch (cause._tag) {
    case "ProfileRevisionNotFound": {
      const details = decodeOrUndefined(ProfileRevisionNotFoundDetailsSchema, cause.details);
      return details === undefined
        ? new ProfileRegistryUnavailable({
            reason: "Profile registry returned malformed revision details",
          })
        : new ProfileNotFound(details);
    }
    case "ProfileDigestMismatch":
    case "ProfileContentDigestMismatch": {
      const details = decodeOrUndefined(ProfileDigestMismatchDetailsSchema, cause.details);
      return details === undefined
        ? new ProfileRegistryUnavailable({
            reason: "Profile registry returned malformed digest details",
          })
        : new ProfileDigestMismatch(details);
    }
    case "ProviderUnavailable":
      return new ProfileRegistryUnavailable({
        reason: reasonOf(cause, "Profile registry unavailable"),
      });
    default:
      return new ProfileRegistryUnavailable({
        reason: "Profile registry unavailable",
      });
  }
};

export const ProfileRegistryLive = (
  registry: LocalProfileRegistry,
): Layer.Layer<ProfileRegistry> => {
  const service: ProfileRegistry = {
    resolve: (profileId, profileRevision, profileDigest) =>
      Effect.try({
        try: () =>
          decode(
            ProfileSchema,
            registry.resolve(
              decode(ProfileIdSchema, profileId),
              decode(ProfileRevisionSchema, profileRevision),
              decode(Sha256DigestSchema, profileDigest),
            ),
          ),
        catch: (cause) => profileFailure(cause),
      }),
  };
  return Layer.succeed(ProfileRegistryService, service);
};

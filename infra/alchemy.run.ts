import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Cloudflare from "alchemy/Cloudflare";

/** Explicit deployment inputs. Alchemy treats Config values as secret/config boundaries. */
export const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");
export const publicDomain = Config.string("WORK_ENGINE_DOMAIN");
export const containerSshPublicKeyId = Config.string("PROJECT_CONTAINER_SSH_PUBLIC_KEY_ID");
export const accessClientId = Config.string("CF_ACCESS_CLIENT_ID");
export const accessClientSecret = Config.redacted("CF_ACCESS_CLIENT_SECRET");

/** One effectful resource graph consumed by the Alchemy runner. */
export const graph = Effect.gen(function* () {
  const projectIndex = yield* Cloudflare.D1.Database("ProjectIndex", {
    name: "work-engine-project-index",
    migrationsDir: "./packages/cloudflare/migrations",
  });

  const artifactBucket = yield* Cloudflare.R2.Bucket("Artifacts", {
    name: "work-engine-artifacts",
  });

  const primaryEffects = yield* Cloudflare.Queues.Queue("PrimaryEffects", {
    name: "work-engine-effects",
  });

  const deadLetterEffects = yield* Cloudflare.Queues.Queue("DeadLetterEffects", {
    name: "work-engine-effects-dead-letter",
  });

  const projectNamespace = Cloudflare.DurableObject("Project");
  const sessionWorkflow = Cloudflare.Workflows.Workflow("SessionEffectWorkflow", {
    className: "SessionEffectWorkflow",
  });
  const projectContainer = Cloudflare.Containers.Container("ProjectContainer", {
    context: "./infra/project-container",
    dockerfile: "Dockerfile",
    className: "ProjectContainer",
    instances: 0,
    maxInstances: 20,
    sshPublicKeyIds: [containerSshPublicKeyId],
  });

  const serviceToken = yield* Cloudflare.Access.ServiceToken("ControlPlaneServiceToken", {
    name: "work-engine-control-plane",
    duration: "8760h",
  });
  const serviceTokenPolicy = yield* Cloudflare.Access.Policy("ControlPlaneServiceTokenPolicy", {
    name: "work-engine-control-plane-service-token",
    decision: "non_identity",
    include: [{ serviceToken: { tokenId: serviceToken.serviceTokenId } }],
  });
  const accessApplication = yield* Cloudflare.Access.Application("ControlPlaneAccess", {
    type: "self_hosted",
    name: "work-engine-control-plane",
    domain: publicDomain,
    policies: [serviceTokenPolicy.policyId],
  });

  const controlPlaneWorker = yield* Cloudflare.Worker("ControlPlane", {
    main: "./apps/control-plane/src/index.ts",
    compatibility: {
      date: "2026-08-10",
      flags: ["containers_pid_namespace"],
    },
    crons: ["* * * * *"],
    routes: [{ pattern: publicDomain }],
    env: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ACCESS_CLIENT_ID: accessClientId,
      ACCESS_CLIENT_SECRET: accessClientSecret,
      PROJECTS: projectNamespace,
      PROJECT_INDEX: projectIndex,
      ARTIFACTS: artifactBucket,
      PRIMARY_EFFECTS: primaryEffects,
      DEAD_LETTER_EFFECTS: deadLetterEffects,
      SESSION_WORKFLOW: sessionWorkflow,
      PROJECT_CONTAINER: projectContainer,
      WORK_ENGINE_DOMAIN: publicDomain,
    },
  });

  const effectsConsumer = yield* Cloudflare.Queues.Consumer("PrimaryEffectsConsumer", {
    queueId: primaryEffects.queueId,
    scriptName: controlPlaneWorker.workerName,
    deadLetterQueue: deadLetterEffects.queueName,
    settings: {
      batchSize: 10,
      maxConcurrency: 10,
      maxRetries: 5,
      maxWaitTimeMs: 5000,
      retryDelay: 60,
    },
  });
  const deadLetterConsumer = yield* Cloudflare.Queues.Consumer("DeadLetterEffectsConsumer", {
    queueId: deadLetterEffects.queueId,
    scriptName: controlPlaneWorker.workerName,
    settings: {
      batchSize: 10,
      maxConcurrency: 2,
      maxRetries: 0,
      maxWaitTimeMs: 5000,
    },
  });

  return {
    accountId,
    accessApplication,
    accessClientId,
    accessClientSecret,
    artifactBucket,
    controlPlaneWorker,
    containerSshPublicKeyId,
    deadLetterConsumer,
    deadLetterEffects,
    effectsConsumer,
    primaryEffects,
    projectContainer,
    projectIndex,
    projectNamespace,
    publicDomain,
    serviceToken,
    serviceTokenPolicy,
    sessionWorkflow,
  } as const;
});

export default graph;

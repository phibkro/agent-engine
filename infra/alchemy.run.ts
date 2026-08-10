import * as Config from "effect/Config";
import * as Cloudflare from "alchemy/Cloudflare";

/** Explicit deployment inputs. Alchemy treats Config values as secret/config boundaries. */
export const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");
export const publicDomain = Config.string("WORK_ENGINE_DOMAIN");
export const containerSshPublicKeyId = Config.string("PROJECT_CONTAINER_SSH_PUBLIC_KEY_ID");
export const accessClientId = Config.string("CF_ACCESS_CLIENT_ID");
export const accessClientSecret = Config.redacted("CF_ACCESS_CLIENT_SECRET");

export const projectIndex = Cloudflare.D1.Database("ProjectIndex", {
  name: "work-engine-project-index",
  migrationsDir: "./packages/cloudflare/migrations",
});

export const artifactBucket = Cloudflare.R2.Bucket("Artifacts", {
  name: "work-engine-artifacts",
});

export const primaryEffects = Cloudflare.Queues.Queue("PrimaryEffects", {
  name: "work-engine-effects",
});

export const deadLetterEffects = Cloudflare.Queues.Queue("DeadLetterEffects", {
  name: "work-engine-effects-dead-letter",
});

export const projectNamespace = Cloudflare.DurableObject("Project");

export const sessionWorkflow = Cloudflare.Workflows.Workflow("SessionEffectWorkflow", {
  className: "SessionEffectWorkflow",
});

export const projectContainer = Cloudflare.Containers.Container("ProjectContainer", {
  context: "./infra/project-container",
  dockerfile: "Dockerfile",
  className: "ProjectContainer",
  instances: 0,
  maxInstances: 20,
  sshPublicKeyIds: [containerSshPublicKeyId],
});

export const serviceToken = Cloudflare.Access.ServiceToken("ControlPlaneServiceToken", {
  name: "work-engine-control-plane",
  duration: "8760h",
});

export const serviceTokenPolicy = Cloudflare.Access.Policy("ControlPlaneServiceTokenPolicy", {
  name: "work-engine-control-plane-service-token",
  decision: "non_identity",
  include: [{ serviceToken: { tokenId: serviceToken.serviceTokenId } }],
});

export const accessApplication = Cloudflare.Access.Application("ControlPlaneAccess", {
  type: "self_hosted",
  name: "work-engine-control-plane",
  domain: publicDomain,
  policies: [serviceTokenPolicy.policyId],
});

export const controlPlaneWorker = Cloudflare.Worker("ControlPlane", {
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

export const effectsConsumer = Cloudflare.Queues.Consumer("PrimaryEffectsConsumer", {
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

export const deadLetterConsumer = Cloudflare.Queues.Consumer("DeadLetterEffectsConsumer", {
  queueId: deadLetterEffects.queueId,
  scriptName: controlPlaneWorker.workerName,
  settings: {
    batchSize: 10,
    maxConcurrency: 2,
    maxRetries: 0,
    maxWaitTimeMs: 5000,
  },
});

/** One graph export consumed by the Alchemy runner; no deploy is performed here. */
export const graph = {
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

export default graph;

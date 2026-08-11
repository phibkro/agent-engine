import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { decodeUnknownStrict, Sha256DigestSchema, type Sha256Digest } from "@work-engine/protocol";
import { CloudTaskRouter, EnvironmentRouter } from "@work-engine/cloudflare";
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { ControlPlaneEnv } from "./env.ts";

const BackupBucketNameSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u)),
);

export interface ControlPlaneConfiguration {
  readonly cloudTaskAuthToken: Redacted.Redacted<string>;
  readonly cloudTaskRouterSecret: Redacted.Redacted<string>;
  readonly credentialBrokerSecret: Redacted.Redacted<string>;
  readonly credentialBrokerUrl: URL;
  readonly environmentRouterSecret: Redacted.Redacted<string>;
  readonly environmentPublicOrigin: URL;
  readonly environmentImageDigest: Sha256Digest;
  readonly t3codeVersion: string;
  readonly sandboxSdkVersion: string;
  readonly backupBucketName: string;
  readonly r2AccessKeyId: Redacted.Redacted<string>;
  readonly r2SecretAccessKey: Redacted.Redacted<string>;
}

export const ControlPlaneConfiguration = Context.Service<ControlPlaneConfiguration>(
  "work-engine/control-plane/Configuration",
);

const ControlPlaneConfig = Config.all({
  cloudTaskAuthToken: Config.redacted("cloudTaskAuthToken"),
  cloudTaskRouterSecret: Config.redacted("cloudTaskRouterSecret"),
  credentialBrokerSecret: Config.redacted("credentialBrokerSecret"),
  credentialBrokerUrl: Config.url("credentialBrokerUrl"),
  environmentRouterSecret: Config.redacted("environmentRouterSecret"),
  environmentPublicOrigin: Config.url("environmentPublicOrigin"),
  environmentImageDigest: Config.schema(Sha256DigestSchema, "environmentImageDigest"),
  t3codeVersion: Config.nonEmptyString("t3codeVersion"),
  sandboxSdkVersion: Config.nonEmptyString("sandboxSdkVersion"),
  backupBucketName: Config.schema(BackupBucketNameSchema, "backupBucketName"),
  r2AccessKeyId: Config.redacted("r2AccessKeyId"),
  r2SecretAccessKey: Config.redacted("r2SecretAccessKey"),
}).pipe(Config.nested("controlPlane"));

export interface ControlPlaneDependencies {
  readonly configuration: ControlPlaneConfiguration;
  readonly session: ControlPlaneEnv["SESSION"];
  readonly projectMemory: ControlPlaneEnv["PROJECT_MEMORY"];
  readonly environment: ControlPlaneEnv["ENVIRONMENT"];
  readonly sandbox: NonNullable<ControlPlaneEnv["SANDBOX"]>;
  readonly backupBucket: R2Bucket;
  readonly environmentConnectRate: RateLimit;
  readonly environmentHttpRate: RateLimit;
}

export const ControlPlaneDependencies = Context.Service<ControlPlaneDependencies>(
  "work-engine/control-plane/Dependencies",
);

export interface ControlPlaneRouters {
  readonly cloudTask: CloudTaskRouter;
  readonly environment: EnvironmentRouter;
}

export const ControlPlaneRouters = Context.Service<ControlPlaneRouters>(
  "work-engine/control-plane/Routers",
);

export class ControlPlaneConfigurationError extends Schema.TaggedErrorClass<ControlPlaneConfigurationError>()(
  "ControlPlaneConfigurationError",
  {},
) {}

export class ControlPlaneRoutingError extends Schema.TaggedErrorClass<ControlPlaneRoutingError>()(
  "ControlPlaneRoutingError",
  {},
) {}

export class ControlPlaneNotFoundError extends Schema.TaggedErrorClass<ControlPlaneNotFoundError>()(
  "ControlPlaneNotFoundError",
  {},
) {}

const readConfiguration = (
  env: ControlPlaneEnv,
): Effect.Effect<ControlPlaneConfiguration, ControlPlaneConfigurationError> =>
  Effect.try({
    try: () =>
      ConfigProvider.fromUnknown({
        controlPlane: {
          cloudTaskAuthToken: env.CLOUD_TASK_AUTH_TOKEN,
          cloudTaskRouterSecret: env.CLOUD_TASK_ROUTER_SECRET,
          credentialBrokerSecret: env.CREDENTIAL_BROKER_SECRET,
          credentialBrokerUrl: env.CREDENTIAL_BROKER_URL,
          environmentRouterSecret: env.ENVIRONMENT_ROUTER_SECRET,
          environmentPublicOrigin: env.ENVIRONMENT_PUBLIC_ORIGIN,
          environmentImageDigest: env.ENVIRONMENT_IMAGE_DIGEST,
          t3codeVersion: env.T3CODE_VERSION,
          sandboxSdkVersion: env.SANDBOX_SDK_VERSION,
          backupBucketName: env.BACKUP_BUCKET_NAME,
          r2AccessKeyId: env.R2_ACCESS_KEY_ID,
          r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      }),
    catch: () => new ControlPlaneConfigurationError(),
  }).pipe(
    Effect.flatMap((provider) => ControlPlaneConfig.parse(provider)),
    Effect.mapError(() => new ControlPlaneConfigurationError()),
  );

export const ControlPlaneConfigurationLive = (
  env: ControlPlaneEnv,
): Layer.Layer<ControlPlaneConfiguration, ControlPlaneConfigurationError> =>
  Layer.effect(ControlPlaneConfiguration, readConfiguration(env));

export const ControlPlaneDependenciesLive = (
  env: ControlPlaneEnv,
): Layer.Layer<
  ControlPlaneDependencies,
  ControlPlaneConfigurationError,
  ControlPlaneConfiguration
> =>
  Layer.effect(
    ControlPlaneDependencies,
    Effect.gen(function* () {
      const configuration = yield* ControlPlaneConfiguration;
      const bindings = yield* Effect.try({
        try: () => ({
          session: env.SESSION,
          projectMemory: env.PROJECT_MEMORY,
          environment: env.ENVIRONMENT,
          sandbox: env.SANDBOX,
          backupBucket: env.BACKUP_BUCKET,
          environmentConnectRate: env.ENVIRONMENT_CONNECT_RATE,
          environmentHttpRate: env.ENVIRONMENT_HTTP_RATE,
        }),
        catch: () => new ControlPlaneConfigurationError(),
      });
      if (
        bindings.session === undefined ||
        bindings.projectMemory === undefined ||
        bindings.environment === undefined ||
        bindings.sandbox === undefined ||
        bindings.backupBucket === undefined ||
        bindings.environmentConnectRate === undefined ||
        bindings.environmentHttpRate === undefined
      ) {
        return yield* new ControlPlaneConfigurationError();
      }
      return {
        configuration,
        ...bindings,
      };
    }),
  );

export const ControlPlaneRoutersLive = (
  env: ControlPlaneEnv,
): Layer.Layer<ControlPlaneRouters, ControlPlaneRoutingError, ControlPlaneDependencies> =>
  Layer.effect(
    ControlPlaneRouters,
    Effect.gen(function* () {
      const dependencies = yield* ControlPlaneDependencies;
      return yield* Effect.try({
        try: () => {
          const configuredEnv: ControlPlaneEnv = {
            ...env,
            SESSION: dependencies.session,
            PROJECT_MEMORY: dependencies.projectMemory,
            ENVIRONMENT: dependencies.environment,
            SANDBOX: dependencies.sandbox,
            BACKUP_BUCKET: dependencies.backupBucket,
            ENVIRONMENT_CONNECT_RATE: dependencies.environmentConnectRate,
            ENVIRONMENT_HTTP_RATE: dependencies.environmentHttpRate,
            CLOUD_TASK_AUTH_TOKEN: Redacted.value(dependencies.configuration.cloudTaskAuthToken),
            CLOUD_TASK_ROUTER_SECRET: Redacted.value(
              dependencies.configuration.cloudTaskRouterSecret,
            ),
            CREDENTIAL_BROKER_SECRET: Redacted.value(
              dependencies.configuration.credentialBrokerSecret,
            ),
            CREDENTIAL_BROKER_URL: dependencies.configuration.credentialBrokerUrl.toString(),
            ENVIRONMENT_ROUTER_SECRET: Redacted.value(
              dependencies.configuration.environmentRouterSecret,
            ),
            ENVIRONMENT_PUBLIC_ORIGIN:
              dependencies.configuration.environmentPublicOrigin.toString(),
            ENVIRONMENT_IMAGE_DIGEST: dependencies.configuration.environmentImageDigest,
            T3CODE_VERSION: dependencies.configuration.t3codeVersion,
            SANDBOX_SDK_VERSION: dependencies.configuration.sandboxSdkVersion,
            BACKUP_BUCKET_NAME: dependencies.configuration.backupBucketName,
            R2_ACCESS_KEY_ID: Redacted.value(dependencies.configuration.r2AccessKeyId),
            R2_SECRET_ACCESS_KEY: Redacted.value(dependencies.configuration.r2SecretAccessKey),
          };
          return {
            cloudTask: new CloudTaskRouter(configuredEnv),
            environment: new EnvironmentRouter(configuredEnv),
          };
        },
        catch: () => new ControlPlaneRoutingError(),
      });
    }),
  );

const HealthResponseSchema = Schema.Struct({
  status: Schema.Literal("ok"),
  runtime: Schema.Literal("agent-runtime-0002"),
});
const ControlPlaneFailureSchema = Schema.Union([
  Schema.TaggedStruct("ControlPlaneConfigurationFailure", {
    reason: Schema.Literal("Control-plane configuration is invalid"),
  }),
  Schema.TaggedStruct("ControlPlaneRoutingFailure", {
    reason: Schema.Literal("Control-plane routing failed"),
  }),
  Schema.TaggedStruct("ControlPlaneNotFound", {
    reason: Schema.Literal("Worker route does not exist"),
  }),
]);

type ControlPlaneFailure =
  | ControlPlaneConfigurationError
  | ControlPlaneRoutingError
  | ControlPlaneNotFoundError;

const failureResponse = (failure: ControlPlaneFailure): Response => {
  const value =
    failure instanceof ControlPlaneConfigurationError
      ? {
          _tag: "ControlPlaneConfigurationFailure",
          reason: "Control-plane configuration is invalid",
        }
      : failure instanceof ControlPlaneNotFoundError
        ? { _tag: "ControlPlaneNotFound", reason: "Worker route does not exist" }
        : { _tag: "ControlPlaneRoutingFailure", reason: "Control-plane routing failed" };
  const status =
    failure instanceof ControlPlaneConfigurationError
      ? 503
      : failure instanceof ControlPlaneNotFoundError
        ? 404
        : 500;
  return Response.json(decodeUnknownStrict(ControlPlaneFailureSchema, value), { status });
};

const invokeRouter = (
  router: CloudTaskRouter | EnvironmentRouter,
  request: Request,
): Effect.Effect<Response, ControlPlaneRoutingError> =>
  Effect.tryPromise({
    try: () => router.fetch(request),
    catch: () => new ControlPlaneRoutingError(),
  });

const route = (
  request: Request,
): Effect.Effect<Response, ControlPlaneFailure, ControlPlaneRouters> =>
  Effect.gen(function* () {
    const routers = yield* ControlPlaneRouters;
    const url = yield* Effect.try({
      try: () => new URL(request.url),
      catch: () => new ControlPlaneRoutingError(),
    });
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        decodeUnknownStrict(HealthResponseSchema, {
          status: "ok",
          runtime: "agent-runtime-0002",
        }),
      );
    }
    if (url.pathname.startsWith("/v1/environments/")) {
      return yield* invokeRouter(routers.environment, request);
    }
    if (!url.pathname.startsWith("/v1/cloud-tasks")) {
      return yield* new ControlPlaneNotFoundError();
    }
    return yield* invokeRouter(routers.cloudTask, request);
  });

/**
 * The request program remains an Effect until the Worker boundary executes it.
 * Configuration and dependency Layers are acquired before route selection.
 */
export const handleRequest = (
  request: Request,
  env: ControlPlaneEnv,
  _ctx: ExecutionContext,
): Effect.Effect<Response, never> =>
  route(request).pipe(
    Effect.provide(
      ControlPlaneRoutersLive(env).pipe(
        Layer.provide(
          ControlPlaneDependenciesLive(env).pipe(Layer.provide(ControlPlaneConfigurationLive(env))),
        ),
      ),
    ),
    Effect.catch((failure) => Effect.succeed(failureResponse(failure))),
  );

import { Effect, Schema } from "effect";
import {
  AuthenticatedActorSchema,
  GrantSchema,
  SessionIdSchema,
  type AuthenticatedActor,
  type Grant,
  type SessionId,
} from "@work-engine/protocol";
import {
  currentUid,
  environment as bunEnvironment,
  inspectFile,
  readTextFile,
} from "./platform.ts";
const NonEmptyStringSchema = Schema.NonEmptyString;

export const OperatorEnvironmentSchema = Schema.Struct({
  WORK_ENGINE_URL: NonEmptyStringSchema,
  WORK_ENGINE_ACCESS_CLIENT_ID: NonEmptyStringSchema,
  WORK_ENGINE_ACCESS_CLIENT_SECRET: NonEmptyStringSchema,
  WORK_ENGINE_ACTOR_FILE: NonEmptyStringSchema,
  WORK_ENGINE_GRANT_FILE: Schema.optionalKey(NonEmptyStringSchema),
  WORK_ENGINE_SSH_IDENTITY_FILE: Schema.optionalKey(NonEmptyStringSchema),
  WORK_ENGINE_SSH_DIRECTORY: Schema.optionalKey(NonEmptyStringSchema),
  WORK_ENGINE_HERDR_BINARY: Schema.optionalKey(NonEmptyStringSchema),
});
export type OperatorEnvironment = typeof OperatorEnvironmentSchema.Type;

export const SessionCapabilityFileSchema = Schema.Struct({
  schemaVersion: Schema.Literal("work-engine/v1"),
  actor: AuthenticatedActorSchema,
  grants: Schema.Array(GrantSchema),
  sessionId: SessionIdSchema,
  endpoint: Schema.NonEmptyString,
});
export type SessionCapabilityFile = typeof SessionCapabilityFileSchema.Type;

export interface OperatorConfig {
  readonly baseUrl: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly actor: AuthenticatedActor;
  readonly grants: ReadonlyArray<Grant>;
  readonly sshIdentityFile: string;
  readonly sshDirectory: string;
  readonly herdrBinary: string;
}

export interface ConfigFileSystem {
  readonly readText: (path: string) => Effect.Effect<string, ConfigError>;
  readonly inspect: (path: string) => Effect.Effect<FileInspection, ConfigError>;
  readonly currentUid: () => number;
}

export interface FileInspection {
  readonly uid: number;
  readonly mode: number;
}

export type ConfigError =
  | { readonly _tag: "ConfigMissing"; readonly name: string }
  | { readonly _tag: "ConfigDecodeFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "ConfigPermissions"; readonly path: string; readonly reason: string }
  | { readonly _tag: "ConfigIoFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "OperatorRequired"; readonly reason: string };

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: string,
  path: string,
): Effect.Effect<S["Type"], ConfigError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(input) as unknown,
      catch: (error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path,
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
    return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(parsed).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path,
        reason: String(error),
      })),
    );
  });

const makeBunFileSystem = (): ConfigFileSystem => ({
  readText: (path) =>
    readTextFile(path).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigIoFailure" as const,
        path,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ),
  inspect: (path) =>
    inspectFile(path).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigIoFailure" as const,
        path,
        reason: error instanceof Error ? error.message : String(error),
      })),
    ),
  currentUid,
});

const ensurePrivateOwned = (fs: ConfigFileSystem, path: string): Effect.Effect<void, ConfigError> =>
  Effect.gen(function* () {
    const metadata = yield* fs.inspect(path);
    if (metadata.uid !== fs.currentUid()) {
      return yield* Effect.fail({
        _tag: "ConfigPermissions",
        path,
        reason: "configuration file is not owned by the current user",
      } as const);
    }
    if (metadata.mode !== 0o600) {
      return yield* Effect.fail({
        _tag: "ConfigPermissions",
        path,
        reason: "configuration file must have mode 0600",
      } as const);
    }
  });

const homePath = (value: string): string => {
  const home = bunEnvironment()["HOME"];
  if (value === "~") return home ?? value;
  if (value.startsWith("~/")) return `${home ?? "~"}${value.slice(1)}`;
  return value;
};

const actorGrants = (
  actor: AuthenticatedActor,
  grants: ReadonlyArray<Grant>,
): ReadonlyArray<Grant> => grants.filter((grant) => grant.subjectActorId === actor.actorId);

export const decodeOperatorConfig = (
  environment: unknown,
  files: ConfigFileSystem = makeBunFileSystem(),
): Effect.Effect<OperatorConfig, ConfigError> =>
  Effect.gen(function* () {
    const env = yield* Schema.decodeUnknownEffect(OperatorEnvironmentSchema, {
      onExcessProperty: "error",
    })(environment).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path: "environment",
        reason: String(error),
      })),
    );

    yield* ensurePrivateOwned(files, env.WORK_ENGINE_ACTOR_FILE);
    const actor = yield* decodeJson(
      AuthenticatedActorSchema,
      yield* files.readText(env.WORK_ENGINE_ACTOR_FILE),
      env.WORK_ENGINE_ACTOR_FILE,
    );
    if (actor.kind !== "operator" || actor.sessionId !== undefined) {
      return yield* Effect.fail({
        _tag: "OperatorRequired",
        reason: "actor file must contain a session-free operator actor",
      } as const);
    }

    const grantPath = env.WORK_ENGINE_GRANT_FILE;
    const grants =
      grantPath === undefined
        ? []
        : yield* Effect.gen(function* () {
            yield* ensurePrivateOwned(files, grantPath);
            const text = yield* files.readText(grantPath);
            return yield* decodeJson(Schema.Array(GrantSchema), text, grantPath);
          });

    const baseUrl = yield* Effect.try({
      try: () => new URL(env.WORK_ENGINE_URL).toString().replace(/\/$/, ""),
      catch: (error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path: "WORK_ENGINE_URL",
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
    return {
      baseUrl,
      accessClientId: env.WORK_ENGINE_ACCESS_CLIENT_ID,
      accessClientSecret: env.WORK_ENGINE_ACCESS_CLIENT_SECRET,
      actor: {
        ...actor,
        presentedGrants: Array.from(
          new Set([
            ...actor.presentedGrants,
            ...actorGrants(actor, grants).map((grant) => grant.grantId),
          ]),
        ),
      },
      grants,
      sshIdentityFile: homePath(env.WORK_ENGINE_SSH_IDENTITY_FILE ?? "~/.ssh/work-engine_ed25519"),
      sshDirectory: homePath(env.WORK_ENGINE_SSH_DIRECTORY ?? "~/.ssh/work-engine"),
      herdrBinary: env.WORK_ENGINE_HERDR_BINARY ?? "herdr",
    } satisfies OperatorConfig;
  });

export const decodeSessionCapability = (
  text: string,
  expectedSessionId: SessionId,
  files: ConfigFileSystem = makeBunFileSystem(),
  path = "capability file",
): Effect.Effect<SessionCapabilityFile, ConfigError> =>
  Effect.gen(function* () {
    const capability = yield* decodeJson(SessionCapabilityFileSchema, text, path);
    if (
      capability.sessionId !== expectedSessionId ||
      capability.actor.sessionId !== expectedSessionId
    ) {
      return yield* Effect.fail({
        _tag: "ConfigPermissions",
        path,
        reason: "capability file is bound to a different Session",
      } as const);
    }
    if (capability.actor.kind !== "worker_session" && capability.actor.kind !== "project_manager") {
      return yield* Effect.fail({
        _tag: "ConfigPermissions",
        path,
        reason: "capability actor kind is not a Session actor",
      } as const);
    }
    yield* ensurePrivateOwned(files, path);
    return capability;
  });

export const loadOperatorConfig: Effect.Effect<OperatorConfig, ConfigError> = Effect.sync(
  bunEnvironment,
).pipe(
  Effect.flatMap((env) =>
    decodeOperatorConfig({
      WORK_ENGINE_URL: env["WORK_ENGINE_URL"],
      WORK_ENGINE_ACCESS_CLIENT_ID: env["WORK_ENGINE_ACCESS_CLIENT_ID"],
      WORK_ENGINE_ACCESS_CLIENT_SECRET: env["WORK_ENGINE_ACCESS_CLIENT_SECRET"],
      WORK_ENGINE_ACTOR_FILE: env["WORK_ENGINE_ACTOR_FILE"],
      WORK_ENGINE_GRANT_FILE: env["WORK_ENGINE_GRANT_FILE"],
      WORK_ENGINE_SSH_IDENTITY_FILE: env["WORK_ENGINE_SSH_IDENTITY_FILE"],
      WORK_ENGINE_SSH_DIRECTORY: env["WORK_ENGINE_SSH_DIRECTORY"],
      WORK_ENGINE_HERDR_BINARY: env["WORK_ENGINE_HERDR_BINARY"],
    }),
  ),
);

export const loadSessionCapability = (
  expectedSessionId: SessionId,
): Effect.Effect<SessionCapabilityFile, ConfigError> =>
  Effect.gen(function* () {
    const path = bunEnvironment()["WORK_ENGINE_CAPABILITY_FILE"];
    if (path === undefined || path.length === 0) {
      return yield* Effect.fail({
        _tag: "ConfigMissing",
        name: "WORK_ENGINE_CAPABILITY_FILE",
      } as const);
    }
    const fs = makeBunFileSystem();
    yield* ensurePrivateOwned(fs, path);
    return yield* decodeSessionCapability(yield* fs.readText(path), expectedSessionId, fs, path);
  });

export const isConfigError = (error: unknown): error is ConfigError =>
  typeof error === "object" && error !== null && "_tag" in error;

export const configErrorReason = (error: ConfigError): string =>
  error._tag === "ConfigMissing" ? error.name : error.reason;

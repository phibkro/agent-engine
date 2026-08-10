import { Effect, Schema } from "effect";
import {
  currentUid,
  environment as bunEnvironment,
  inspectFile,
  readTextFile,
} from "./platform.ts";

const NonEmptyStringSchema = Schema.NonEmptyString;

export const OperatorEnvironmentSchema = Schema.Struct({
  WORK_ENGINE_BASE_URL: NonEmptyStringSchema,
  WORK_ENGINE_CREDENTIAL_FILE: NonEmptyStringSchema,
  WORK_ENGINE_ACTOR_ID: Schema.optionalKey(NonEmptyStringSchema),
});
export type OperatorEnvironment = typeof OperatorEnvironmentSchema.Type;

export const OperatorCredentialFileSchema = Schema.Struct({
  accessClientId: NonEmptyStringSchema,
  accessClientSecret: NonEmptyStringSchema,
  cloudTaskToken: NonEmptyStringSchema,
});
export type OperatorCredentialFile = typeof OperatorCredentialFileSchema.Type;

export interface OperatorConfig {
  readonly baseUrl: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly cloudTaskToken: string;
  readonly actorId?: string;
}

export interface FileInspection {
  readonly uid: number;
  readonly mode: number;
}

export interface ConfigFileSystem {
  readonly readText: (path: string) => Effect.Effect<string, ConfigError>;
  readonly inspect: (path: string) => Effect.Effect<FileInspection, ConfigError>;
  readonly currentUid: () => number;
}

export type ConfigError =
  | { readonly _tag: "ConfigMissing"; readonly path: string }
  | { readonly _tag: "ConfigDecodeFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "ConfigPermissions"; readonly path: string; readonly reason: string }
  | { readonly _tag: "ConfigIoFailure"; readonly path: string; readonly reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string,
  path: string,
): Effect.Effect<S["Type"], ConfigError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path,
        reason: reasonOf(error),
      }),
    });
    return yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(parsed).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigDecodeFailure" as const,
        path,
        reason: reasonOf(error),
      })),
    );
  });

const makeBunFileSystem = (): ConfigFileSystem => ({
  readText: (path) =>
    readTextFile(path).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigIoFailure" as const,
        path,
        reason: reasonOf(error),
      })),
    ),
  inspect: (path) =>
    inspectFile(path).pipe(
      Effect.mapError((error) => ({
        _tag: "ConfigIoFailure" as const,
        path,
        reason: reasonOf(error),
      })),
    ),
  currentUid,
});

const ensurePrivateCredential = (
  files: ConfigFileSystem,
  path: string,
): Effect.Effect<void, ConfigError> =>
  Effect.gen(function* () {
    const metadata = yield* files
      .inspect(path)
      .pipe(
        Effect.catchTag("ConfigIoFailure", (error) =>
          Effect.fail({ _tag: "ConfigMissing" as const, path: error.path }),
        ),
      );
    if (metadata.uid !== files.currentUid()) {
      return yield* Effect.fail({
        _tag: "ConfigPermissions" as const,
        path,
        reason: "credential file must be owned by the current operator",
      });
    }
    if (metadata.mode !== 0o600) {
      return yield* Effect.fail({
        _tag: "ConfigPermissions" as const,
        path,
        reason: "credential file must have mode 0600",
      });
    }
  });

const checkedUrl = (value: string): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => new URL(value).toString().replace(/\/$/, ""),
    catch: (error) => ({
      _tag: "ConfigDecodeFailure" as const,
      path: "WORK_ENGINE_BASE_URL",
      reason: reasonOf(error),
    }),
  });

export const decodeOperatorCredentialFile = (
  text: string,
  path = "credential file",
): Effect.Effect<OperatorCredentialFile, ConfigError> =>
  decodeJson(OperatorCredentialFileSchema, text, path);

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
        reason: reasonOf(error),
      })),
    );
    yield* ensurePrivateCredential(files, env.WORK_ENGINE_CREDENTIAL_FILE);
    const credentialText = yield* files.readText(env.WORK_ENGINE_CREDENTIAL_FILE);
    const credential = yield* decodeOperatorCredentialFile(
      credentialText,
      env.WORK_ENGINE_CREDENTIAL_FILE,
    );
    return {
      baseUrl: yield* checkedUrl(env.WORK_ENGINE_BASE_URL),
      accessClientId: credential.accessClientId,
      accessClientSecret: credential.accessClientSecret,
      cloudTaskToken: credential.cloudTaskToken,
      ...(env.WORK_ENGINE_ACTOR_ID === undefined ? {} : { actorId: env.WORK_ENGINE_ACTOR_ID }),
    } satisfies OperatorConfig;
  });

export const loadOperatorConfig: Effect.Effect<OperatorConfig, ConfigError> = Effect.sync(
  bunEnvironment,
).pipe(
  Effect.flatMap((environment) => {
    const actorId = environment["WORK_ENGINE_ACTOR_ID"];
    return decodeOperatorConfig({
      WORK_ENGINE_BASE_URL: environment["WORK_ENGINE_BASE_URL"],
      WORK_ENGINE_CREDENTIAL_FILE: environment["WORK_ENGINE_CREDENTIAL_FILE"],
      ...(actorId === undefined ? {} : { WORK_ENGINE_ACTOR_ID: actorId }),
    });
  }),
);

export const configErrorReason = (error: ConfigError): string =>
  error._tag === "ConfigDecodeFailure" ||
  error._tag === "ConfigPermissions" ||
  error._tag === "ConfigIoFailure"
    ? error.reason
    : `missing configuration: ${error.path}`;

export const isConfigError = (error: unknown): error is ConfigError =>
  typeof error === "object" && error !== null && "_tag" in error;

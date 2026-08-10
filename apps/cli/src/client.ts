import { Effect, Schema } from "effect";
import {
  ApiFailureSchema,
  AttachResolutionRequestSchema,
  AttachResolutionSchema,
  ProjectCreateResultSchema,
  WorkEngineHeader,
  type ApiFailure,
  type AttachResolution,
  type AttachResolutionRequest,
  type ProjectCreateResult,
} from "@work-engine/runtime";
import {
  AuthenticatedActorSchema,
  CommandEnvelopeSchema,
  CommandResultSchema,
  CreateProjectRequestSchema,
  ProjectObservationSchema,
  SchemaVersionSchema,
  type AuthenticatedActor,
  type CommandEnvelope,
  type CommandResult,
  type CreateProjectRequest,
  type EventRevision,
  type ProjectCommand,
  type ProjectId,
  type ProjectObservation,
  type Sha256Digest,
} from "@work-engine/protocol";
export interface RemoteClientConfig {
  readonly baseUrl: string;
  readonly actor: AuthenticatedActor;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
}

export type RemoteClientError =
  | { readonly _tag: "DecodeFailure"; readonly path: string; readonly reason: string }
  | { readonly _tag: "AuthenticationFailure"; readonly reason: string }
  | { readonly _tag: "AuthorizationFailure"; readonly reason: string }
  | { readonly _tag: "DomainRejection"; readonly failure: ApiFailure }
  | { readonly _tag: "DependencyUnavailable"; readonly reason: string }
  | { readonly _tag: "TransportFailure"; readonly reason: string };

export interface RemoteClient {
  readonly createProject: (
    request: CreateProjectRequest,
  ) => Effect.Effect<ProjectCreateResult, RemoteClientError>;
  readonly dispatch: (
    projectId: ProjectId,
    commandId: CommandEnvelope["commandId"],
    expectedRevision: EventRevision,
    command: ProjectCommand,
  ) => Effect.Effect<CommandResult, RemoteClientError>;
  readonly observe: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectObservation, RemoteClientError>;
  readonly artifact: (
    projectId: ProjectId,
    digest: Sha256Digest,
  ) => Effect.Effect<Uint8Array, RemoteClientError>;
  readonly attachResolution: (
    projectId: ProjectId,
    request: AttachResolutionRequest,
  ) => Effect.Effect<AttachResolution, RemoteClientError>;
  readonly getAttachResolution: (
    projectId: ProjectId,
    resolutionId: string,
  ) => Effect.Effect<AttachResolution, RemoteClientError>;
}

const DOMAIN_REJECTIONS: Record<string, true> = {
  artifact_missing: true,
  gate_unsatisfied: true,
  invalid_transition: true,
  lease_expired: true,
  policy_rejected: true,
  proposal_stale: true,
  project_not_found: true,
  resource_conflict: true,
  revision_mismatch: true,
  unauthorized: true,
};

const asFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: string): S["Type"] => {
  const parsed: unknown = JSON.parse(input);
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(parsed);
};

const decodeFailure = (input: string, path: string): RemoteClientError => {
  try {
    return {
      _tag: "DomainRejection",
      failure: decodeJson(ApiFailureSchema, input),
    };
  } catch (error) {
    return {
      _tag: "DecodeFailure",
      path,
      reason: asFailure(error),
    };
  }
};

const bodyFor = <S extends Schema.ConstraintEncoder<unknown>>(schema: S, value: S["Type"]): string =>
  JSON.stringify(Schema.encodeSync(schema, { onExcessProperty: "error" })(value));

const route = (baseUrl: string, path: string): string =>
  new URL(path, `${baseUrl}/`).toString();

const makeHeaders = (config: RemoteClientConfig, includeJson: boolean): Headers => {
  const headers = new Headers({
    [WorkEngineHeader.actorId]: config.actor.actorId,
    [WorkEngineHeader.grantIds]: config.actor.presentedGrants.join(","),
    Accept: "application/json",
  });
  if (config.accessClientId !== undefined && config.accessClientSecret !== undefined) {
    headers.set(WorkEngineHeader.accessClientId, config.accessClientId);
    headers.set(WorkEngineHeader.accessClientSecret, config.accessClientSecret);
  }
  if (includeJson) headers.set("Content-Type", "application/json");
  return headers;
};

const responseError = (
  response: Response,
  body: string,
  path: string,
): RemoteClientError => {
  if (response.status === 401) {
    return { _tag: "AuthenticationFailure", reason: "Cloudflare Access rejected the service token" };
  }
  if (response.status === 403) {
    return { _tag: "AuthorizationFailure", reason: "Cloudflare Access or Project Grant denied the request" };
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { _tag: "DependencyUnavailable", reason: `Worker returned HTTP ${response.status}` };
  }
  const failure = decodeFailure(body, path);
  if (failure._tag === "DomainRejection" && DOMAIN_REJECTIONS[failure.failure.code] === true) {
    return failure;
  }
  return failure;
};
const fetchJson = <S extends Schema.ConstraintDecoder<unknown>>(
  config: RemoteClientConfig,
  method: string,
  path: string,
  schema: S,
  body?: string,
): Effect.Effect<S["Type"], RemoteClientError> =>
  Effect.gen(function* () {
    const url = route(config.baseUrl, path);
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method,
          headers: makeHeaders(config, body !== undefined),
          body,
          signal,
        }),
      catch: (error) => ({
        _tag: "TransportFailure" as const,
        reason: asFailure(error),
      }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (error) => ({
        _tag: "TransportFailure" as const,
        reason: asFailure(error),
      }),
    });
    if (!response.ok) return yield* Effect.fail(responseError(response, text, path));
    return yield* Effect.try({
      try: () => decodeJson(schema, text),
      catch: (error) => ({
        _tag: "DecodeFailure" as const,
        path,
        reason: asFailure(error),
      }),
    });
  });

const fetchBytes = (
  config: RemoteClientConfig,
  path: string,
): Effect.Effect<Uint8Array, RemoteClientError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(route(config.baseUrl, path), { headers: makeHeaders(config, false), signal }),
      catch: (error) => ({
        _tag: "TransportFailure" as const,
        reason: asFailure(error),
      }),
    });
    if (!response.ok) {
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (error) => ({
          _tag: "TransportFailure" as const,
          reason: asFailure(error),
        }),
      });
      return yield* Effect.fail(responseError(response, text, path));
    }
    return yield* Effect.tryPromise({
      try: async () => new Uint8Array(await response.arrayBuffer()),
      catch: (error) => ({
        _tag: "TransportFailure" as const,
        reason: asFailure(error),
      }),
    });
  });

const commandEffect = (
  config: RemoteClientConfig,
  projectId: ProjectId,
  commandId: CommandEnvelope["commandId"],
  expectedRevision: EventRevision,
  command: ProjectCommand,
): Effect.Effect<CommandResult, RemoteClientError> => {
  const actor = Schema.decodeUnknownSync(AuthenticatedActorSchema, config.actor, {
    onExcessProperty: "error",
  });
  const envelope: CommandEnvelope = {
    schemaVersion: SchemaVersionSchema.make("work-engine/v1"),
    commandId,
    projectId,
    expectedRevision,
    actor,
    command,
  };
  return fetchJson(
    config,
    "POST",
    `/v1/projects/${encodeURIComponent(projectId)}/commands`,
    CommandResultSchema,
    bodyFor(CommandEnvelopeSchema, envelope),
  );
};

export const makeRemoteClient = (config: RemoteClientConfig): RemoteClient => ({
  createProject: (request) =>
    fetchJson(
      config,
      "POST",
      "/v1/projects",
      ProjectCreateResultSchema,
      bodyFor(CreateProjectRequestSchema, request),
    ),
  dispatch: (projectId, commandId, expectedRevision, command) =>
    commandEffect(config, projectId, commandId, expectedRevision, command),
  observe: (projectId) =>
    fetchJson(
      config,
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/observations/current`,
      ProjectObservationSchema,
    ),
  artifact: (projectId, digest) =>
    fetchBytes(
      config,
      `/v1/projects/${encodeURIComponent(projectId)}/artifacts/${digest}`,
    ),
  attachResolution: (projectId, request) =>
    fetchJson(
      config,
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/attach-resolutions`,
      AttachResolutionSchema,
      bodyFor(AttachResolutionRequestSchema, request),
    ),
  getAttachResolution: (projectId, resolutionId) =>
    fetchJson(
      config,
      "GET",
      `/v1/projects/${encodeURIComponent(projectId)}/attach-resolutions/${encodeURIComponent(resolutionId)}`,
      AttachResolutionSchema,
    ),
});

export const makeCommandEnvelope = (
  config: RemoteClientConfig,
  commandId: CommandEnvelope["commandId"],
  projectId: ProjectId,
  expectedRevision: EventRevision,
  command: ProjectCommand,
): CommandEnvelope => ({
  schemaVersion: SchemaVersionSchema.make("work-engine/v1"),
  commandId,
  projectId,
  expectedRevision,
  actor: Schema.decodeUnknownSync(AuthenticatedActorSchema, config.actor, {
    onExcessProperty: "error",
  }),
  command,
});

export const encodeCommandEnvelope = (envelope: CommandEnvelope): string =>
  bodyFor(CommandEnvelopeSchema, envelope);

export const encodeCreateProjectRequest = (request: CreateProjectRequest): string =>
  bodyFor(CreateProjectRequestSchema, request);

export const decodeApiFailure = (input: unknown): ApiFailure =>
  Schema.decodeUnknownSync(ApiFailureSchema, { onExcessProperty: "error" })(input);

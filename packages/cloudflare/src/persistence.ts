import * as Schema from "effect/Schema";
import { canonicalize } from "@work-engine/protocol";
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import { ProjectSnapshotSchema, type ProjectSnapshot } from "./schemas.ts";

export const PROJECT_STATE_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL
);
`;

const ProjectSnapshotJsonSchema = Schema.fromJsonString(ProjectSnapshotSchema);

const decodeSnapshotJson = (value: string): ProjectSnapshot =>
  Schema.decodeUnknownSync(ProjectSnapshotJsonSchema, { onExcessProperty: "error" })(value);

export const ensureProjectStateTable = (storage: SqlStorage): void => {
  storage.exec(PROJECT_STATE_MIGRATION);
};

export const loadSnapshot = (storage: SqlStorage): ProjectSnapshot | undefined => {
  const rows = storage
    .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM project_state WHERE id = 1")
    .toArray();
  const row = rows[0];
  return row === undefined ? undefined : decodeSnapshotJson(row.snapshot_json);
};

export const persistSnapshot = (storage: SqlStorage, snapshot: ProjectSnapshot): void => {
  const json = encodeSnapshot(snapshot);
  storage.exec(
    `INSERT INTO project_state (id, snapshot_json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
    json,
  );
};

export const withSnapshotTransaction = <A>(
  ctx: DurableObjectState,
  callback: (snapshot: ProjectSnapshot | undefined) => { snapshot: ProjectSnapshot; value: A },
): A =>
  ctx.storage.transactionSync(() => {
    ensureProjectStateTable(ctx.storage.sql);
    const current = loadSnapshot(ctx.storage.sql);
    const next = callback(current);
    persistSnapshot(ctx.storage.sql, next.snapshot);
    return next.value;
  });

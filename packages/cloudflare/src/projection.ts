import * as Schema from "effect/Schema";
import { EventEnvelopeSchema, ProjectObservationSchema, type ProjectObservation } from "@work-engine/protocol";

export const PROJECT_PROJECTION_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_event_projection (
  project_id TEXT NOT NULL,
  event_revision INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  PRIMARY KEY (project_id, event_revision)
);
`;

export class D1ProjectProjection {
  readonly #db: D1Database;
  #ready: Promise<void> | undefined;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async ensureMigration(): Promise<void> {
    this.#ready ??= this.#db.exec(PROJECT_PROJECTION_MIGRATION).then(() => undefined);
    await this.#ready;
  }

  async project(observation: ProjectObservation): Promise<void> {
    await this.ensureMigration();
    const decoded = Schema.decodeUnknownSync(ProjectObservationSchema, { onExcessProperty: "error" })(observation);
    const grouped = new Map<number, typeof decoded.history>();
    for (const envelope of decoded.history) {
      const events = grouped.get(envelope.eventRevision) ?? [];
      grouped.set(envelope.eventRevision, [...events, envelope]);
    }
    const statements = [...grouped.entries()].map(([revision, events]) =>
      this.#db
        .prepare(
          `INSERT INTO project_event_projection
            (project_id, event_revision, events_json, source_digest)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, event_revision) DO UPDATE SET
             events_json = excluded.events_json,
             source_digest = excluded.source_digest`,
        )
        .bind(
          decoded.projectId,
          revision,
          JSON.stringify(events.map((event) => Schema.encodeSync(EventEnvelopeSchema)(event))),
          decoded.sourceDigest,
        ),
    );
    if (statements.length > 0) await this.#db.batch(statements);
  }
}

export const projectObservationToD1 = async (db: D1Database, observation: ProjectObservation): Promise<void> => {
  await new D1ProjectProjection(db).project(observation);
};
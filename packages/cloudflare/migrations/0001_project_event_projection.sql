CREATE TABLE IF NOT EXISTS project_event_projection (
  project_id TEXT NOT NULL,
  event_revision INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  PRIMARY KEY (project_id, event_revision)
);

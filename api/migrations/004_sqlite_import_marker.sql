-- One row once the SQLite control-plane.db has been imported (scripts/migrate-sqlite-to-postgres.mjs).
-- The import script refuses to run when this row exists, so the copy can never run twice.
CREATE TABLE control_plane_sqlite_import (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imported_at TIMESTAMPTZ NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  row_counts_json TEXT NOT NULL,
  audit_chain_records INTEGER NOT NULL
);

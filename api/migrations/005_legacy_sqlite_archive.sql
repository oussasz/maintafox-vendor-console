-- Rows of SQLite tables that no API version uses any more, copied verbatim by the one-shot import
-- (dist/tools/migrate-sqlite-to-postgres.js --archive-legacy-table <name>) so that nothing in
-- control-plane.db is dropped silently. Read-only history: no code path writes or reads it.
CREATE TABLE legacy_sqlite_archive (
  source_table TEXT NOT NULL,
  source_row_number INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_row_number)
);

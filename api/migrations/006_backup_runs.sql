-- Backup and restore-drill history (deploy/BACKUP_AND_RESTORE.md). Written by the backup container
-- (deploy/backup/backup.sh, restore-drill.sh) at the end of every run, read by the ops metrics.
CREATE TABLE backup_runs (
  id BIGSERIAL PRIMARY KEY,
  -- 'nightly' = pg_dump + base backup (+ off-site upload); 'restore_drill' = restore of the latest
  -- dump into a scratch database, verified and dropped again.
  kind TEXT NOT NULL CHECK (kind IN ('nightly', 'restore_drill')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  -- 'disabled' = no off-site destination configured (local copies only); 'not_applicable' = drill.
  offsite_status TEXT NOT NULL CHECK (offsite_status IN ('disabled', 'uploaded', 'failed', 'not_applicable')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  dump_file TEXT NULL,
  dump_bytes BIGINT NULL,
  dump_sha256 TEXT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX backup_runs_kind_finished_idx ON backup_runs (kind, finished_at DESC);

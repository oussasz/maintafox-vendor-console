/**
 * Measurements of the platform itself, shared by the ops overviews (routes/ops.ts) and the console
 * dashboards (routes/console.ts): backup runs as recorded by the backup container, a database
 * round trip, the object-storage bucket, the server's disk.
 */
import { statfs } from "node:fs/promises";

import { getMediaStore } from "../app/media.js";
import type { Database } from "../db/database.js";
import type { Severity } from "./sync-health.js";

/** A nightly backup older than this is late (24 h schedule + 2 h margin). */
export const BACKUP_MAX_AGE_HOURS = 26;
/** The restore drill runs monthly; older than this it was missed. */
export const RESTORE_DRILL_MAX_AGE_DAYS = 35;
/** Database round trip (SELECT 1) thresholds, milliseconds. */
export const DB_LATENCY_MS = { warn: 100, critical: 1000 };

export type BackupStatus = {
  kind: "nightly" | "restore_drill";
  last_status: "succeeded" | "failed";
  last_finished_at: Date;
  last_success_at: Date | null;
  last_offsite_upload_at: Date | null;
  last_offsite_status: string;
  /** File of the latest run; `*.age` when the backup container encrypts (BACKUP_LOCAL_ENCRYPTION=required). */
  last_dump_file: string | null;
};

/** The latest run of each kind (nightly backup, restore drill), as backup_runs records them. */
export async function loadBackupStatus(db: Database): Promise<BackupStatus[]> {
  return db.all<BackupStatus>(
    `SELECT DISTINCT ON (kind) kind,
            status AS last_status,
            finished_at AS last_finished_at,
            MAX(finished_at) FILTER (WHERE status = 'succeeded') OVER (PARTITION BY kind) AS last_success_at,
            MAX(finished_at) FILTER (WHERE offsite_status = 'uploaded') OVER (PARTITION BY kind) AS last_offsite_upload_at,
            offsite_status AS last_offsite_status,
            dump_file AS last_dump_file
     FROM backup_runs
     ORDER BY kind, finished_at DESC`,
  );
}

export async function probeDatabase(db: Database): Promise<{ latency_ms: number; size_bytes: number; connections: number }> {
  const started = process.hrtime.bigint();
  await db.query("SELECT 1");
  const latency_ms = Number(process.hrtime.bigint() - started) / 1e6;
  const row = await db.get<{ size_bytes: number; connections: number }>(
    `SELECT pg_database_size(current_database()) AS size_bytes,
            (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
  );
  return { latency_ms: Math.round(latency_ms * 10) / 10, size_bytes: row?.size_bytes ?? 0, connections: row?.connections ?? 0 };
}

export type ObjectStorageProbe =
  | { state: "ok"; severity: Severity; detail: string; latency_ms: number }
  | { state: "not_configured" | "unreachable"; severity: Severity; detail: string };

export async function probeObjectStorage(): Promise<ObjectStorageProbe> {
  const media = getMediaStore();
  if (!media) return { state: "not_configured", severity: "critical", detail: "object storage is not configured (S3_* settings missing)" };
  const started = Date.now();
  try {
    await media.headBucket();
    const latency_ms = Date.now() - started;
    return { state: "ok", severity: "info", detail: `bucket ${media.config.bucket} reachable (${latency_ms} ms)`, latency_ms };
  } catch (err) {
    return {
      state: "unreachable",
      severity: "critical",
      detail: `bucket ${media.config.bucket} unreachable: ${err instanceof Error ? err.name || err.message : String(err)}`,
    };
  }
}

/**
 * Free and total space of the file system the API runs on. On the single-server deployment the
 * containers share the host disk, so this is the disk the database and backups fill.
 */
export async function probeDisk(): Promise<{ free_bytes: number; total_bytes: number } | null> {
  try {
    const s = await statfs("/");
    return { free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

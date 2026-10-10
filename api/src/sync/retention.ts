/**
 * Sync retention (SYNC_PROTOCOL_V2.md §8).
 *
 * Log compaction: a log row is deleted only when every active (non-revoked) device of its tenant
 * has passed it AND it is older than SYNC_INGRESS_RETENTION_DAYS. A device's position is its v2
 * acknowledged checkpoint, or its v1 cursor when it has never used v2. Devices that never synced
 * hold no position. A tenant without any positioned active device is not compacted.
 * Current state and tombstones are never compacted: v2 delivery reads them, not the log.
 *
 * Idempotency pruning: stored exchange responses (v1 and v2) older than
 * SYNC_IDEMPOTENCY_RETENTION_DAYS are deleted.
 */
import type { Database } from "../db/database.js";
import type { SyncConfig } from "./config.js";

export type SyncRetentionReport = {
  skipped_concurrent_run: boolean;
  ingress_rows_deleted: number;
  idempotency_v1_deleted: number;
  idempotency_v2_deleted: number;
};

export async function runSyncRetention(
  db: Database,
  config: Pick<SyncConfig, "ingressRetentionDays" | "idempotencyRetentionDays">,
): Promise<SyncRetentionReport> {
  return db.tx(async () => {
    // One run at a time across API instances; a run that finds the lock taken does nothing.
    const lock = await db.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('mfx:sync-retention', 0)) AS locked",
    );
    if (!lock?.locked) {
      return { skipped_concurrent_run: true, ingress_rows_deleted: 0, idempotency_v1_deleted: 0, idempotency_v2_deleted: 0 };
    }

    const ingress = await db.run(
      `WITH positions AS (
         SELECT a.tenant_id,
                COALESCE(c.acknowledged_seq, v1.last_delivered_ingress_id) AS position
         FROM machine_activations a
         LEFT JOIN sync_device_checkpoint c
           ON c.tenant_id = a.tenant_id AND c.machine_fingerprint = a.machine_fingerprint
         LEFT JOIN sync_device_cursor v1
           ON v1.tenant_id = a.tenant_id AND v1.machine_fingerprint = a.machine_fingerprint
         WHERE a.revoked_at IS NULL
       ),
       floors AS (
         SELECT tenant_id, MIN(position) AS floor_seq
         FROM positions
         WHERE position IS NOT NULL
         GROUP BY tenant_id
       )
       DELETE FROM sync_mirror_ingress i
       USING floors f
       WHERE i.tenant_id = f.tenant_id
         AND i.id <= f.floor_seq
         AND i.received_at_rfc3339::timestamptz < now() - make_interval(days => $1)`,
      config.ingressRetentionDays,
    );

    const v1 = await db.run(
      `DELETE FROM sync_exchange_idempotency
       WHERE created_at_rfc3339::timestamptz < now() - make_interval(days => $1)`,
      config.idempotencyRetentionDays,
    );
    const v2 = await db.run(
      `DELETE FROM sync_exchange_idempotency_v2 WHERE created_at < now() - make_interval(days => $1)`,
      config.idempotencyRetentionDays,
    );

    return {
      skipped_concurrent_run: false,
      ingress_rows_deleted: ingress.changes,
      idempotency_v1_deleted: v1.changes,
      idempotency_v2_deleted: v2.changes,
    };
  });
}

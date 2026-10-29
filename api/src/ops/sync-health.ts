/**
 * Measured sync health (master plan Phase 3.3), computed from the sync store. Replaces the earlier
 * estimates (lag = stale devices x 45 s, ...). Every figure is defined here and in
 * deploy/OPS_METRICS.md; nothing is extrapolated.
 *
 * Per active device (licence and tenant active, not revoked):
 *   - lag_seconds: age of the oldest change this device has not acknowledged yet (v2: rows of the
 *     current state after its acknowledged checkpoint, excluding its own rows and personal rows of
 *     users it does not report; v1-only: log rows after its cursor). 0 when nothing is pending.
 *   - checkpoint_age_seconds: time since its last exchange (v2 checkpoint, else v1 cursor, else
 *     since activation for a device that never synced).
 * Per tenant, over the last OPS_WINDOW_HOURS:
 *   - rejection_rate_bps: refused items / (applied + refused + conflicting items), basis points.
 *   - dead_letter_count: distinct item keys refused and never applied since.
 *   - conflicts: items refused as conflicts (stale base_row_version).
 *   - retry_pressure: % of exchange requests that were retries answered from the stored response.
 * Runs in the caller's (operator) scope.
 */
import type { Database } from "../db/database.js";

/** Window of the rate figures (rejections, conflicts, dead letters, retries). */
export const OPS_WINDOW_HOURS = 24;
/** A device whose last heartbeat is older than this is offline (same rule as the machines list). */
export const DEVICE_ONLINE_WINDOW_SECONDS = 15 * 60;

/** Severity thresholds (warn, critical). Lag counts only devices that are online. */
export const SYNC_SEVERITY_THRESHOLDS = {
  onlineLagSeconds: { warn: 120, critical: 900 },
  rejectionRateBps: { warn: 100, critical: 500 },
  deadLetters: { warn: 1, critical: 10 },
  retryPressurePercent: { warn: 20, critical: 50 },
} as const;

export type Severity = "info" | "warn" | "critical";

export type DeviceSyncHealth = {
  tenant_id: string;
  machine_id: string;
  protocol: "v2" | "v1" | "never_synced";
  app_version: string | null;
  online: boolean;
  last_heartbeat_rfc3339: string;
  last_exchange_rfc3339: string | null;
  lag_seconds: number;
  checkpoint_age_seconds: number;
  offline_grace_hours: number;
};

export type TenantSyncHealth = {
  tenant_id: string;
  device_count: number;
  online_device_count: number;
  lag_seconds: number;
  online_lag_seconds: number;
  checkpoint_age_seconds: number;
  applied_items: number;
  rejected_items: number;
  conflicts: number;
  dead_letter_count: number;
  exchanges: number;
  retries: number;
  rejection_rate_bps: number;
  retry_pressure: number;
  severity: Severity;
};

export type SyncDrillRow = {
  batch_id: string;
  entity_type: string;
  failure_reason_code: string;
  idempotency_key: string;
  last_attempt_rfc3339: string;
  attempt_count: number;
};

export type SyncHealthSnapshot = {
  generated_at_rfc3339: string;
  window_hours: number;
  devices: DeviceSyncHealth[];
  tenants: TenantSyncHealth[];
  drill_by_tenant: Record<string, SyncDrillRow[]>;
};

const DRILL_ROWS_PER_TENANT = 50;

const secondsBetween = (later: number, earlier: number) => Math.max(0, Math.round((later - earlier) / 1000));

function rank(s: Severity): number {
  return s === "critical" ? 2 : s === "warn" ? 1 : 0;
}

export function worse(a: Severity, b: Severity): Severity {
  return rank(a) >= rank(b) ? a : b;
}

function level(value: number, t: { warn: number; critical: number }): Severity {
  return value >= t.critical ? "critical" : value >= t.warn ? "warn" : "info";
}

export function tenantSeverity(t: Pick<TenantSyncHealth, "online_lag_seconds" | "rejection_rate_bps" | "dead_letter_count" | "retry_pressure">): Severity {
  const th = SYNC_SEVERITY_THRESHOLDS;
  return [
    level(t.online_lag_seconds, th.onlineLagSeconds),
    level(t.rejection_rate_bps, th.rejectionRateBps),
    level(t.dead_letter_count, th.deadLetters),
    level(t.retry_pressure, th.retryPressurePercent),
  ].reduce(worse, "info");
}

type DeviceRow = {
  tenant_id: string;
  machine_fingerprint: string;
  app_version: string | null;
  last_seen_at: string;
  activated_at: string;
  acknowledged_seq: number | null;
  last_exchange_at: Date | null;
  v1_cursor: number | null;
  v1_cursor_at: string | null;
  offline_grace_hours: number;
};

type CountRow = { tenant_id: string; c: number };

export async function collectSyncHealth(db: Database, now: Date = new Date()): Promise<SyncHealthSnapshot> {
  const nowMs = now.getTime();
  const since = new Date(nowMs - OPS_WINDOW_HOURS * 3600_000);
  const sinceIso = since.toISOString();

  const deviceRows = await db.all<DeviceRow>(
    `SELECT a.tenant_id, a.machine_fingerprint, a.app_version, a.last_seen_at, a.activated_at,
            c.acknowledged_seq, c.last_exchange_at,
            cur.last_delivered_ingress_id AS v1_cursor, cur.updated_at_rfc3339 AS v1_cursor_at,
            t.offline_grace_hours
     FROM machine_activations a
     JOIN tenants t ON t.id = a.tenant_id AND t.is_active = 1
     JOIN license_keys l ON l.id = a.license_id AND l.revoked_at IS NULL
     LEFT JOIN sync_device_checkpoint c ON c.tenant_id = a.tenant_id AND c.machine_fingerprint = a.machine_fingerprint
     LEFT JOIN sync_device_cursor cur ON cur.tenant_id = a.tenant_id AND cur.machine_fingerprint = a.machine_fingerprint
     WHERE a.revoked_at IS NULL
     ORDER BY a.tenant_id, a.machine_fingerprint`,
  );

  const devices: DeviceSyncHealth[] = [];
  for (const d of deviceRows) {
    const protocol: DeviceSyncHealth["protocol"] =
      d.acknowledged_seq !== null ? "v2" : d.v1_cursor !== null ? "v1" : "never_synced";
    let oldestPending: Date | string | undefined;
    if (protocol === "v1") {
      oldestPending = (
        await db.get<{ at: string }>(
          `SELECT received_at_rfc3339 AS at FROM sync_mirror_ingress
           WHERE tenant_id = $1 AND id > $2 AND machine_fingerprint <> $3
           ORDER BY id ASC LIMIT 1`,
          d.tenant_id,
          d.v1_cursor,
          d.machine_fingerprint,
        )
      )?.at;
    } else {
      oldestPending = (
        await db.get<{ at: Date }>(
          `SELECT s.updated_at AS at FROM sync_entity_state s
           WHERE s.tenant_id = $1 AND s.last_ingress_id > $2 AND s.origin_machine_fingerprint <> $3
             AND (s.owner_user_sync_id IS NULL OR s.owner_user_sync_id IN (
                   SELECT u.user_sync_id FROM sync_device_user u
                   WHERE u.tenant_id = $1 AND u.machine_fingerprint = $3))
           ORDER BY s.last_ingress_id ASC LIMIT 1`,
          d.tenant_id,
          d.acknowledged_seq ?? 0,
          d.machine_fingerprint,
        )
      )?.at;
    }
    const lastExchange =
      protocol === "v2" ? d.last_exchange_at : protocol === "v1" && d.v1_cursor_at ? new Date(d.v1_cursor_at) : null;
    const lastSeenMs = Date.parse(d.last_seen_at);
    devices.push({
      tenant_id: d.tenant_id,
      machine_id: d.machine_fingerprint,
      protocol,
      app_version: d.app_version,
      online: Number.isFinite(lastSeenMs) && secondsBetween(nowMs, lastSeenMs) <= DEVICE_ONLINE_WINDOW_SECONDS,
      last_heartbeat_rfc3339: d.last_seen_at,
      last_exchange_rfc3339: lastExchange ? lastExchange.toISOString() : null,
      lag_seconds: oldestPending ? secondsBetween(nowMs, new Date(oldestPending).getTime()) : 0,
      checkpoint_age_seconds: secondsBetween(nowMs, (lastExchange ?? new Date(d.activated_at)).getTime()),
      offline_grace_hours: d.offline_grace_hours,
    });
  }

  const byTenant = async (sql: string): Promise<Map<string, number>> =>
    new Map((await db.all<CountRow>(sql, sinceIso)).map((r) => [r.tenant_id, r.c]));
  const [applied, rejected, conflicts, deadLetters, exchangesV2, exchangesV1, retriesV2, retriesV1] = await Promise.all([
    byTenant(`SELECT tenant_id, COUNT(*) AS c FROM sync_mirror_ingress WHERE received_at_rfc3339 >= $1 GROUP BY tenant_id`),
    byTenant(`SELECT tenant_id, COUNT(*) AS c FROM sync_rejection_log WHERE created_at_rfc3339 >= $1 GROUP BY tenant_id`),
    byTenant(`SELECT tenant_id, COUNT(*) AS c FROM sync_conflict_log WHERE created_at >= $1::timestamptz GROUP BY tenant_id`),
    byTenant(
      `SELECT r.tenant_id, COUNT(DISTINCT r.idempotency_key) AS c FROM sync_rejection_log r
       WHERE r.created_at_rfc3339 >= $1
         AND NOT EXISTS (SELECT 1 FROM sync_mirror_ingress i WHERE i.tenant_id = r.tenant_id AND i.idempotency_key = r.idempotency_key)
       GROUP BY r.tenant_id`,
    ),
    byTenant(`SELECT tenant_id, COUNT(*) AS c FROM sync_exchange_idempotency_v2 WHERE created_at >= $1::timestamptz GROUP BY tenant_id`),
    byTenant(`SELECT tenant_id, COUNT(*) AS c FROM sync_exchange_idempotency WHERE created_at_rfc3339 >= $1 GROUP BY tenant_id`),
    byTenant(
      `SELECT tenant_id, COALESCE(SUM(replay_count), 0) AS c FROM sync_exchange_idempotency_v2
       WHERE last_replay_at >= $1::timestamptz GROUP BY tenant_id`,
    ),
    byTenant(
      `SELECT tenant_id, COALESCE(SUM(replay_count), 0) AS c FROM sync_exchange_idempotency
       WHERE last_replay_at >= $1::timestamptz GROUP BY tenant_id`,
    ),
  ]);

  const activeTenants = await db.all<{ id: string }>("SELECT id FROM tenants WHERE is_active = 1 ORDER BY id");
  const tenants: TenantSyncHealth[] = activeTenants.map(({ id }) => {
    const own = devices.filter((d) => d.tenant_id === id);
    const online = own.filter((d) => d.online);
    const a = applied.get(id) ?? 0;
    const r = rejected.get(id) ?? 0;
    const c = conflicts.get(id) ?? 0;
    const ex = (exchangesV2.get(id) ?? 0) + (exchangesV1.get(id) ?? 0);
    const rt = (retriesV2.get(id) ?? 0) + (retriesV1.get(id) ?? 0);
    const row = {
      tenant_id: id,
      device_count: own.length,
      online_device_count: online.length,
      lag_seconds: Math.max(0, ...own.map((d) => d.lag_seconds)),
      online_lag_seconds: Math.max(0, ...online.map((d) => d.lag_seconds)),
      checkpoint_age_seconds: Math.max(0, ...own.map((d) => d.checkpoint_age_seconds)),
      applied_items: a,
      rejected_items: r,
      conflicts: c,
      dead_letter_count: deadLetters.get(id) ?? 0,
      exchanges: ex,
      retries: rt,
      rejection_rate_bps: a + r + c > 0 ? Math.round((r * 10_000) / (a + r + c)) : 0,
      retry_pressure: ex + rt > 0 ? Math.round((rt * 100) / (ex + rt)) : 0,
    };
    return { ...row, severity: tenantSeverity(row) };
  });

  const drill = await db.all<SyncDrillRow & { tenant_id: string }>(
    `SELECT tenant_id, batch_id, entity_type, failure_reason_code, idempotency_key, last_attempt_rfc3339, attempt_count
     FROM (
       SELECT r.tenant_id,
              (array_agg(r.server_batch_id ORDER BY r.id DESC))[1] AS batch_id,
              (array_agg(r.entity_type ORDER BY r.id DESC))[1] AS entity_type,
              (array_agg(r.rejection_code ORDER BY r.id DESC))[1] AS failure_reason_code,
              r.idempotency_key,
              MAX(r.created_at_rfc3339) AS last_attempt_rfc3339,
              COUNT(*)::int AS attempt_count
       FROM sync_rejection_log r
       WHERE r.created_at_rfc3339 >= $1 AND r.server_batch_id IS NOT NULL AND r.entity_type IS NOT NULL
       GROUP BY r.tenant_id, r.idempotency_key
       UNION ALL
       SELECT k.tenant_id,
              (array_agg(k.server_batch_id ORDER BY k.id DESC))[1],
              (array_agg(k.entity_type ORDER BY k.id DESC))[1],
              'conflict_stale_base_row_version',
              k.idempotency_key,
              to_char(MAX(k.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              COUNT(*)::int
       FROM sync_conflict_log k
       WHERE k.created_at >= $1::timestamptz
       GROUP BY k.tenant_id, k.idempotency_key
     ) d
     ORDER BY tenant_id, last_attempt_rfc3339 DESC`,
    sinceIso,
  );
  const drill_by_tenant: Record<string, SyncDrillRow[]> = Object.fromEntries(tenants.map((t) => [t.tenant_id, []]));
  for (const { tenant_id, ...row } of drill) {
    const list = drill_by_tenant[tenant_id];
    if (list && list.length < DRILL_ROWS_PER_TENANT) list.push(row);
  }

  return {
    generated_at_rfc3339: now.toISOString(),
    window_hours: OPS_WINDOW_HOURS,
    devices,
    tenants,
    drill_by_tenant,
  };
}


/**
 * Operations: health, SLO window, sync / rollout / platform overviews, Prometheus metrics.
 * Every figure is measured (deploy/OPS_METRICS.md); none is estimated from another one.
 */
import type express from "express";

import type { ApiContext } from "../app/context.js";
import { METRICS_SCRAPE_TOKEN, SEED_BEHAVIOR } from "../app/config.js";
import { getMediaStore } from "../app/media.js";
import { observabilityWindow, percentile, workerState } from "../app/observability.js";
import { safeEqualUtf8, structuredLog, type ForceUpdateMode } from "../app/runtime.js";
import { openOperatorScope } from "../app/scope.js";
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus, type MetricFamily } from "../ops/prometheus.js";
import {
  collectSyncHealth,
  SYNC_SEVERITY_THRESHOLDS,
  worse,
  type Severity,
  type SyncHealthSnapshot,
} from "../ops/sync-health.js";

/** A nightly backup older than this is late (24 h schedule + 2 h margin). */
const BACKUP_MAX_AGE_HOURS = 26;
/** The restore drill runs monthly; older than this it was missed. */
const RESTORE_DRILL_MAX_AGE_DAYS = 35;
/** Database round trip (SELECT 1) thresholds, milliseconds. */
const DB_LATENCY_MS = { warn: 100, critical: 1000 };
/** API 5xx share of requests since start, percent (SLO availability 99.9 %). */
const API_5XX_PERCENT = { warn: 0.1, critical: 1 };

type BackupStatus = {
  kind: "nightly" | "restore_drill";
  last_status: "succeeded" | "failed";
  last_finished_at: Date;
  last_success_at: Date | null;
  last_offsite_upload_at: Date | null;
  last_offsite_status: string;
};

function ageHours(at: Date | null, nowMs: number): number | null {
  return at ? (nowMs - at.getTime()) / 3600_000 : null;
}

function syncOverview(snap: SyncHealthSnapshot) {
  const th = SYNC_SEVERITY_THRESHOLDS;
  const tenant_rows = snap.tenants.map((t) => ({
    tenant_id: t.tenant_id,
    lag_seconds: t.lag_seconds,
    checkpoint_age_seconds: t.checkpoint_age_seconds,
    rejection_rate_bps: t.rejection_rate_bps,
    retry_pressure: t.retry_pressure,
    dead_letter_count: t.dead_letter_count,
    severity: t.severity,
    device_count: t.device_count,
    online_device_count: t.online_device_count,
    online_lag_seconds: t.online_lag_seconds,
    applied_items: t.applied_items,
    rejected_items: t.rejected_items,
    conflicts: t.conflicts,
    exchanges: t.exchanges,
    retries: t.retries,
  }));

  const repair_queue = snap.tenants.flatMap((t) => [
    ...(t.dead_letter_count > 0
      ? [
          {
            item_id: `rq_${t.tenant_id}_dead_letter`,
            tenant_id: t.tenant_id,
            queue_kind: "dead_letter",
            severity: t.severity,
            summary: `${t.dead_letter_count} item(s) refused in the last ${snap.window_hours} h and never applied since.`,
            recommended_action: t.severity === "critical" ? ("escalate" as const) : ("acknowledge" as const),
          },
        ]
      : []),
    ...(t.retry_pressure >= th.retryPressurePercent.warn
      ? [
          {
            item_id: `rq_${t.tenant_id}_retries`,
            tenant_id: t.tenant_id,
            queue_kind: "retry_pressure",
            severity: t.severity,
            summary: `${t.retries} of ${t.exchanges + t.retries} exchange requests in the last ${snap.window_hours} h were retries (${t.retry_pressure}%).`,
            recommended_action: t.severity === "critical" ? ("escalate" as const) : ("acknowledge" as const),
          },
        ]
      : []),
  ]);

  const heartbeat_anomalies = snap.devices.flatMap((d) => {
    const codes: string[] = [];
    if (d.protocol === "never_synced") codes.push("never_synced");
    if (!d.online) codes.push("stale_heartbeat");
    if (d.checkpoint_age_seconds > d.offline_grace_hours * 3600) codes.push("expired_offline_grace");
    return codes.map((anomaly_code) => ({
      tenant_id: d.tenant_id,
      machine_id: d.machine_id,
      anomaly_code,
      detected_at_rfc3339: snap.generated_at_rfc3339,
    }));
  });

  const exchanges = snap.tenants.reduce((s, t) => s + t.exchanges, 0);
  const retries = snap.tenants.reduce((s, t) => s + t.retries, 0);
  return {
    generated_at_rfc3339: snap.generated_at_rfc3339,
    window_hours: snap.window_hours,
    aggregate: {
      max_lag_seconds: snap.tenants.reduce((m, t) => Math.max(m, t.lag_seconds), 0),
      checkpoint_p95_age_seconds: percentile(snap.devices.map((d) => d.checkpoint_age_seconds), 95) ?? 0,
      aggregate_retry_pressure: exchanges + retries > 0 ? Math.round((retries * 100) / (exchanges + retries)) : 0,
      dead_letter_total: snap.tenants.reduce((s, t) => s + t.dead_letter_count, 0),
      worst_severity: snap.tenants.reduce<Severity>((acc, t) => worse(acc, t.severity), "info"),
    },
    tenant_rows,
    device_rows: snap.devices,
    repair_queue,
    heartbeat_anomalies,
    drill_by_tenant: snap.drill_by_tenant,
  };
}

export function registerOpsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware } = ctx;

  async function loadBackupStatus(): Promise<BackupStatus[]> {
    return db.all<BackupStatus>(
      `SELECT DISTINCT ON (kind) kind,
              status AS last_status,
              finished_at AS last_finished_at,
              MAX(finished_at) FILTER (WHERE status = 'succeeded') OVER (PARTITION BY kind) AS last_success_at,
              MAX(finished_at) FILTER (WHERE offsite_status = 'uploaded') OVER (PARTITION BY kind) AS last_offsite_upload_at,
              offsite_status AS last_offsite_status
       FROM backup_runs
       ORDER BY kind, finished_at DESC`,
    );
  }

  async function probeDatabase(): Promise<{ latency_ms: number; size_bytes: number; connections: number }> {
    const started = process.hrtime.bigint();
    await db.query("SELECT 1");
    const latency_ms = Number(process.hrtime.bigint() - started) / 1e6;
    const row = await db.get<{ size_bytes: number; connections: number }>(
      `SELECT pg_database_size(current_database()) AS size_bytes,
              (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
    );
    return { latency_ms: Math.round(latency_ms * 10) / 10, size_bytes: row?.size_bytes ?? 0, connections: row?.connections ?? 0 };
  }

  async function probeObjectStorage(): Promise<{ severity: Severity; detail: string }> {
    const media = getMediaStore();
    if (!media) return { severity: "critical", detail: "object storage is not configured (S3_* settings missing)" };
    const started = Date.now();
    try {
      await media.headBucket();
      return { severity: "info", detail: `bucket ${media.config.bucket} reachable (${Date.now() - started} ms)` };
    } catch (err) {
      return {
        severity: "critical",
        detail: `bucket ${media.config.bucket} unreachable: ${err instanceof Error ? err.name || err.message : String(err)}`,
      };
    }
  }

  app.get("/health", async (_req, res) => {
    // All API data is in Postgres: report unhealthy (503) when it cannot be reached, so the
    // container healthcheck and the edge see the outage.
    try {
      await db.query("SELECT 1");
    } catch (err) {
      structuredLog("health_database_unreachable", { error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ status: "unavailable", database: "unreachable" });
      return;
    }
    res.json({
      status: "ok",
      seed_behavior: SEED_BEHAVIOR,
      privileged_guard: {
        require_step_up: true,
        require_reason: true,
      },
    });
  });

  app.get("/api/v1/ops/observability/slo", authMiddleware, async (_req, res) => {
    const uptimeSeconds = Math.max(0, Math.round((Date.now() - new Date(observabilityWindow.started_at_rfc3339).getTime()) / 1000));
    const requestTotal = observabilityWindow.request_total;
    const request5xx = observabilityWindow.request_5xx_total;
    const availabilityPercent = requestTotal > 0 ? Number((((requestTotal - request5xx) / requestTotal) * 100).toFixed(3)) : 100;
    const errorRatePercent = requestTotal > 0 ? Number(((request5xx / requestTotal) * 100).toFixed(3)) : 0;
    const authP50 = percentile(observabilityWindow.auth_latency_samples_ms, 50);
    const authP95 = percentile(observabilityWindow.auth_latency_samples_ms, 95);
    const authP99 = percentile(observabilityWindow.auth_latency_samples_ms, 99);
    const activationSuccess = observabilityWindow.activation_success_total;
    const activationFailure = observabilityWindow.activation_failure_total;
    const activationTotal = activationSuccess + activationFailure;
    const activationSuccessRate = activationTotal > 0 ? Number(((activationSuccess / activationTotal) * 100).toFixed(3)) : 100;
    const staleRow = await db.get(`SELECT COUNT(*) as c
         FROM machine_activations
         WHERE revoked_at IS NULL
           AND last_seen_at::timestamptz < now() - interval '5 minutes'`) as { c: number };
    const totalMachinesRow = await db.get("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL") as { c: number };
    const staleMachines = staleRow.c;
    const totalMachines = totalMachinesRow.c;
    const snap = await collectSyncHealth(db);
    const refusedUnapplied = snap.tenants.reduce((s, t) => s + t.dead_letter_count, 0);
    const conflicts = snap.tenants.reduce((s, t) => s + t.conflicts, 0);
    const staleRatioPercent = totalMachines > 0 ? Number(((staleMachines / totalMachines) * 100).toFixed(3)) : 0;

    const alerts = [
      {
        code: "api_availability",
        threshold: "availability < 99.9%",
        state: availabilityPercent < 99 ? "critical" : availabilityPercent < 99.9 ? "warn" : "ok",
        value: availabilityPercent,
      },
      {
        code: "auth_latency_p95",
        threshold: "p95 < 300ms",
        state: authP95 != null && authP95 > 700 ? "critical" : authP95 != null && authP95 > 300 ? "warn" : "ok",
        value_ms: authP95,
      },
      {
        code: "activation_success_rate",
        threshold: ">= 99.5%",
        state: activationSuccessRate < 95 ? "critical" : activationSuccessRate < 99.5 ? "warn" : "ok",
        value: activationSuccessRate,
      },
      {
        code: "sync_stale_surface",
        threshold: "stale <= 1%",
        state: staleRatioPercent > 5 ? "critical" : staleRatioPercent > 1 ? "warn" : "ok",
        value: staleRatioPercent,
      },
    ];

    res.json({
      generated_at_rfc3339: new Date().toISOString(),
      window_started_at_rfc3339: observabilityWindow.started_at_rfc3339,
      api_health: {
        uptime_seconds: uptimeSeconds,
        request_total: requestTotal,
        request_5xx_total: request5xx,
        availability_percent: availabilityPercent,
        error_rate_percent: errorRatePercent,
        slo_target_percent: 99.9,
      },
      auth_latency_ms: {
        sample_size: observabilityWindow.auth_latency_samples_ms.length,
        p50: authP50,
        p95: authP95,
        p99: authP99,
        slo_target_p95_ms: 300,
      },
      activation_claims: {
        success_total: activationSuccess,
        failure_total: activationFailure,
        success_rate_percent: activationSuccessRate,
        failures_by_reason: Array.from(observabilityWindow.activation_failures_by_reason.entries()).map(([reason, count]) => ({
          reason,
          count,
        })),
        slo_target_success_rate_percent: 99.5,
      },
      sync_operator_surface: {
        stale_machine_count: staleMachines,
        active_machine_count: totalMachines,
        stale_ratio_percent: staleRatioPercent,
        window_hours: snap.window_hours,
        dead_letter_total: refusedUnapplied,
        dead_letter_components: {
          refused_unapplied: refusedUnapplied,
          conflicts,
        },
        slo_target_stale_ratio_percent: 1,
      },
      alerts,
    });
  });

  app.get("/api/v1/ops/sync-overview", authMiddleware, async (_req, res) => {
    res.json(syncOverview(await collectSyncHealth(db)));
  });

  app.get("/api/v1/ops/rollout-overview", authMiddleware, async (_req, res) => {
    const tenants = await db.all(`SELECT id, update_channel, rollout_cohort, force_min_app_version, force_update_mode
         FROM tenants
         WHERE is_active = 1`) as Array<{
        id: string;
        update_channel: "stable" | "pilot" | "internal";
        rollout_cohort: string;
        force_min_app_version: string | null;
        force_update_mode: ForceUpdateMode;
      }>;
    const machineCountsByTenant = new Map<string, number>();
    const machineRows = await db.all("SELECT tenant_id, COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL GROUP BY tenant_id") as Array<{ tenant_id: string; c: number }>;
    for (const row of machineRows) {
      machineCountsByTenant.set(row.tenant_id, row.c);
    }
    const mismatches = await db.get(`SELECT COUNT(*) as c
         FROM license_keys l
         JOIN tenants t ON t.id = l.tenant_id
         WHERE l.update_channel != t.update_channel`) as { c: number };
    const totalMachines = machineRows.reduce((sum, row) => sum + row.c, 0);
    // Governance set by operators (pause / recall, routes/releases.ts); no row = active.
    const governance = new Map(
      (
        await db.all<{ channel: string; cohort_label: string; state: "active" | "paused" | "recalled"; recalled_version: string | null; reason: string; changed_at: string }>(
          "SELECT channel, cohort_label, state, recalled_version, reason, changed_at FROM rollout_cohort_governance",
        )
      ).map((r) => [`${r.channel}::${r.cohort_label}`, r]),
    );
    const impact = {
      // The release catalog (master plan Phase 5.3) replaces this identifier.
      release_id: process.env.ROLLOUT_RELEASE_ID ?? `rel_desktop_${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}`,
      affected_tenants: tenants.length,
      affected_machines: totalMachines,
      entitlement_channel_ok: mismatches.c === 0,
      known_blockers: [
        ...(mismatches.c > 0 ? [`${mismatches.c} tenant/license channel mismatches detected`] : []),
        ...(tenants.some((t) => t.force_min_app_version) ? ["forced minimum app version set for at least one cohort"] : []),
        ...(tenants.some((t) => t.force_update_mode === "required" || t.force_update_mode === "emergency")
          ? ["force-update enforcement is active for at least one tenant"]
          : []),
      ],
    };

    const groups = new Map<
      string,
      {
        channel: string;
        cohort_label: string;
        tenant_count: number;
        machine_count: number;
        governance: "active" | "paused" | "recalled";
        paused_at_rfc3339: string | null;
        recalled_version: string | null;
        governance_reason: string | null;
      }
    >();
    for (const tenant of tenants) {
      const key = `${tenant.update_channel}::${tenant.rollout_cohort}`;
      const set = governance.get(key);
      const existing =
        groups.get(key) ??
        {
          channel: tenant.update_channel,
          cohort_label: tenant.rollout_cohort,
          tenant_count: 0,
          machine_count: 0,
          governance: set?.state ?? "active",
          paused_at_rfc3339: set && set.state !== "active" ? set.changed_at : null,
          recalled_version: set?.recalled_version ?? null,
          governance_reason: set?.reason ?? null,
        };
      existing.tenant_count += 1;
      existing.machine_count += machineCountsByTenant.get(tenant.id) ?? 0;
      groups.set(key, existing);
    }

    // Only what the server measures. Download and signature-verification events are reported by
    // the desktop updater, which does not exist yet (Phase 5): those buckets are not invented.
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const heartbeats = await db.get<{ c: number; last: string | null }>(
      `SELECT COUNT(*) AS c, MAX(last_seen_at) AS last FROM machine_activations
       WHERE revoked_at IS NULL AND last_seen_at >= $1`,
      since,
    );
    const migrationChanges = await db.get<{ c: number; last: string | null }>(
      "SELECT COUNT(*) AS c, MAX(changed_at_rfc3339) AS last FROM tenant_update_policy_history WHERE changed_at_rfc3339 >= $1",
      since,
    );
    const diagnostics = [
      {
        category: "migration",
        count_24h: migrationChanges?.c ?? 0,
        last_event_rfc3339: migrationChanges?.last ?? null,
        sample_correlation_ids: [],
      },
      {
        category: "post_deploy_heartbeat",
        count_24h: heartbeats?.c ?? 0,
        last_event_rfc3339: heartbeats?.last ?? null,
        sample_correlation_ids: [],
      },
    ];

    res.json({
      impact,
      cohort_stages: Array.from(groups.values()),
      diagnostics,
    });
  });

  app.get("/api/v1/ops/platform-overview", authMiddleware, async (_req, res) => {
    const nowMs = Date.now();
    const machineRows = await db.all(`SELECT t.id as tenant_id,
                SUM(CASE WHEN a.revoked_at IS NULL THEN 0 ELSE 1 END) as revoked_count,
                COUNT(a.id) as machine_count
         FROM tenants t
         LEFT JOIN machine_activations a ON a.tenant_id = t.id
         WHERE t.is_active = 1
         GROUP BY t.id`) as Array<{ tenant_id: string; revoked_count: number; machine_count: number }>;
    const totalMachines = machineRows.reduce((sum, row) => sum + row.machine_count, 0);
    const revokedMachines = machineRows.reduce((sum, row) => sum + row.revoked_count, 0);
    const activations24h = await db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM machine_activations WHERE activated_at >= $1",
      new Date(nowMs - 24 * 3600_000).toISOString(),
    );
    const syncRows = await db.get<{ log_rows: number; state_rows: number }>(
      "SELECT (SELECT COUNT(*) FROM sync_mirror_ingress) AS log_rows, (SELECT COUNT(*) FROM sync_entity_state) AS state_rows",
    );

    const uptimeSeconds = Math.max(0, Math.round((nowMs - new Date(observabilityWindow.started_at_rfc3339).getTime()) / 1000));
    const requestTotal = observabilityWindow.request_total;
    const fiveXxPercent = requestTotal > 0 ? (observabilityWindow.request_5xx_total / requestTotal) * 100 : 0;
    const apiSeverity: Severity =
      fiveXxPercent >= API_5XX_PERCENT.critical ? "critical" : fiveXxPercent >= API_5XX_PERCENT.warn ? "warn" : "info";

    let dbService: { severity: Severity; detail: string };
    let dbSizeBytes: number | null = null;
    try {
      const probe = await probeDatabase();
      dbSizeBytes = probe.size_bytes;
      dbService = {
        severity: probe.latency_ms >= DB_LATENCY_MS.critical ? "critical" : probe.latency_ms >= DB_LATENCY_MS.warn ? "warn" : "info",
        detail: `round trip ${probe.latency_ms} ms, ${probe.connections} connections, ${(probe.size_bytes / 1048576).toFixed(1)} MiB`,
      };
    } catch (err) {
      dbService = { severity: "critical", detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }

    const retention = workerState.last_sync_retention;
    const workersService = retention
      ? {
          severity: (retention.ok ? "info" : "critical") as Severity,
          detail: retention.ok
            ? `last sync retention run ${retention.at_rfc3339}: ${JSON.stringify(retention.detail)}`
            : `last sync retention run ${retention.at_rfc3339} FAILED: ${String(retention.detail.error)}`,
        }
      : { severity: "info" as Severity, detail: "sync retention has not run since this API process started" };

    const backups = await loadBackupStatus();
    const nightly = backups.find((b) => b.kind === "nightly");
    const drill = backups.find((b) => b.kind === "restore_drill");
    const nightlyAge = ageHours(nightly?.last_success_at ?? null, nowMs);
    const drillAge = ageHours(drill?.last_success_at ?? null, nowMs);
    let backupSeverity: Severity = "info";
    const backupNotes: string[] = [];
    if (nightlyAge === null) {
      backupSeverity = "critical";
      backupNotes.push("no successful nightly backup recorded");
    } else {
      backupNotes.push(`last nightly backup ${nightlyAge.toFixed(1)} h ago`);
      if (nightlyAge > BACKUP_MAX_AGE_HOURS) backupSeverity = "critical";
    }
    if (nightly && nightly.last_status === "failed") {
      backupSeverity = worse(backupSeverity, "warn");
      backupNotes.push("the latest run failed");
    }
    if (nightly?.last_offsite_status === "disabled") {
      backupSeverity = worse(backupSeverity, "warn");
      backupNotes.push("off-site copy disabled: backups exist only on this server");
    } else if (nightly?.last_offsite_status === "failed") {
      backupSeverity = worse(backupSeverity, "critical");
      backupNotes.push("off-site upload failed");
    }
    if (drillAge === null || drillAge > RESTORE_DRILL_MAX_AGE_DAYS * 24) {
      backupSeverity = worse(backupSeverity, "warn");
      backupNotes.push(drillAge === null ? "no successful restore drill recorded" : `last restore drill ${Math.round(drillAge / 24)} days ago`);
    }

    const objectStorage = await probeObjectStorage();
    const platformServices = [
      {
        service: "api",
        severity: apiSeverity,
        detail: `up ${uptimeSeconds} s, ${requestTotal} requests, ${fiveXxPercent.toFixed(3)} % 5xx, ${machineRows.length} active tenants`,
      },
      { service: "workers", ...workersService },
      { service: "postgresql", ...dbService },
      { service: "object_storage", ...objectStorage },
      { service: "backups", severity: backupSeverity, detail: backupNotes.join("; ") },
    ];

    const infraPressure = [
      {
        metric_code: "activations_24h",
        value: activations24h?.c ?? 0,
        unit: "activations",
        threshold_hint: "review sudden spikes",
        trend: "not_tracked",
      },
      {
        metric_code: "revoked_machine_ratio_pct",
        value: totalMachines === 0 ? 0 : Number(((revokedMachines / totalMachines) * 100).toFixed(1)),
        unit: "%",
        threshold_hint: "critical > 15%",
        trend: "not_tracked",
      },
      {
        metric_code: "tenant_coverage",
        value: machineRows.length,
        unit: "tenants",
        threshold_hint: "review sudden drops",
        trend: "not_tracked",
      },
      ...(dbSizeBytes !== null
        ? [{ metric_code: "database_size_mib", value: Number((dbSizeBytes / 1048576).toFixed(1)), unit: "MiB", threshold_hint: "watch disk space", trend: "not_tracked" }]
        : []),
      { metric_code: "sync_log_rows", value: syncRows?.log_rows ?? 0, unit: "rows", threshold_hint: "compacted by retention", trend: "not_tracked" },
      { metric_code: "sync_state_rows", value: syncRows?.state_rows ?? 0, unit: "rows", threshold_hint: "one per synced entity", trend: "not_tracked" },
    ];

    const alerts = [
      ...platformServices
        .filter((s) => s.severity !== "info")
        .map((s) => ({
          alert_id: `alt_${s.service}`,
          title: `${s.service}: ${s.detail}`,
          severity: s.severity,
          state: "open",
          owner_actor_id: null,
          acknowledged_at_rfc3339: null,
          notes: [],
          drill_refs: {},
        })),
      ...(revokedMachines > 0
        ? [
            {
              alert_id: "alt_sync_revoked",
              title: "Revoked machine activations detected",
              severity: revokedMachines >= 5 ? "critical" : "warn",
              state: "open",
              owner_actor_id: null,
              acknowledged_at_rfc3339: null,
              notes: [],
              drill_refs: {
                correlation_id: "corr_revoked_activations",
              },
            },
          ]
        : []),
      ...(totalMachines === 0
        ? [
            {
              alert_id: "alt_rollout_no_machines",
              title: "No active machine telemetry",
              severity: "info",
              state: "open",
              owner_actor_id: null,
              acknowledged_at_rfc3339: null,
              notes: ["No claims yet; expected on fresh tenant onboarding."],
              drill_refs: {},
            },
          ]
        : []),
    ];

    res.json({
      platform_services: platformServices,
      infra_pressure: infraPressure,
      alerts,
    });
  });

  /**
   * Prometheus / OpenMetrics scrape. Accepts METRICS_SCRAPE_TOKEN as a bearer token (recorded as
   * the system scope `system:metrics-scrape`) or a vendor operator token.
   */
  const metricsAuth = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const h = req.headers.authorization;
    if (METRICS_SCRAPE_TOKEN && h?.startsWith("Bearer ") && safeEqualUtf8(h.slice(7), METRICS_SCRAPE_TOKEN)) {
      const scope = await openOperatorScope(db, "system:metrics-scrape", { method: req.method, path: req.path });
      db.runInScope(scope, next);
      return;
    }
    await authMiddleware(req, res, next);
  };

  app.get("/api/v1/ops/metrics", metricsAuth, async (_req, res) => {
    const nowMs = Date.now();
    const snap = await collectSyncHealth(db);
    const backups = await loadBackupStatus();
    const sizeRow = await db.get<{ size_bytes: number }>("SELECT pg_database_size(current_database()) AS size_bytes");
    const sevValue = (s: Severity) => (s === "critical" ? 2 : s === "warn" ? 1 : 0);
    const perTenant = (name: string, help: string, pick: (t: SyncHealthSnapshot["tenants"][number]) => number): MetricFamily => ({
      name,
      help,
      type: "gauge",
      samples: snap.tenants.map((t) => ({ labels: { tenant_id: t.tenant_id }, value: pick(t) })),
    });
    const perDevice = (name: string, help: string, pick: (d: SyncHealthSnapshot["devices"][number]) => number): MetricFamily => ({
      name,
      help,
      type: "gauge",
      samples: snap.devices.map((d) => ({ labels: { tenant_id: d.tenant_id, machine_id: d.machine_id }, value: pick(d) })),
    });
    const w = `${snap.window_hours} h`;
    const families: MetricFamily[] = [
      { name: "maintafox_api_uptime_seconds", help: "Seconds since this API process started.", type: "gauge", samples: [{ value: Math.round((nowMs - Date.parse(observabilityWindow.started_at_rfc3339)) / 1000) }] },
      { name: "maintafox_api_requests_total", help: "HTTP requests answered since start.", type: "counter", samples: [{ value: observabilityWindow.request_total }] },
      { name: "maintafox_api_requests_5xx_total", help: "HTTP 5xx responses since start.", type: "counter", samples: [{ value: observabilityWindow.request_5xx_total }] },
      {
        name: "maintafox_auth_logins_total",
        help: "Vendor console password logins since start, by result.",
        type: "counter",
        samples: [
          { labels: { result: "success" }, value: observabilityWindow.auth_success_total },
          { labels: { result: "failure" }, value: observabilityWindow.auth_failure_total },
        ],
      },
      {
        name: "maintafox_activation_claims_total",
        help: "Desktop activation claims/previews since start, by result.",
        type: "counter",
        samples: [
          { labels: { result: "success" }, value: observabilityWindow.activation_success_total },
          ...Array.from(observabilityWindow.activation_failures_by_reason.entries()).map(([reason, count]) => ({
            labels: { result: reason },
            value: count,
          })),
        ],
      },
      perTenant("maintafox_sync_devices", "Active devices of the tenant.", (t) => t.device_count),
      perTenant("maintafox_sync_devices_online", "Devices with a heartbeat in the last 15 minutes.", (t) => t.online_device_count),
      perTenant("maintafox_sync_applied_items", `Items applied in the last ${w}.`, (t) => t.applied_items),
      perTenant("maintafox_sync_rejected_items", `Items refused in the last ${w}.`, (t) => t.rejected_items),
      perTenant("maintafox_sync_conflicts", `Items refused as conflicts in the last ${w}.`, (t) => t.conflicts),
      perTenant("maintafox_sync_dead_letters", `Distinct items refused in the last ${w} and never applied since.`, (t) => t.dead_letter_count),
      perTenant("maintafox_sync_exchanges", `Exchange requests answered in the last ${w} (excluding retries).`, (t) => t.exchanges),
      perTenant("maintafox_sync_retries", `Exchange retries answered from the stored response in the last ${w}.`, (t) => t.retries),
      perTenant("maintafox_sync_rejection_rate_bps", `Refused / (applied + refused + conflicts) in the last ${w}, basis points.`, (t) => t.rejection_rate_bps),
      perTenant("maintafox_sync_retry_pressure_percent", `Retries / exchange requests in the last ${w}, percent.`, (t) => t.retry_pressure),
      perTenant("maintafox_sync_tenant_severity", "0 info, 1 warn, 2 critical (deploy/OPS_METRICS.md thresholds).", (t) => sevValue(t.severity)),
      perDevice("maintafox_sync_device_lag_seconds", "Age of the oldest change the device has not acknowledged (0 = up to date).", (d) => d.lag_seconds),
      perDevice("maintafox_sync_device_checkpoint_age_seconds", "Seconds since the device's last exchange (since activation if it never synced).", (d) => d.checkpoint_age_seconds),
      {
        name: "maintafox_backup_last_success_timestamp_seconds",
        help: "Unix time of the last successful run, by kind (nightly, restore_drill).",
        type: "gauge",
        samples: backups.filter((b) => b.last_success_at).map((b) => ({ labels: { kind: b.kind }, value: Math.round(b.last_success_at!.getTime() / 1000) })),
      },
      {
        name: "maintafox_backup_last_run_succeeded",
        help: "1 when the latest run of the kind succeeded, else 0.",
        type: "gauge",
        samples: backups.map((b) => ({ labels: { kind: b.kind }, value: b.last_status === "succeeded" ? 1 : 0 })),
      },
      {
        name: "maintafox_backup_offsite_last_upload_timestamp_seconds",
        help: "Unix time of the last nightly run whose off-site copy was uploaded (absent: never).",
        type: "gauge",
        samples: backups
          .filter((b) => b.kind === "nightly" && b.last_offsite_upload_at)
          .map((b) => ({ value: Math.round(b.last_offsite_upload_at!.getTime() / 1000) })),
      },
      { name: "maintafox_database_size_bytes", help: "Size of the API database.", type: "gauge", samples: [{ value: sizeRow?.size_bytes ?? 0 }] },
    ];
    res.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
    res.status(200).send(renderPrometheus(families));
  });
}

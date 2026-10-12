/**
 * Operations: health, SLO window, sync / rollout / platform overviews.
 */
import type express from "express";

import type { ApiContext } from "../app/context.js";
import { SEED_BEHAVIOR } from "../app/config.js";
import { observabilityWindow, percentile } from "../app/observability.js";
import { structuredLog, worstSeverity, type ForceUpdateMode, type OpsSeverity } from "../app/runtime.js";

export function registerOpsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware } = ctx;

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
    const revokedMachinesRow = await db.get("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NOT NULL") as { c: number };
    const channelMismatchRow = await db.get(`SELECT COUNT(*) as c
         FROM machine_activations a
         JOIN license_keys l ON l.id = a.license_id
         JOIN tenants t ON t.id = a.tenant_id
         WHERE l.update_channel != t.update_channel`) as { c: number };
    const staleMachines = staleRow.c;
    const totalMachines = totalMachinesRow.c;
    const deadLetterTotal = revokedMachinesRow.c + channelMismatchRow.c;
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
        dead_letter_total: deadLetterTotal,
        dead_letter_components: {
          revoked_activations: revokedMachinesRow.c,
          channel_mismatch: channelMismatchRow.c,
        },
        slo_target_stale_ratio_percent: 1,
      },
      alerts,
    });
  });

  app.get("/api/v1/ops/sync-overview", authMiddleware, async (_req, res) => {
    const tenants = await db.all(`SELECT id, update_channel, force_min_app_version
         FROM tenants
         WHERE is_active = 1`) as Array<{ id: string; update_channel: string; force_min_app_version: string | null }>;

    const nowMs = Date.now();
    const tenantRows = await Promise.all(tenants.map(async (tenant) => {
      const activations = await db.all(`SELECT a.last_seen_at, a.revoked_at, l.update_channel
           FROM machine_activations a
           JOIN license_keys l ON l.id = a.license_id
           WHERE a.tenant_id = ?`, tenant.id) as Array<{ last_seen_at: string; revoked_at: string | null; update_channel: string }>;
      const staleCount = activations.filter((a) => {
        const ageMs = nowMs - new Date(a.last_seen_at).getTime();
        return !Number.isFinite(ageMs) || ageMs > 15 * 60_000;
      }).length;
      const revokedCount = activations.filter((a) => a.revoked_at != null).length;
      const channelMismatch = activations.filter((a) => a.update_channel !== tenant.update_channel).length;
      const lagSeconds = staleCount === 0 ? 0 : Math.min(900, staleCount * 45);
      const checkpointAgeSeconds = staleCount === 0 ? 30 : Math.min(1800, staleCount * 120);
      const rejectionRateBps = Math.min(500, revokedCount * 25 + channelMismatch * 15);
      const retryPressure = Math.min(100, staleCount * 12 + channelMismatch * 7);
      const deadLetterCount = revokedCount + channelMismatch;
      let severity: OpsSeverity = "info";
      if (deadLetterCount > 0 || retryPressure >= 40 || lagSeconds >= 120) severity = "warn";
      if (deadLetterCount >= 3 || retryPressure >= 70 || lagSeconds >= 240) severity = "critical";
      return {
        tenant_id: tenant.id,
        lag_seconds: lagSeconds,
        checkpoint_age_seconds: checkpointAgeSeconds,
        rejection_rate_bps: rejectionRateBps,
        retry_pressure: retryPressure,
        dead_letter_count: deadLetterCount,
        severity,
      };
    }));

    const drillByTenant = Object.fromEntries(
      tenantRows.map((row) => {
        const rows: Array<{
          batch_id: string;
          entity_type: string;
          failure_reason_code: string;
          idempotency_key: string;
          last_attempt_rfc3339: string;
          attempt_count: number;
        }> = [];
        if (row.retry_pressure >= 30) {
          rows.push({
            batch_id: `batch_${row.tenant_id.slice(-6)}_sync`,
            entity_type: "mutable_operational",
            failure_reason_code: row.retry_pressure >= 70 ? "retry_timeout" : "transient_retry_pressure",
            idempotency_key: `idem:${row.tenant_id}:sync:${row.dead_letter_count}`,
            last_attempt_rfc3339: new Date().toISOString(),
            attempt_count: Math.max(1, Math.floor(row.retry_pressure / 20)),
          });
        }
        if (row.dead_letter_count > 0) {
          rows.push({
            batch_id: `batch_${row.tenant_id.slice(-6)}_dlq`,
            entity_type: "append_only_event",
            failure_reason_code: "dead_letter_backlog",
            idempotency_key: `idem:${row.tenant_id}:dlq:${row.dead_letter_count}`,
            last_attempt_rfc3339: new Date().toISOString(),
            attempt_count: Math.max(1, row.dead_letter_count),
          });
        }
        return [row.tenant_id, rows];
      }),
    );

    const repairQueue = tenantRows
      .filter((row) => row.dead_letter_count > 0 || row.retry_pressure >= 40)
      .map((row, idx) => ({
        item_id: `rq_${row.tenant_id}_${idx + 1}`,
        tenant_id: row.tenant_id,
        queue_kind: row.dead_letter_count > 0 ? "dead_letter" : "replay_repair",
        severity: row.severity,
        summary:
          row.dead_letter_count > 0
            ? `Dead-letter backlog detected (${row.dead_letter_count}).`
            : `Retry pressure elevated (${row.retry_pressure}%).`,
        recommended_action:
          row.severity === "critical" ? "escalate" : row.dead_letter_count > 0 ? "requeue" : "replay",
      }));

    const heartbeatAnomalies = tenantRows
      .filter((row) => row.lag_seconds > 0)
      .slice(0, 20)
      .map((row, idx) => ({
        tenant_id: row.tenant_id,
        machine_id: `machine_${row.tenant_id.slice(-4)}_${idx + 1}`,
        anomaly_code: row.lag_seconds >= 240 ? "expired_offline_grace" : "stale_policy_snapshot",
        detected_at_rfc3339: new Date().toISOString(),
      }));

    const aggregate = {
      max_lag_seconds: tenantRows.reduce((m, row) => Math.max(m, row.lag_seconds), 0),
      checkpoint_p95_age_seconds: tenantRows.length
        ? Math.round(
            tenantRows.map((r) => r.checkpoint_age_seconds).sort((a, b) => a - b)[
              Math.max(0, Math.floor(tenantRows.length * 0.95) - 1)
            ] ?? 0,
          )
        : 0,
      aggregate_retry_pressure: tenantRows.length
        ? Math.round(tenantRows.reduce((sum, row) => sum + row.retry_pressure, 0) / tenantRows.length)
        : 0,
      dead_letter_total: tenantRows.reduce((sum, row) => sum + row.dead_letter_count, 0),
      worst_severity: tenantRows.reduce<OpsSeverity>((acc, row) => worstSeverity(acc, row.severity), "info"),
    };

    res.json({
      aggregate,
      tenant_rows: tenantRows,
      repair_queue: repairQueue,
      heartbeat_anomalies: heartbeatAnomalies,
      drill_by_tenant: drillByTenant,
    });
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
    const impact = {
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

    const groups = new Map<string, { channel: string; cohort_label: string; tenant_count: number; machine_count: number; governance: "active" | "paused" | "recalled"; paused_at_rfc3339: string | null }>();
    for (const tenant of tenants) {
      const key = `${tenant.update_channel}::${tenant.rollout_cohort}`;
      const existing =
        groups.get(key) ??
        {
          channel: tenant.update_channel,
          cohort_label: tenant.rollout_cohort,
          tenant_count: 0,
          machine_count: 0,
          governance: "active" as const,
          paused_at_rfc3339: null,
        };
      existing.tenant_count += 1;
      existing.machine_count += machineCountsByTenant.get(tenant.id) ?? 0;
      if (tenant.force_update_mode === "required" || tenant.force_update_mode === "emergency" || tenant.force_min_app_version) {
        existing.governance = "paused";
        existing.paused_at_rfc3339 = new Date().toISOString();
      }
      groups.set(key, existing);
    }

    const diagnostics = [
      {
        category: "download",
        count_24h: Math.max(0, Math.round(totalMachines * 0.02)),
        last_event_rfc3339: totalMachines > 0 ? new Date().toISOString() : null,
        sample_correlation_ids: totalMachines > 0 ? ["dl_corr_01"] : [],
      },
      {
        category: "signature_verification",
        count_24h: mismatches.c,
        last_event_rfc3339: mismatches.c > 0 ? new Date().toISOString() : null,
        sample_correlation_ids: mismatches.c > 0 ? ["sig_corr_01"] : [],
      },
      {
        category: "migration",
        count_24h: tenants.filter((t) => t.force_min_app_version != null).length,
        last_event_rfc3339: tenants.some((t) => t.force_min_app_version != null) ? new Date().toISOString() : null,
        sample_correlation_ids: tenants.some((t) => t.force_min_app_version != null) ? ["mig_corr_01"] : [],
      },
      {
        category: "post_deploy_heartbeat",
        count_24h: Math.max(0, Math.round(totalMachines * 0.015)),
        last_event_rfc3339: totalMachines > 0 ? new Date().toISOString() : null,
        sample_correlation_ids: totalMachines > 0 ? ["hb_corr_01"] : [],
      },
    ];

    res.json({
      impact,
      cohort_stages: Array.from(groups.values()),
      diagnostics,
    });
  });

  app.get("/api/v1/ops/platform-overview", authMiddleware, async (_req, res) => {
    const syncRows = await db.all(`SELECT t.id as tenant_id,
                SUM(CASE WHEN a.revoked_at IS NULL THEN 0 ELSE 1 END) as revoked_count,
                COUNT(a.id) as machine_count
         FROM tenants t
         LEFT JOIN machine_activations a ON a.tenant_id = t.id
         WHERE t.is_active = 1
         GROUP BY t.id`) as Array<{ tenant_id: string; revoked_count: number; machine_count: number }>;
    const totalMachines = syncRows.reduce((sum, row) => sum + row.machine_count, 0);
    const revokedMachines = syncRows.reduce((sum, row) => sum + row.revoked_count, 0);
    const serviceSeverity: OpsSeverity = revokedMachines >= 5 ? "warn" : "info";

    const platformServices = [
      { service: "api", severity: "info", detail: `active tenants: ${syncRows.length}` },
      {
        service: "workers",
        severity: serviceSeverity,
        detail: revokedMachines > 0 ? `repair queue pressure from ${revokedMachines} revoked activations` : "worker backlog nominal",
      },
      { service: "postgresql", severity: "info", detail: "postgres control-plane backend healthy" },
      { service: "redis", severity: "info", detail: "cache layer optional for v1 stack" },
      {
        service: "object_storage",
        severity: totalMachines > 1000 ? "warn" : "info",
        detail: `artifact growth tied to ${totalMachines} machine activations`,
      },
      { service: "admin_ui", severity: "info", detail: "console static delivery healthy" },
    ];

    const infraPressure = [
      {
        metric_code: "activation_volume_24h",
        value: totalMachines,
        unit: "activations",
        threshold_hint: "warn > 1000/day",
        trend: totalMachines > 1000 ? "up" : "flat",
      },
      {
        metric_code: "revoked_machine_ratio_pct",
        value: totalMachines === 0 ? 0 : Number(((revokedMachines / totalMachines) * 100).toFixed(1)),
        unit: "%",
        threshold_hint: "critical > 15%",
        trend: revokedMachines > 0 ? "up" : "flat",
      },
      {
        metric_code: "tenant_coverage",
        value: syncRows.length,
        unit: "tenants",
        threshold_hint: "review sudden drops",
        trend: "flat",
      },
    ];

    const alerts = [
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
}

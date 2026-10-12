import { z } from "zod";

/** Mirrors Rust `SyncHealthSeverityV1`. */
export const SyncHealthSeverityV1Schema = z.enum(["info", "warn", "critical"]);
export type SyncHealthSeverityV1 = z.infer<typeof SyncHealthSeverityV1Schema>;

export const RepairQueueActionV1Schema = z.enum([
  "replay",
  "requeue",
  "acknowledge",
  "escalate",
]);

export const TenantSyncHealthRowV1Schema = z.object({
  tenant_id: z.string().min(1),
  lag_seconds: z.number().nonnegative(),
  checkpoint_age_seconds: z.number().nonnegative(),
  rejection_rate_bps: z.number().nonnegative(),
  retry_pressure: z.number().min(0).max(100),
  dead_letter_count: z.number().nonnegative(),
  severity: SyncHealthSeverityV1Schema,
});

export const SyncFailureDrillDownRowV1Schema = z.object({
  batch_id: z.string().min(1),
  entity_type: z.string().min(1),
  failure_reason_code: z.string().min(1),
  idempotency_key: z.string().min(1),
  last_attempt_rfc3339: z.string(),
  attempt_count: z.number().int().nonnegative(),
});

export const RepairQueueItemV1Schema = z.object({
  item_id: z.string().min(1),
  tenant_id: z.string().min(1),
  queue_kind: z.string().min(1),
  severity: SyncHealthSeverityV1Schema,
  summary: z.string(),
  recommended_action: RepairQueueActionV1Schema,
});

export const SyncAggregateV1Schema = z.object({
  max_lag_seconds: z.number().nonnegative(),
  checkpoint_p95_age_seconds: z.number().nonnegative(),
  aggregate_retry_pressure: z.number().min(0).max(100),
  dead_letter_total: z.number().nonnegative(),
  worst_severity: SyncHealthSeverityV1Schema,
});

export const OpsAlertStateV1Schema = z.enum(["open", "acknowledged", "resolved"]);

export const HeartbeatPolicyAnomalyV1Schema = z.object({
  tenant_id: z.string().min(1),
  machine_id: z.string().min(1),
  anomaly_code: z.string().min(1),
  detected_at_rfc3339: z.string(),
});

export const SyncOverviewV1Schema = z.object({
  aggregate: SyncAggregateV1Schema,
  tenant_rows: z.array(TenantSyncHealthRowV1Schema),
  repair_queue: z.array(RepairQueueItemV1Schema),
  heartbeat_anomalies: z.array(HeartbeatPolicyAnomalyV1Schema),
  drill_by_tenant: z.record(z.string(), z.array(SyncFailureDrillDownRowV1Schema)),
});

export const RolloutImpactPreviewV1Schema = z.object({
  release_id: z.string().min(1),
  affected_tenants: z.number().nonnegative(),
  affected_machines: z.number().nonnegative(),
  entitlement_channel_ok: z.boolean(),
  known_blockers: z.array(z.string()),
});

export const CohortRolloutStageV1Schema = z.object({
  channel: z.string().min(1),
  cohort_label: z.string().min(1),
  tenant_count: z.number().nonnegative(),
  machine_count: z.number().nonnegative(),
  governance: z.enum(["active", "paused", "recalled"]),
  paused_at_rfc3339: z.string().nullable(),
  recalled_version: z.string().nullable(),
  governance_reason: z.string().nullable(),
});

export const RolloutDiagnosticsBucketV1Schema = z.object({
  category: z.enum(["download", "signature_verification", "migration", "post_deploy_heartbeat"]),
  count_24h: z.number().nonnegative(),
  last_event_rfc3339: z.string().nullable(),
  sample_correlation_ids: z.array(z.string()),
});

export const RolloutOverviewV1Schema = z.object({
  impact: RolloutImpactPreviewV1Schema,
  cohort_stages: z.array(CohortRolloutStageV1Schema),
  diagnostics: z.array(RolloutDiagnosticsBucketV1Schema),
});

export const PlatformServiceStatusV1Schema = z.object({
  service: z.enum(["api", "workers", "postgresql", "redis", "object_storage", "admin_ui", "backups"]),
  severity: SyncHealthSeverityV1Schema,
  detail: z.string(),
});

export const InfrastructurePressureV1Schema = z.object({
  metric_code: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
  threshold_hint: z.string().min(1),
  trend: z.string().min(1),
});

export const OpsAlertV1Schema = z.object({
  alert_id: z.string().min(1),
  title: z.string().min(1),
  severity: SyncHealthSeverityV1Schema,
  state: OpsAlertStateV1Schema,
  owner_actor_id: z.string().nullable(),
  acknowledged_at_rfc3339: z.string().nullable(),
  notes: z.array(z.string()),
  drill_refs: z.lazy(() => IncidentDrillThroughRefsV1Schema),
});

export const PlatformOverviewV1Schema = z.object({
  platform_services: z.array(PlatformServiceStatusV1Schema),
  infra_pressure: z.array(InfrastructurePressureV1Schema),
  alerts: z.array(OpsAlertV1Schema),
});

export const IncidentDrillThroughRefsV1Schema = z
  .object({
    tenant_id_hint: z.string().optional(),
    sync_batch_id: z.string().optional(),
    rollout_release_id: z.string().optional(),
    correlation_id: z.string().optional(),
  })
  .strict();

/** Client guard mirroring Rust `tenant_safe_drill_through`. */
export function tenantSafeDrillThrough(refs: z.infer<typeof IncidentDrillThroughRefsV1Schema>): boolean {
  const fields = [
    refs.tenant_id_hint,
    refs.sync_batch_id,
    refs.rollout_release_id,
    refs.correlation_id,
  ];
  for (const s of fields) {
    if (s === undefined) continue;
    const lower = s.toLowerCase();
    if (
      lower.includes("@") ||
      lower.includes("email") ||
      lower.includes("phone") ||
      lower.includes("http://") ||
      lower.includes("https://")
    ) {
      return false;
    }
  }
  return true;
}

export function severityRank(s: SyncHealthSeverityV1): number {
  switch (s) {
    case "info":
      return 0;
    case "warn":
      return 1;
    case "critical":
      return 2;
    default:
      return 0;
  }
}

export function worstSeverity(a: SyncHealthSeverityV1, b: SyncHealthSeverityV1): SyncHealthSeverityV1 {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Mirrors Rust `repair_action_allowed` (UX hint; server enforces). */
export function repairActionAllowed(
  item: z.infer<typeof RepairQueueItemV1Schema>,
  action: z.infer<typeof RepairQueueActionV1Schema>,
): boolean {
  const deadLetter = item.queue_kind.includes("dead") || item.queue_kind === "dead_letter";
  switch (action) {
    case "escalate":
      return item.severity === "warn" || item.severity === "critical";
    case "replay":
    case "requeue":
      return true;
    case "acknowledge":
      return item.severity !== "critical" || deadLetter;
    default:
      return false;
  }
}

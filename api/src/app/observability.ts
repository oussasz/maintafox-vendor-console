/** In-process request / auth / activation counters behind GET /api/v1/ops/observability/slo. */
export const observabilityWindow = {
  started_at_rfc3339: new Date().toISOString(),
  request_total: 0,
  request_5xx_total: 0,
  auth_latency_samples_ms: [] as number[],
  auth_success_total: 0,
  auth_failure_total: 0,
  activation_success_total: 0,
  activation_failure_total: 0,
  activation_failures_by_reason: new Map<string, number>(),
};

function incrementReasonBucket(bucket: Map<string, number>, reason: string): void {
  bucket.set(reason, (bucket.get(reason) ?? 0) + 1);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function observeAuthAttempt(durationMs: number, success: boolean): void {
  observabilityWindow.auth_latency_samples_ms.push(Math.max(0, Math.round(durationMs)));
  if (observabilityWindow.auth_latency_samples_ms.length > 2_000) {
    observabilityWindow.auth_latency_samples_ms.splice(0, observabilityWindow.auth_latency_samples_ms.length - 2_000);
  }
  if (success) {
    observabilityWindow.auth_success_total += 1;
  } else {
    observabilityWindow.auth_failure_total += 1;
  }
}

export function observeActivationOutcome(
  reason:
    | "ok"
    | "invalid_body"
    | "license_not_found"
    | "license_revoked"
    | "license_expired"
    | "slot_limit_reached"
    | "activation_revoked",
): void {
  if (reason === "ok") {
    observabilityWindow.activation_success_total += 1;
    return;
  }
  observabilityWindow.activation_failure_total += 1;
  incrementReasonBucket(observabilityWindow.activation_failures_by_reason, reason);
}

type WorkerRun = { at_rfc3339: string; ok: boolean; detail: Record<string, unknown> };

/**
 * Outcome of the last run of each background worker (timers in index.ts): sync retention (platform
 * overview) and SlickPay reconciliation (console Billing page).
 */
export const workerState: {
  last_sync_retention: WorkerRun | null;
  last_slickpay_reconcile: WorkerRun | null;
} = { last_sync_retention: null, last_slickpay_reconcile: null };

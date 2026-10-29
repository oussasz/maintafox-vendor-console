import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import type { SyncFailureDrillDownRowV1, TenantSyncHealthRowV1 } from "@maintafox/contracts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import { getSyncOverview, type SyncOverviewV1 } from "@/services/vendor-ops-telemetry-service";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OpsSeverityBadge } from "./opsSeverityBadge";
import { SyncDeviceTimeline } from "./SyncDeviceTimeline";
import { errorText } from "@/lib/error-text";

export function SyncHealthPanel() {
  const { t } = useTranslation("vendorConsole");
  const [params] = useSearchParams();
  const evidence = params.get("evidence");
  const [overview, setOverview] = useState<SyncOverviewV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drillTenant, setDrillTenant] = useState<TenantSyncHealthRowV1 | null>(null);
  const drillRows: SyncFailureDrillDownRowV1[] =
    drillTenant && overview ? (overview.drill_by_tenant[drillTenant.tenant_id] ?? []) : [];

  const loadOverview = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await getSyncOverview();
      setOverview(next);
      if (drillTenant && !next.tenant_rows.some((row) => row.tenant_id === drillTenant.tenant_id)) {
        setDrillTenant(null);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[17px] font-bold text-text-primary">{t("sync.pageTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t("sync.pageBody")}
        </p>
      </header>

      {(evidence ?? undefined) && (
        <div
          className="rounded-md border border-surface-border bg-surface-1 p-3 text-sm"
          role="region"
          aria-label={t("section.evidenceAria")}
        >
          <p className="font-medium">{t("section.evidenceLabel")}</p>
          <p className="mt-1 font-mono text-xs text-text-secondary">{evidence}</p>
        </div>
      )}

      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          <p>{error}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadOverview(true)}>
            {t("sync.retry")}
          </Button>
        </ConsoleStatusBanner>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-text-muted">
              {t("sync.metrics.maxLag")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{overview?.aggregate.max_lag_seconds ?? 0}s</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-text-muted">
              {t("sync.metrics.checkpointP95")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">
            {overview?.aggregate.checkpoint_p95_age_seconds ?? 0}s
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-text-muted">
              {t("sync.metrics.retryPressure")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{overview?.aggregate.aggregate_retry_pressure ?? 0}%</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-text-muted">
              {t("sync.metrics.deadLetter")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <span className="text-lg font-semibold">{overview?.aggregate.dead_letter_total ?? 0}</span>
            <OpsSeverityBadge severity={overview?.aggregate.worst_severity ?? "info"} />
          </CardContent>
        </Card>
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("sync.tenants.title")}</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview(true)}>
            {refreshing ? t("sync.refreshing") : t("sync.refresh")}
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("sync.tenants.col.tenant")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.lag")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.checkpoint")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.reject")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.retry")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.dlq")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.sev")}</th>
                <th className="px-3 py-2">{t("sync.tenants.col.drill")}</th>
              </tr>
            </thead>
            <tbody>
              {overview?.tenant_rows.length ? (
                overview.tenant_rows.map((row) => (
                  <tr key={row.tenant_id} className="border-b border-surface-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{row.tenant_id}</td>
                    <td className="px-3 py-2">{row.lag_seconds}s</td>
                    <td className="px-3 py-2">{row.checkpoint_age_seconds}s</td>
                    <td className="px-3 py-2">{row.rejection_rate_bps}</td>
                    <td className="px-3 py-2">{row.retry_pressure}%</td>
                    <td className="px-3 py-2">{row.dead_letter_count}</td>
                    <td className="px-3 py-2">
                      <OpsSeverityBadge severity={row.severity} />
                    </td>
                    <td className="px-3 py-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setDrillTenant(row)}>
                        {t("sync.tenants.openDrill")}
                      </Button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={8} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("sync.loading")
                      : t("sync.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("sync.repair.title")}</h2>
        <p className="text-xs text-text-secondary">{t("sync.repair.hint")}</p>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("sync.repair.col.id")}</th>
                <th className="px-3 py-2">{t("sync.repair.col.tenant")}</th>
                <th className="px-3 py-2">{t("sync.repair.col.queue")}</th>
                <th className="px-3 py-2">{t("sync.repair.col.sev")}</th>
                <th className="px-3 py-2">{t("sync.repair.col.summary")}</th>

              </tr>
            </thead>
            <tbody>
              {overview?.repair_queue.length ? (
                overview.repair_queue.map((item) => (
                  <tr key={item.item_id} className="border-b border-surface-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{item.item_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{item.tenant_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{item.queue_kind}</td>
                    <td className="px-3 py-2">
                      <OpsSeverityBadge severity={item.severity} />
                    </td>
                    <td className="max-w-xs px-3 py-2 text-xs text-text-secondary">{item.summary}</td>

                  </tr>
                ))
              ) : (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={5} className="px-3 py-4 text-center text-sm text-text-muted">
                    {t("sync.repair.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          {t("sync.anomalies.title")}
        </h2>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("sync.anomalies.col.tenant")}</th>
                <th className="px-3 py-2">{t("sync.anomalies.col.machine")}</th>
                <th className="px-3 py-2">{t("sync.anomalies.col.code")}</th>
                <th className="px-3 py-2">{t("sync.anomalies.col.detected")}</th>
              </tr>
            </thead>
            <tbody>
              {overview?.heartbeat_anomalies.length ? (
                overview.heartbeat_anomalies.map((a) => (
                  <tr key={`${a.tenant_id}-${a.machine_id}`} className="border-b border-surface-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{a.tenant_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{a.machine_id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{a.anomaly_code}</td>
                    <td className="px-3 py-2 text-xs">{a.detected_at_rfc3339}</td>
                  </tr>
                ))
              ) : (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={4} className="px-3 py-4 text-center text-sm text-text-muted">
                    {t("sync.anomalies.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <SyncDeviceTimeline />

      <Sheet open={drillTenant !== null} onOpenChange={(o) => !o && setDrillTenant(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t("sync.drill.title")}</SheetTitle>
            <SheetDescription className="font-mono text-xs">
              {drillTenant?.tenant_id}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {drillRows.length === 0 ? (
              <p className="text-sm text-text-secondary">{t("sync.drill.empty")}</p>
            ) : (
              <ul className="space-y-3">
                {drillRows.map((r) => (
                  <li
                    key={r.idempotency_key}
                    className="rounded-md border border-surface-border bg-surface-1 p-3 text-xs"
                  >
                    <p className="font-mono font-semibold">{r.batch_id}</p>
                    <p className="mt-1 text-text-secondary">
                      {r.entity_type} · {r.failure_reason_code}
                    </p>
                    <p className="mt-1 font-mono text-text-muted">{r.idempotency_key}</p>
                    <p className="mt-1 text-text-secondary">
                      {t("sync.drill.attempts")}: {r.attempt_count} · {r.last_attempt_rfc3339}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";

import { worstSeverity } from "@/services/vendor-ops-contracts";
import {
  getPlatformOverview,
  getSyncOverview,
  type PlatformOverviewV1,
  type SyncOverviewV1,
} from "@/services/vendor-ops-telemetry-service";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OpsSeverityBadge } from "./opsSeverityBadge";
import { OpsAlertsPanel } from "./OpsAlertsPanel";

export function VendorConsoleOpsHubCard() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [sync, setSync] = useState<SyncOverviewV1 | null>(null);
  const [platform, setPlatform] = useState<PlatformOverviewV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [syncData, platformData] = await Promise.all([getSyncOverview(), getPlatformOverview()]);
      setSync(syncData);
      setPlatform(platformData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ops hub telemetry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const alerts = platform?.alerts ?? [];
  const openAlerts = useMemo(() => alerts.filter((a) => a.state === "open").length, [alerts]);
  const worst = useMemo(
    () =>
      alerts.length > 0
        ? alerts.reduce((acc, a) => worstSeverity(acc, a.severity), alerts[0]!.severity)
        : ("info" as const),
    [alerts],
  );

  return (
    <article className="rounded-lg border border-surface-border bg-surface-1 p-4 shadow-sm sm:col-span-2">
      <h3 className="text-sm font-semibold">{t("home.card.ops", "Operations hub")}</h3>
      <p className="mt-2 text-xs text-text-secondary">
        {t(
          "home.card.opsHint",
          "Unified sync, rollout, and platform alerts with ownership. Drill-through is tenant-safe.",
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-text-muted">{t("home.ops.openAlerts", "Open alerts")}</span>
        <span className="font-semibold">{openAlerts}</span>
        <OpsSeverityBadge severity={worst} label={t("home.ops.worst", "Worst: {{s}}", { s: worst })} />
        <span className="text-text-muted">{t("home.ops.dlq", "DLQ (aggregate)")}</span>
        <span className="font-mono text-xs">{sync?.aggregate.dead_letter_total ?? 0}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
          {loading ? t("home.ops.refreshing", "Refreshing…") : t("home.ops.refresh", "Refresh")}
        </Button>
      </div>
      {error ? (
        <div className="mt-2">
          <ConsoleStatusBanner tone="error" role="alert">
            {error}
          </ConsoleStatusBanner>
        </div>
      ) : null}
      <div className="mt-4 border-t border-surface-border pt-4">
        <OpsAlertsPanel alerts={alerts} compact />
        {!loading && alerts.length === 0 ? (
          <p className="mt-3 text-xs text-text-muted">{t("home.ops.empty", "No active ops alerts.")}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {can("platform.observe") ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/vendor-console/health">{t("home.drill.opsHealth", "Platform health & alerts")}</Link>
          </Button>
        ) : null}
        {can("sync.operate") ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/vendor-console/sync">{t("home.drill.opsSync", "Sync diagnostics")}</Link>
          </Button>
        ) : null}
        {can("rollout.manage") ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/vendor-console/rollouts">{t("home.drill.opsRollouts", "Rollout control")}</Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

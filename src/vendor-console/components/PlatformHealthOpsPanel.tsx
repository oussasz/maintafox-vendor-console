import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlatformOverview, type PlatformOverviewV1 } from "@/services/vendor-ops-telemetry-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OpsAlertsPanel } from "./OpsAlertsPanel";
import { OpsSeverityBadge } from "./opsSeverityBadge";
import { errorText } from "@/lib/error-text";

/** Services the platform overview reports (labels: vendorConsole `health.services.names.*`). */
const KNOWN_SERVICES = new Set(["api", "workers", "postgresql", "redis", "object_storage", "admin_ui", "backups"]);

export function PlatformHealthOpsPanel() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [overview, setOverview] = useState<PlatformOverviewV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setOverview(await getPlatformOverview());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview();
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[17px] font-bold text-text-primary">{t("health.pageTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t("health.pageBody")}
        </p>
      </header>

      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          <p>{error}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadOverview(true)}>
            {t("health.retry")}
          </Button>
        </ConsoleStatusBanner>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("health.services.title")}</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview(true)}>
            {refreshing ? t("health.refreshing") : t("health.refresh")}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {overview?.platform_services.length ? (
            overview.platform_services.map((s) => (
              <Card key={s.service}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{KNOWN_SERVICES.has(s.service) ? t(`health.services.names.${s.service}`) : s.service}</CardTitle>
                  <CardDescription className="flex items-center gap-2">
                    <OpsSeverityBadge severity={s.severity} />
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-text-secondary">{s.detail}</CardContent>
              </Card>
            ))
          ) : (
            <Card className="sm:col-span-2 lg:col-span-3">
              <CardContent className="py-6 text-center text-sm text-text-muted">
                {loading
                  ? t("health.loading")
                  : t("health.services.empty")}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("health.pressure.title")}</h2>
        <p className="text-xs text-text-secondary">
          {t("health.pressure.hint")}
        </p>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("health.pressure.col.metric")}</th>
                <th className="px-3 py-2">{t("health.pressure.col.value")}</th>
                <th className="px-3 py-2">{t("health.pressure.col.threshold")}</th>
                <th className="px-3 py-2">{t("health.pressure.col.trend")}</th>
              </tr>
            </thead>
            <tbody>
              {overview?.infra_pressure.length ? (
                overview.infra_pressure.map((p) => (
                  <tr key={p.metric_code} className="border-b border-surface-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{p.metric_code}</td>
                    <td className="px-3 py-2">
                      {p.value} {p.unit}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary">{p.threshold_hint}</td>
                    <td className="px-3 py-2 text-xs">{p.trend}</td>
                  </tr>
                ))
              ) : (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={4} className="px-3 py-4 text-center text-sm text-text-muted">
                    {t("health.pressure.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <OpsAlertsPanel alerts={overview?.alerts ?? []} />

      <section className="rounded-lg border border-dashed border-surface-border bg-surface-1/50 p-4">
        <h2 className="text-sm font-semibold">{t("health.drill.title")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t("health.drill.body")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {can("sync.operate") ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vendor-console/sync">{t("health.drill.sync")}</Link>
            </Button>
          ) : null}
          {can("rollout.manage") ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vendor-console/rollouts">{t("health.drill.rollouts")}</Link>
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

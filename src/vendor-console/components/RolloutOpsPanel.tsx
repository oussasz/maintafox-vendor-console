import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getRolloutOverview, type RolloutOverviewV1 } from "@/services/vendor-ops-telemetry-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";

const CATEGORY_LABEL: Record<string, string> = {
  download: "Download",
  signature_verification: "Signature",
  migration: "Migration",
  post_deploy_heartbeat: "Post-deploy HB",
};

export function RolloutOpsPanel() {
  const { t } = useTranslation("vendorConsole");
  const [overview, setOverview] = useState<RolloutOverviewV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setOverview(await getRolloutOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rollout telemetry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview();
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t("rollouts.pageTitle", "Rollout control")}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "rollouts.pageBody",
            "Cohort staging, pause/recall, and integrated failure diagnostics. Recall requires step-up and server approval.",
          )}
        </p>
      </header>

      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          <p>{error}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadOverview(true)}>
            {t("rollouts.retry", "Retry")}
          </Button>
        </ConsoleStatusBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("rollouts.impact.title", "Impact preview (next activation)")}</CardTitle>
          <CardDescription>{overview?.impact.release_id ?? "—"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.tenants", "Affected tenants")}</p>
            <p className="text-lg font-semibold">{overview?.impact.affected_tenants ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.machines", "Affected machines")}</p>
            <p className="text-lg font-semibold">{overview?.impact.affected_machines ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.channelOk", "Entitlement channel OK")}</p>
            <p className="text-lg font-semibold">{overview?.impact.entitlement_channel_ok ? "Yes" : "No"}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.blockers", "Known blockers")}</p>
            <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
              {(overview?.impact.known_blockers.length ? overview.impact.known_blockers : ["None"]).map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("rollouts.cohorts.title", "Channels & cohorts")}</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview(true)}>
            {refreshing ? t("rollouts.refreshing", "Refreshing…") : t("rollouts.refresh", "Refresh")}
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {overview?.cohort_stages.length ? (
            overview.cohort_stages.map((c) => (
              <Card key={`${c.channel}-${c.cohort_label}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{c.channel}</CardTitle>
                  <CardDescription>{c.cohort_label}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p>
                    {c.tenant_count} {t("rollouts.cohorts.tenants", "tenants")} · {c.machine_count}{" "}
                    {t("rollouts.cohorts.machines", "machines")}
                  </p>
                  <p className="text-xs uppercase text-text-muted">{c.governance}</p>
                  {c.paused_at_rfc3339 ? (
                    <p className="text-xs text-text-secondary">
                      {t("rollouts.cohorts.pausedAt", "Paused at")}: {c.paused_at_rfc3339}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled
                      title={t("stepUp.notAvailable")}
                    >
                      {t("rollouts.cohorts.pause", "Pause stage")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled
                      title={t("stepUp.notAvailable")}
                    >
                      {t("rollouts.cohorts.recall", "Recall")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-text-muted">
                {loading
                  ? t("rollouts.loading", "Loading rollout telemetry…")
                  : t("rollouts.cohorts.empty", "No cohorts available.")}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("rollouts.diagnostics.title", "Release diagnostics (24h)")}
        </h2>
        <p className="text-xs text-text-secondary">
          {t(
            "rollouts.diagnostics.hint",
            "Signature, migration, and post-deploy heartbeat failures in one view for containment decisions.",
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {overview?.diagnostics.length ? (
            overview.diagnostics.map((d) => (
              <Card key={d.category}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{CATEGORY_LABEL[d.category] ?? d.category}</CardTitle>
                  <CardDescription>
                    {t("rollouts.diagnostics.count", "{{n}} events", { n: d.count_24h })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-text-secondary">
                  <p>
                    {t("rollouts.diagnostics.last", "Last")}: {d.last_event_rfc3339 ?? "—"}
                  </p>
                  <p className="mt-2 font-mono">
                    {d.sample_correlation_ids.length ? d.sample_correlation_ids.join(", ") : "—"}
                  </p>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-text-muted">
                {t("rollouts.diagnostics.empty", "No rollout diagnostics available.")}
              </CardContent>
            </Card>
          )}
        </div>
      </section>
    </div>
  );
}

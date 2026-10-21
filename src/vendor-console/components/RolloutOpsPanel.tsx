import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { setRolloutGovernance, type RolloutGovernanceAction } from "@/services/license-control-service";
import { RELEASE_RINGS } from "@/services/release-catalog-service";
import { getRolloutOverview, type RolloutOverviewV1 } from "@/services/vendor-ops-telemetry-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";
import { errorText } from "@/lib/error-text";

type CohortStage = RolloutOverviewV1["cohort_stages"][number];

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
  const [success, setSuccess] = useState<string | null>(null);
  const [governance, setGovernance] = useState<{ stage: CohortStage; action: RolloutGovernanceAction } | null>(null);
  const [recalledVersion, setRecalledVersion] = useState("");
  const { requireStepUp } = useVendorConsole();

  /** Pause / resume: step-up rollout_publish; recall: forced_rollback. Audited server-side. */
  const runGovernance = async (reason: string) => {
    if (!governance) return;
    const { stage, action } = governance;
    setSuccess(null);
    const stepUpToken = await requireStepUp(action === "recall" ? StepUpKinds.forcedRollback : StepUpKinds.rolloutPublish);
    await setRolloutGovernance(stage.channel, stage.cohort_label, action, {
      reason_code: reason,
      step_up_token: stepUpToken,
      recalled_version: action === "recall" ? recalledVersion.trim() : undefined,
    });
    setSuccess(t(`rollouts.governance.done.${action}`, { cohort: `${stage.channel} / ${stage.cohort_label}` }));
    await loadOverview(true);
  };

  const loadOverview = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setOverview(await getRolloutOverview());
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

  /** "v2.1.0 · Pilot · 25%", or why there is nothing to show yet. */
  const releaseSummary = (impact: RolloutOverviewV1["impact"]) => {
    if (impact.release_version === null) return t("rollouts.impact.noRelease");
    const channel = impact.release_channel;
    const ring = channel && (RELEASE_RINGS as readonly string[]).includes(channel) ? t(`updates.releases.status.${channel}`) : (channel ?? "—");
    return t("rollouts.impact.release", { version: impact.release_version, ring, percent: impact.release_rollout_percent ?? 0 });
  };

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-[17px] font-bold text-text-primary">{t("rollouts.pageTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t("rollouts.pageBody")}
        </p>
      </header>

      <ConsoleStatusBanner tone="info" role="status">
        {t("rollouts.governance.deviceNotice")}
      </ConsoleStatusBanner>
      {success ? (
        <ConsoleStatusBanner tone="success" role="status">
          {success}
        </ConsoleStatusBanner>
      ) : null}
      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          <p>{error}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadOverview(true)}>
            {t("rollouts.retry")}
          </Button>
        </ConsoleStatusBanner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("rollouts.impact.title")}</CardTitle>
          <CardDescription>{overview ? releaseSummary(overview.impact) : "—"}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.tenants")}</p>
            <p className="text-lg font-semibold">{overview?.impact.affected_tenants ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.machines")}</p>
            <p className="text-lg font-semibold">{overview?.impact.affected_machines ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.channelOk")}</p>
            <p className="text-lg font-semibold">{overview?.impact.entitlement_channel_ok ? t("rollouts.impact.yes") : t("rollouts.impact.no")}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">{t("rollouts.impact.blockers")}</p>
            <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
              {(overview?.impact.known_blockers.length ? overview.impact.known_blockers : [t("rollouts.impact.noBlockers")]).map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("rollouts.cohorts.title")}</h2>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview(true)}>
            {refreshing ? t("rollouts.refreshing") : t("rollouts.refresh")}
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
                    {c.tenant_count} {t("rollouts.cohorts.tenants")} · {c.machine_count}{" "}
                    {t("rollouts.cohorts.machines")}
                  </p>
                  <p className="text-xs uppercase text-text-muted">{c.governance}</p>
                  {c.paused_at_rfc3339 ? (
                    <p className="text-xs text-text-secondary">
                      {t("rollouts.cohorts.pausedAt")}: {c.paused_at_rfc3339}
                    </p>
                  ) : null}
                  {c.recalled_version ? (
                    <p className="text-xs text-text-secondary">
                      {t("rollouts.cohorts.recalledVersion", { version: c.recalled_version })}
                    </p>
                  ) : null}
                  {c.governance_reason ? (
                    <p className="text-xs text-text-muted">{c.governance_reason}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2 pt-2">
                    {c.governance === "active" ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => setGovernance({ stage: c, action: "pause" })}>
                        {t("rollouts.cohorts.pause")}
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="secondary" onClick={() => setGovernance({ stage: c, action: "resume" })}>
                        {t("rollouts.cohorts.resume")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        setRecalledVersion(c.recalled_version ?? "");
                        setGovernance({ stage: c, action: "recall" });
                      }}
                    >
                      {t("rollouts.cohorts.recall")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-text-muted">
                {loading
                  ? t("rollouts.loading")
                  : t("rollouts.cohorts.empty")}
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("rollouts.diagnostics.title")}
        </h2>
        <p className="text-xs text-text-secondary">
          {t("rollouts.diagnostics.hint")}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {overview?.diagnostics.length ? (
            overview.diagnostics.map((d) => (
              <Card key={d.category}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{CATEGORY_LABEL[d.category] ?? d.category}</CardTitle>
                  <CardDescription>
                    {t("rollouts.diagnostics.count", { n: d.count_24h })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-xs text-text-secondary">
                  <p>
                    {t("rollouts.diagnostics.last")}: {d.last_event_rfc3339 ?? "—"}
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
                {t("rollouts.diagnostics.empty")}
              </CardContent>
            </Card>
          )}
        </div>
      </section>
      <OperatorActionDialog
        open={governance !== null}
        title={governance ? t(`rollouts.governance.${governance.action}.title`) : ""}
        description={
          governance
            ? t(`rollouts.governance.${governance.action}.body`, {
                cohort: `${governance.stage.channel} / ${governance.stage.cohort_label}`,
              })
            : ""
        }
        confirmLabel={governance ? t(`rollouts.governance.${governance.action}.confirm`) : ""}
        destructive={governance?.action === "recall"}
        extraValid={governance?.action !== "recall" || recalledVersion.trim().length > 0}
        onConfirm={runGovernance}
        onClose={() => setGovernance(null)}
      >
        {governance?.action === "recall" ? (
          <div className="grid gap-1">
            <Label htmlFor="recalled-version">{t("rollouts.governance.recall.versionLabel")}</Label>
            <Input
              id="recalled-version"
              autoComplete="off"
              maxLength={32}
              value={recalledVersion}
              onChange={(e) => setRecalledVersion(e.target.value)}
            />
          </div>
        ) : null}
      </OperatorActionDialog>
    </div>
  );
}

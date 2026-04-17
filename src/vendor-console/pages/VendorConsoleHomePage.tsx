import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";

import { VendorConsoleOpsHubCard } from "../components/VendorConsoleOpsHubCard";
import { isStepUpFresh, useVendorConsole } from "../VendorConsoleContext";

export function VendorConsoleHomePage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const { tenantSearch, openStepUp, stepUpValidUntilMs } = useVendorConsole();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("home.title", "Control plane overview")}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "home.subtitle",
            "Evidence-first summaries; each card links to underlying records (tenant, machine, batch, audit).",
          )}
        </p>
      </div>

      <section aria-labelledby="ops-cards" className="grid gap-4 sm:grid-cols-2">
        <h2 id="ops-cards" className="sr-only">
          {t("home.cardsAria", "Operational summaries")}
        </h2>

        {(can("sync.operate") || can("rollout.manage") || can("platform.observe")) && (
          <VendorConsoleOpsHubCard />
        )}

        <article className="rounded-lg border border-surface-border bg-surface-1 p-4 shadow-sm">
          <h3 className="text-sm font-semibold">{t("home.card.license", "License & machines")}</h3>
          <p className="mt-2 text-xs text-text-secondary">
            {t("home.card.licenseHint", "Drill to entitlement envelopes and activation rows.")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {can("customer.manage") && (
              <Button variant="outline" size="sm" asChild>
                <Link
                  to={`/vendor-console/customers${tenantSearch ? `?q=${encodeURIComponent(tenantSearch)}` : ""}`}
                >
                  {t("home.drill.customers", "Open customers")}
                </Link>
              </Button>
            )}
            {can("entitlement.manage") && (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/vendor-console/entitlements?evidence=tenant:last-active">
                    {t("home.drill.entitlements", "Evidence: last tenant")}
                  </Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/vendor-console/machines">{t("home.drill.machines", "Machines & heartbeats")}</Link>
                </Button>
              </>
            )}
          </div>
        </article>

        <article className="rounded-lg border border-surface-border bg-surface-1 p-4 shadow-sm">
          <h3 className="text-sm font-semibold">{t("home.card.sync", "Sync & rollouts")}</h3>
          <p className="mt-2 text-xs text-text-secondary">
            {t("home.card.syncHint", "Queue lag, replay, and rollout manifest integrity.")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {can("sync.operate") && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/vendor-console/sync?evidence=queue:materialization">
                  {t("home.drill.syncQueue", "Queue evidence")}
                </Link>
              </Button>
            )}
            {can("rollout.manage") && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/vendor-console/rollouts?evidence=manifest:current">
                  {t("home.drill.rollout", "Rollout manifest")}
                </Link>
              </Button>
            )}
            {can("audit.view") && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/vendor-console/audit">{t("home.drill.audit", "Audit & support")}</Link>
              </Button>
            )}
          </div>
        </article>
      </section>

      <section className="rounded-lg border border-dashed border-surface-border bg-surface-1/50 p-4">
        <h3 className="text-sm font-semibold">{t("home.stepUpLab.title", "Step-up (operator lab)")}</h3>
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            "home.stepUpLab.body",
            "Dangerous actions require fresh step-up. Server endpoints must re-validate; this is UX only.",
          )}
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" size="sm" variant="secondary" onClick={() => openStepUp("mass_machine_revoke")}>
            {t("home.stepUpLab.trigger", "Trigger step-up")}
          </Button>
          <span className="text-xs text-text-muted" aria-live="polite">
            {isStepUpFresh(stepUpValidUntilMs)
              ? t("home.stepUpLab.fresh", "Step-up window active")
              : t("home.stepUpLab.stale", "No active step-up window")}
          </span>
        </div>
      </section>
    </div>
  );
}

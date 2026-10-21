/**
 * Overview (2026 redesign): four key figures, what needs the operator first, a health summary and
 * the customers. Everything comes from GET /api/v1/console/overview; nothing is estimated.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { getConsoleOverview, type ConsoleOverview } from "@/services/console-dashboard-service";
import { getSessionInfo } from "@/services/vendor-auth-service";

import { AttentionList } from "../ui/AttentionList";
import { CustomerTable } from "../ui/CustomerTable";
import { formatDateTime } from "../ui/format";
import { FactRow, Headline, KpiTile, LoadError, Loading, PageHeader, Panel } from "../ui/kit";

function greetingKey(hour: number): string {
  if (hour < 12) return "overview.greeting.morning";
  if (hour < 18) return "overview.greeting.afternoon";
  return "overview.greeting.evening";
}

export function OverviewPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [data, setData] = useState<ConsoleOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getConsoleOverview());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    getSessionInfo()
      .then((s) => setName(s.user.display_name || s.user.email.split("@")[0] || null))
      // The greeting is a courtesy: without the name the page still says hello.
      .catch(() => setName(null));
  }, [load]);

  const f = data?.figures;
  const h = data?.health;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={name ? t(greetingKey(new Date().getHours()), { name }) : t("overview.title")}
        subtitle={t("overview.subtitle")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/vendor-console/customers">{t("overview.findCustomer")}</Link>
            </Button>
            {can("customer.manage") ? (
              <Button asChild>
                <Link to="/vendor-console/customers?new=1">{t("overview.newCustomer")}</Link>
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <Loading /> : null}

      {data && f && h ? (
        <>
          <section aria-label={t("overview.figures")} className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile label={t("overview.kpi.customers")} value={f.customers_active} hint={t("overview.kpi.customersHint", { count: f.customers_total })} />
            <KpiTile label={t("overview.kpi.devices")} value={f.devices_in_use} hint={t("overview.kpi.devicesHint", { count: f.seats_free })} />
            <KpiTile
              label={t("overview.kpi.expiring", { days: data.thresholds.licence_expiring_days })}
              value={f.licences_expiring}
              tone={f.licences_expiring > 0 ? "attention" : "neutral"}
              action={f.licences_expiring > 0 ? { label: t("overview.kpi.reviewRenewals"), to: "/vendor-console/customers?status=expires_soon" } : undefined}
              hint={f.licences_expiring > 0 ? undefined : t("overview.kpi.noneExpiring")}
            />
            <KpiTile
              label={t("overview.kpi.tickets")}
              value={f.open_tickets}
              action={can("support.manage") ? { label: t("overview.kpi.openSupport"), to: "/vendor-console/support" } : undefined}
            />
          </section>

          <div className="flex flex-wrap items-start gap-6">
            <Panel
              title={t("overview.attention")}
              labelledBy="attention-h"
              aside={<span className="text-[13px] text-text-secondary">{t("overview.items", { count: data.attention.length })}</span>}
              className="min-w-0 flex-[2_1_480px]"
            >
              <AttentionList items={data.attention} />
            </Panel>

            <Panel
              title={t("overview.health")}
              labelledBy="health-h"
              aside={
                can("platform.observe") ? (
                  <Link to="/vendor-console/health" className="text-[13px] font-semibold text-primary hover:underline">
                    {t("overview.healthDetails")}
                  </Link>
                ) : null
              }
              className="min-w-0 flex-[1_1_280px]"
            >
              <Headline tone={h.status === "ok" ? "ok" : "attention"} title={t(h.status === "ok" ? "sysHealth.allOk" : "sysHealth.needsLook")} />
              <FactRow label={t("sysHealth.server")} value={t("sysHealth.online")} />
              <FactRow
                label={t("sysHealth.lastBackup")}
                value={
                  h.last_backup_at
                    ? h.backup_encrypted
                      ? t("sysHealth.backupAtEncrypted", { at: formatDateTime(h.last_backup_at) })
                      : formatDateTime(h.last_backup_at)
                    : t("sysHealth.never")
                }
              />
              <FactRow
                label={t("sysHealth.lastRestoreTest")}
                value={
                  h.last_restore_test_status === "failed"
                    ? t("sysHealth.failed")
                    : h.last_restore_test_at
                      ? t("sysHealth.passedOn", { at: formatDateTime(h.last_restore_test_at) })
                      : t("sysHealth.never")
                }
              />
              <FactRow label={t("sysHealth.devicesSyncing")} value={t("sysHealth.nOfM", { n: h.devices_syncing, m: h.devices_total })} />
            </Panel>
          </div>

          <Panel title={t("overview.customers")} labelledBy="cust-h">
            <CustomerTable customers={data.customers} searchId="overview-customer-search" />
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/**
 * One customer (2026 redesign): who they are and where they stand, then tabs — Overview (licence,
 * seats, data sync, devices, sensitive actions), Licence and billing, Data sync, Support, History.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { getConsoleOverview, type CustomerRow } from "@/services/console-dashboard-service";
import {
  listTenantActivations,
  listTenants,
  resumeTenant,
  suspendTenant,
  type ActivationRow,
  type ControlTenant,
} from "@/services/license-control-service";

import { AuditLedgerPanel } from "../components/AuditLedgerPanel";
import { BillingPanel } from "../components/BillingPanel";
import { EntitlementLifecyclePanel } from "../components/EntitlementLifecyclePanel";
import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { DeletedAttachmentsPanel } from "../components/DeletedAttachmentsPanel";
import { SyncDeviceTimeline } from "../components/SyncDeviceTimeline";
import { CustomerFormDialog } from "../customers/CustomerFormDialog";
import { CustomerSupportTab } from "../customers/CustomerSupportTab";
import { DeleteCustomerDialog } from "../customers/DeleteCustomerDialog";
import { DeviceList } from "../devices/DeviceList";
import { OfflineRulesPanel } from "../devices/OfflineRulesPanel";
import { useVendorConsole } from "../VendorConsoleContext";
import { customerStatusKey, customerStatusTone } from "../ui/customer-status";
import { formatAgo, formatDate } from "../ui/format";
import { EmptyState, LoadError, Loading, Notice, Panel, StatusPill } from "../ui/kit";

const TABS = ["overview", "licence", "sync", "support", "history"] as const;
type Tab = (typeof TABS)[number];
const DAY_MS = 86_400_000;
const NOT_SEEN_ATTENTION_MS = DAY_MS;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

export function CustomerPage() {
  const { tenantId = "" } = useParams();
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const { requireStepUp } = useVendorConsole();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview";
  const focusDevice = params.get("device");
  const [tenant, setTenant] = useState<ControlTenant | null>(null);
  const [row, setRow] = useState<CustomerRow | null>(null);
  const [devices, setDevices] = useState<ActivationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [suspension, setSuspension] = useState<"suspend" | "resume" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tenants, overview, activations] = await Promise.all([listTenants(), getConsoleOverview(), listTenantActivations(tenantId)]);
      const found = tenants.find((x) => x.id === tenantId) ?? null;
      setNotFound(found === null);
      setTenant(found);
      setRow(overview.customers.find((c) => c.tenant_id === tenantId) ?? null);
      setDevices(activations);
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const goTab = (next: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (next !== "overview") p.set("tab", next);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    setParams(p, { replace: true });
  };

  const sync = useMemo(() => {
    const active = (devices ?? []).filter((d) => d.trusted_device);
    const seen = active.map((d) => (d.last_heartbeat_rfc3339 ? Date.parse(d.last_heartbeat_rfc3339) : NaN)).filter(Number.isFinite);
    const nowMs = Date.now();
    return { active: active.length, behind: seen.filter((ms) => nowMs - ms > NOT_SEEN_ATTENTION_MS).length, last: seen.length ? new Date(Math.max(...seen)).toISOString() : null };
  }, [devices]);

  const runSuspension = async (reason: string) => {
    if (!tenant || !suspension) return;
    const privileged = {
      reason_code: reason,
      step_up_token: await requireStepUp(suspension === "suspend" ? StepUpKinds.entitlementSuspension : StepUpKinds.tenantRestore),
    };
    if (suspension === "suspend") await suspendTenant(tenant.id, privileged);
    else await resumeTenant(tenant.id, privileged);
    setSuccess(t(`customers.${suspension}Done`, { name: tenant.display_name }));
    await load();
  };

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (notFound) {
    return (
      <EmptyState
        title={t("customer.notFound.title")}
        body={t("customer.notFound.body")}
        action={
          <Button asChild variant="outline">
            <Link to="/vendor-console/customers">{t("customer.back")}</Link>
          </Button>
        }
      />
    );
  }
  if (!tenant || !devices) return <Loading />;

  // Suspended as the server decides it (suspend/resume check is_active), so an older row that is
  // inactive without a suspension date still offers "Lift suspension".
  const suspended = tenant.is_active !== undefined ? tenant.is_active !== 1 : Boolean(tenant.suspended_at);
  const status = row?.status ?? (suspended ? "suspended" : "unknown");
  const needsLicence = status === "expires_soon" || status === "expired" || status === "no_licence";
  const seatsUsedPct = row && row.seats > 0 ? Math.min(100, Math.round((row.devices_used / row.seats) * 100)) : 0;

  return (
    <div className="flex flex-col gap-5">
      <Link to="/vendor-console/customers" className="text-sm font-semibold text-primary hover:underline">
        ← {t("customer.back")}
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-surface-border bg-surface-1 px-[22px] py-5">
        <div className="flex items-center gap-4">
          <div aria-hidden="true" className="flex h-[52px] w-[52px] items-center justify-center rounded-xl bg-primary-bg text-xl font-bold text-primary">
            {initials(tenant.display_name)}
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold text-text-primary">{tenant.display_name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <StatusPill tone={customerStatusTone(status)}>{t(customerStatusKey(status))}</StatusPill>
              {row ? <span>{t("customer.edition", { edition: row.edition_label })}</span> : null}
              {row?.customer_since ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t("customer.since", { date: formatDate(row.customer_since) })}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {can("customer.manage") ? (
            <Button type="button" variant="outline" onClick={() => setEditing(true)}>
              {t("customer.editDetails")}
            </Button>
          ) : null}
          {needsLicence && can("entitlement.manage") ? (
            <Button type="button" onClick={() => goTab("licence")}>
              {status === "no_licence" ? t("customer.addLicence") : t("customer.renewLicence")}
            </Button>
          ) : null}
        </div>
      </header>

      {success ? <Notice tone="ok">{success}</Notice> : null}

      <Tabs value={tab} onValueChange={(v) => goTab(v)}>
        <TabsList aria-label={t("customer.tabsAria")}>
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`customer.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex flex-col gap-1.5 rounded-xl border border-surface-border bg-surface-1 px-5 py-[18px]">
              <span className="text-[13px] font-medium text-text-secondary">{t("customer.tiles.licence")}</span>
              <span className="text-[22px] font-bold text-text-primary">
                {row?.licence_until
                  ? t("customer.tiles.validUntil", { date: formatDate(row.licence_until) })
                  : row?.licence_never_ends
                    ? t("customer.tiles.noEnd")
                    : row?.licence_ended_at
                      ? t("customer.tiles.ended", { date: formatDate(row.licence_ended_at) })
                      : t("customer.tiles.noLicence")}
              </span>
              {row?.licence_until ? (
                <span className="text-[13px] text-text-secondary">
                  {t("customer.tiles.daysLeft", { count: Math.max(0, Math.ceil((Date.parse(row.licence_until) - Date.now()) / DAY_MS)) })}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl border border-surface-border bg-surface-1 px-5 py-[18px]">
              <span className="text-[13px] font-medium text-text-secondary">{t("customer.tiles.devices")}</span>
              <span className="text-[22px] font-bold text-text-primary">{t("customer.tiles.seatsUsed", { used: row?.devices_used ?? 0, seats: row?.seats ?? 0 })}</span>
              <div
                role="progressbar"
                aria-label={t("customer.tiles.seatsBar")}
                aria-valuenow={seatsUsedPct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 overflow-hidden rounded bg-surface-3"
              >
                <div className="h-2 bg-primary" style={{ width: `${seatsUsedPct}%` }} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5 rounded-xl border border-surface-border bg-surface-1 px-5 py-[18px]">
              <span className="text-[13px] font-medium text-text-secondary">{t("customer.tiles.sync")}</span>
              <span className={sync.behind > 0 ? "text-[22px] font-bold text-attention-strong" : "text-[22px] font-bold text-text-primary"}>
                {sync.active === 0 ? t("customer.tiles.noDevices") : sync.behind > 0 ? t("customer.tiles.behind", { count: sync.behind }) : t("customer.tiles.upToDate")}
              </span>
              {sync.last ? <span className="text-[13px] text-text-secondary">{t("customer.tiles.lastContact", { ago: formatAgo(sync.last) })}</span> : null}
            </div>
          </div>

          <Panel title={t("customer.devices")} labelledBy="customer-devices-h">
            <DeviceList tenantId={tenant.id} onSeeHistory={can("sync.operate") ? (machineId) => goTab("sync", { device: machineId }) : undefined} />
          </Panel>

          {can("customer.manage") ? (
            <section aria-labelledby="danger-h" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-surface-border bg-surface-1 px-[22px] py-5">
              <div className="flex flex-[1_1_320px] flex-col gap-1">
                <h2 id="danger-h" className="text-[15px] font-bold text-text-primary">
                  {t("customer.sensitive.title")}
                </h2>
                <span className="text-[13px] text-text-secondary">{t("customer.sensitive.body")}</span>
              </div>
              <div className="flex flex-wrap gap-2.5">
                <Button type="button" variant="outline" onClick={() => setSuspension(suspended ? "resume" : "suspend")}>
                  {suspended ? t("customers.resumeTenant") : t("customers.suspendTenant")}
                </Button>
                {can("entitlement.manage") ? (
                  <Button type="button" variant="destructive-outline" onClick={() => goTab("licence")}>
                    {t("customer.sensitive.revokeLicence")}
                  </Button>
                ) : null}
                <Button type="button" variant="destructive-outline" onClick={() => setDeleting(true)}>
                  {t("customer.sensitive.delete")}
                </Button>
              </div>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="licence" className="flex flex-col gap-5">
          {can("entitlement.manage") ? <EntitlementLifecyclePanel fixedTenantId={tenant.id} /> : null}
          {can("customer.manage") ? <BillingPanel fixedTenantId={tenant.id} /> : null}
          <OfflineRulesPanel tenantId={tenant.id} />
        </TabsContent>

        <TabsContent value="sync">
          {can("sync.operate") ? (
            <div className="flex flex-col gap-5">
              <Panel>
                <SyncDeviceTimeline fixedTenantId={tenant.id} initialMachineId={focusDevice} />
              </Panel>
              <Panel>
                <DeletedAttachmentsPanel tenantId={tenant.id} />
              </Panel>
            </div>
          ) : (
            <EmptyState title={t("customer.sync.noAccess")} />
          )}
        </TabsContent>

        <TabsContent value="support">
          <CustomerSupportTab tenantId={tenant.id} />
        </TabsContent>

        <TabsContent value="history">
          {can("audit.view") ? (
            <Panel title={t("customer.history.title")} labelledBy="customer-history-h">
              <p className="text-[13px] text-text-secondary">{t("customer.history.body")}</p>
              <AuditLedgerPanel scopeQuery={tenant.id} />
            </Panel>
          ) : (
            <EmptyState title={t("customer.history.noAccess")} />
          )}
        </TabsContent>
      </Tabs>

      <CustomerFormDialog
        open={editing}
        tenant={tenant}
        onClose={() => setEditing(false)}
        onSaved={(saved) => {
          setEditing(false);
          setSuccess(t("customers.updatedDone", { name: saved.display_name }));
          void load();
        }}
      />
      <DeleteCustomerDialog
        tenant={deleting ? tenant : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => navigate("/vendor-console/customers", { replace: true })}
      />
      <OperatorActionDialog
        open={suspension !== null}
        title={suspension ? t(`customers.${suspension}Dialog.title`) : ""}
        description={suspension ? t(`customers.${suspension}Dialog.body`, { name: tenant.display_name }) : ""}
        confirmLabel={suspension ? t(`customers.${suspension}Dialog.confirm`) : ""}
        destructive={suspension === "suspend"}
        onConfirm={runSuspension}
        onClose={() => setSuspension(null)}
      />
    </div>
  );
}

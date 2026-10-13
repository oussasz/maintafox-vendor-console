/**
 * Devices: the desktops of one customer at a time with their status and actions, how sync goes on
 * every customer (measured by the server), and a tool to test an activation.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { listTenants, type ControlTenant } from "@/services/license-control-service";

import { SyncHealthPanel } from "../components/SyncHealthPanel";
import { ActivationTestPanel } from "../devices/ActivationTestPanel";
import { DeviceList } from "../devices/DeviceList";
import { EmptyState, LoadError, Loading, PageHeader, Panel } from "../ui/kit";

const selectClass = "h-11 w-full max-w-sm rounded-lg border border-input bg-white pl-3 pr-9 text-sm text-text-primary";

export function DevicesPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const [tenants, setTenants] = useState<ControlTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabs = ["devices", can("sync.operate") ? "sync" : null, can("entitlement.manage") ? "test" : null].filter((x): x is string => x !== null);
  const requested = params.get("tab");
  const tab = requested && tabs.includes(requested) ? requested : "devices";
  const tenantId = params.get("customer") ?? tenants?.[0]?.id ?? "";

  const load = () => {
    setError(null);
    listTenants()
      .then(setTenants)
      .catch((err: unknown) => setError(errorText(err)));
  };
  useEffect(load, []);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.devices")} subtitle={t("devices.subtitle")} />
      <Tabs value={tab} onValueChange={(v) => setParam("tab", v)}>
        <TabsList aria-label={t("devices.tabsAria")}>
          {tabs.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`devices.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="devices">
          {error ? <LoadError message={error} onRetry={load} /> : null}
          {!tenants && !error ? <Loading /> : null}
          {tenants && tenants.length === 0 ? <EmptyState title={t("devices.noCustomers.title")} body={t("devices.noCustomers.body")} /> : null}
          {tenants && tenants.length > 0 ? (
            <Panel>
              <div className="grid gap-1.5">
                <Label htmlFor="devices-customer">{t("devices.customer")}</Label>
                <select id="devices-customer" className={selectClass} value={tenantId} onChange={(e) => setParam("customer", e.target.value)}>
                  {tenants.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.display_name}
                    </option>
                  ))}
                </select>
              </div>
              {tenantId ? <DeviceList key={tenantId} tenantId={tenantId} /> : null}
            </Panel>
          ) : null}
        </TabsContent>
        <TabsContent value="sync">
          <SyncHealthPanel />
        </TabsContent>
        <TabsContent value="test">
          <ActivationTestPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

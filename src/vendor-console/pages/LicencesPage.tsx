/**
 * Licences and editions: licence keys of every customer, the edition catalogue (which modules each
 * edition opens), and payments. Per-customer work is also on the customer page.
 */
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";

import { BillingPanel } from "../components/BillingPanel";
import { EntitlementLifecyclePanel } from "../components/EntitlementLifecyclePanel";
import { PageHeader } from "../ui/kit";
import { VendorConsoleEditionsPage } from "./VendorConsoleEditionsPage";

export function LicencesPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tabs = [
    can("entitlement.manage") ? "keys" : null,
    can("entitlement.manage") ? "editions" : null,
    can("customer.manage") ? "payments" : null,
  ].filter((x): x is string => x !== null);
  const requested = params.get("tab");
  const tab = requested && tabs.includes(requested) ? requested : (tabs[0] ?? "keys");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.licences")} subtitle={t("licences.subtitle")} />
      <Tabs value={tab} onValueChange={(v) => setParams(v === tabs[0] ? {} : { tab: v }, { replace: true })}>
        <TabsList aria-label={t("licences.tabsAria")}>
          {tabs.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`licences.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="keys">
          <EntitlementLifecyclePanel />
        </TabsContent>
        <TabsContent value="editions">
          <VendorConsoleEditionsPage />
        </TabsContent>
        <TabsContent value="payments">
          <BillingPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

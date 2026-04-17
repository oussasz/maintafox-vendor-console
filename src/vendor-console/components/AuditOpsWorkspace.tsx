import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AuditLedgerPanel } from "./AuditLedgerPanel";
import { ConsoleHardeningPanel } from "./ConsoleHardeningPanel";
import { SupportOperationsPanel } from "./SupportOperationsPanel";

export function AuditOpsWorkspace() {
  const { t } = useTranslation("vendorConsole");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t("audit.pageTitle", "Audit, support & hardening")}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "audit.pageBody",
            "Immutable audit trail, support workflows, and operational safeguards. Requires audit.view; mutations are enforced server-side.",
          )}
        </p>
      </header>

      <Tabs defaultValue="ledger" className="w-full">
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="ledger">{t("audit.tabs.ledger", "Audit ledger")}</TabsTrigger>
          <TabsTrigger value="support">{t("audit.tabs.support", "Support")}</TabsTrigger>
          <TabsTrigger value="harden">{t("audit.tabs.harden", "Hardening & drills")}</TabsTrigger>
        </TabsList>
        <TabsContent value="ledger" className="mt-4">
          <AuditLedgerPanel />
        </TabsContent>
        <TabsContent value="support" className="mt-4">
          <SupportOperationsPanel />
        </TabsContent>
        <TabsContent value="harden" className="mt-4">
          <ConsoleHardeningPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

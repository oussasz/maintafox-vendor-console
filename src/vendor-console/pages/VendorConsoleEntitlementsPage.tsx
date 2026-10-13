import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  EntitlementLifecyclePanel,
  type EntitlementLifecyclePanelCapabilities,
  type EntitlementLifecyclePanelHandle,
} from "../components/EntitlementLifecyclePanel";

export function VendorConsoleEntitlementsPage() {
  const { t } = useTranslation("vendorConsole");
  const panelRef = useRef<EntitlementLifecyclePanelHandle>(null);
  const [capabilities, setCapabilities] = useState<EntitlementLifecyclePanelCapabilities>({
    canIssueKey: false,
    loadingLicenses: false,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("entitlements.pageTitle")}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("entitlements.pageBody")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={!capabilities.canIssueKey}
            onClick={() => panelRef.current?.openIssueDialog()}
          >
            {t("entitlement.addKey")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={capabilities.loadingLicenses}
            onClick={() => void panelRef.current?.refreshLicenses()}
          >
            {capabilities.loadingLicenses
              ? t("entitlement.refreshing")
              : t("entitlement.refresh")}
          </Button>
        </div>
      </header>
      <EntitlementLifecyclePanel
        ref={panelRef}
        hideSectionToolbar
        onCapabilitiesChange={setCapabilities}
      />
    </div>
  );
}

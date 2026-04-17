import { useTranslation } from "react-i18next";

import { EntitlementLifecyclePanel } from "../components/EntitlementLifecyclePanel";

export function VendorConsoleEntitlementsPage() {
  const { t } = useTranslation("vendorConsole");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t("entitlements.pageTitle", "Entitlements")}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "entitlements.pageBody",
            "State-governed lifecycle, signed-claim preview, and auditable approval for destructive changes.",
          )}
        </p>
      </header>
      <EntitlementLifecyclePanel />
    </div>
  );
}

/**
 * Support: tickets (from operators and from devices), interventions, diagnostic files, offline
 * reconciliation and compliance exports.
 */
import { useTranslation } from "react-i18next";

import { SupportOperationsPanel } from "../components/SupportOperationsPanel";
import { PageHeader } from "../ui/kit";

export function SupportPage() {
  const { t } = useTranslation("vendorConsole");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.support")} subtitle={t("support.subtitle")} />
      <SupportOperationsPanel />
    </div>
  );
}

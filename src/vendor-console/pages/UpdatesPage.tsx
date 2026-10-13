/**
 * Updates: rollout groups (pause, resume, recall) and forced minimum versions per customer or
 * group. Devices act on pause and recall once the desktop updater exists (Phase 5).
 */
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { RolloutOpsPanel } from "../components/RolloutOpsPanel";
import { ForceUpdatePanel } from "../sections/ForceUpdatePanel";
import { PageHeader } from "../ui/kit";

export function UpdatesPage() {
  const { t } = useTranslation("vendorConsole");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.updates")} subtitle={t("updates.subtitle")} />
      <Tabs defaultValue="rollouts">
        <TabsList aria-label={t("updates.tabsAria")}>
          <TabsTrigger value="rollouts">{t("updates.tabs.rollouts")}</TabsTrigger>
          <TabsTrigger value="forced">{t("updates.tabs.forced")}</TabsTrigger>
        </TabsList>
        <TabsContent value="rollouts">
          <RolloutOpsPanel />
        </TabsContent>
        <TabsContent value="forced">
          <ForceUpdatePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

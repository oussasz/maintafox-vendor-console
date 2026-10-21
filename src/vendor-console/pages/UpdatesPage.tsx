/**
 * Updates: the release catalog (publish a version to a ring and a share of its devices, recall it,
 * the release workflow's keys), rollout groups (pause, resume, recall) and forced minimum versions
 * per customer or group.
 */
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { RolloutOpsPanel } from "../components/RolloutOpsPanel";
import { ForceUpdatePanel } from "../sections/ForceUpdatePanel";
import { ReleaseCatalogPanel } from "../sections/ReleaseCatalogPanel";
import { ReleasePublisherKeysPanel } from "../sections/ReleasePublisherKeysPanel";
import { PageHeader } from "../ui/kit";

export function UpdatesPage() {
  const { t } = useTranslation("vendorConsole");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.updates")} subtitle={t("updates.subtitle")} />
      <Tabs defaultValue="releases">
        <TabsList aria-label={t("updates.tabsAria")}>
          <TabsTrigger value="releases">{t("updates.tabs.releases")}</TabsTrigger>
          <TabsTrigger value="rollouts">{t("updates.tabs.rollouts")}</TabsTrigger>
          <TabsTrigger value="forced">{t("updates.tabs.forced")}</TabsTrigger>
        </TabsList>
        <TabsContent value="releases" className="flex flex-col gap-5">
          <ReleaseCatalogPanel />
          <ReleasePublisherKeysPanel />
        </TabsContent>
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

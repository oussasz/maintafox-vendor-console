/**
 * Settings and team: console operators and their roles, the audit log of every action, the
 * safeguards (step-up actions, runbooks, readiness checks) and the display (light or dark theme, for
 * every role). Language, theme and the own account (password, recovery codes, sign-out) are also at
 * the top right of every page.
 */
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { ThemeChoice } from "@/components/ThemeToggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/use-permissions";

import { AuditLedgerPanel } from "../components/AuditLedgerPanel";
import { ConsoleHardeningPanel } from "../components/ConsoleHardeningPanel";
import { OperatorsPanel } from "../components/OperatorsPanel";
import { PageHeader, Panel } from "../ui/kit";

export function SettingsPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tabs = [can("operator.manage") ? "team" : null, can("audit.view") ? "audit" : null, can("audit.view") ? "safeguards" : null, "display"].filter(
    (x): x is string => x !== null,
  );
  const requested = params.get("tab");
  const tab = requested && tabs.includes(requested) ? requested : tabs[0];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("nav.settings")} subtitle={t("settings.subtitle")} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList aria-label={t("settings.tabsAria")}>
          {tabs.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t(`settings.tabs.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="team">
          <OperatorsPanel />
        </TabsContent>
        <TabsContent value="audit">
          <Panel title={t("settings.audit.title")} labelledBy="settings-audit-h">
            <AuditLedgerPanel />
          </Panel>
        </TabsContent>
        <TabsContent value="safeguards">
          <ConsoleHardeningPanel />
        </TabsContent>
        <TabsContent value="display">
          <Panel title={t("settings.display.title")} labelledBy="settings-display-h">
            <ThemeChoice />
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}

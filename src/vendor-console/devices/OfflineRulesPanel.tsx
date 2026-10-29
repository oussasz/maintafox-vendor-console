/**
 * How long the devices of one customer may work offline, and what a trust revocation does. Each
 * change asks for a reason and an authenticator code (step-up offline_policy_change).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { getTenantOfflinePolicy, updateTenantOfflinePolicy, type OfflinePolicy } from "@/services/license-control-service";

import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { useVendorConsole } from "../VendorConsoleContext";
import { FactRow, LoadError, Loading, Notice, Panel } from "../ui/kit";

/** Hours added to the offline grace window by "Extend grace". */
const GRACE_EXTENSION_HOURS = 12;

export function OfflineRulesPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const { requireStepUp } = useVendorConsole();
  const [policy, setPolicy] = useState<OfflinePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [action, setAction] = useState<"extendGrace" | "toggleTrust" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPolicy(await getTenantOfflinePolicy(tenantId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (reason: string) => {
    if (!policy || !action) return;
    setSuccess(null);
    const updated = await updateTenantOfflinePolicy(
      tenantId,
      {
        offline_grace_hours: policy.grace_hours + (action === "extendGrace" ? GRACE_EXTENSION_HOURS : 0),
        trust_revocation_disconnects_immediately:
          action === "toggleTrust" ? !policy.trust_revocation_disconnects_immediately : policy.trust_revocation_disconnects_immediately,
        reconnect_requires_fresh_heartbeat: policy.reconnect_requires_fresh_heartbeat,
      },
      { reason_code: reason, step_up_token: await requireStepUp(StepUpKinds.offlinePolicyChange) },
    );
    setPolicy(updated);
    setSuccess(action === "extendGrace" ? t("machines.graceExtended", { hours: updated.grace_hours }) : t("machines.trustRuleUpdated"));
  };

  return (
    <Panel title={t("devices.offline.title")} labelledBy="offline-rules-h">
      <p className="text-[13px] text-text-secondary">{t("devices.offline.body")}</p>
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {!policy && !error ? <Loading /> : null}
      {policy ? (
        <>
          <FactRow label={t("devices.offline.grace")} value={t("devices.offline.hours", { count: policy.grace_hours })} />
          <FactRow
            label={t("devices.offline.trustRevoke")}
            value={policy.trust_revocation_disconnects_immediately ? t("devices.offline.atOnce") : t("devices.offline.atNextCheck")}
          />
          <FactRow label={t("devices.offline.reconnect")} value={policy.reconnect_requires_fresh_heartbeat ? t("machines.yes") : t("machines.no")} />
          {success ? <Notice tone="ok">{success}</Notice> : null}
          {can("entitlement.manage") ? (
            <div className="flex flex-wrap gap-2.5">
              <Button type="button" variant="outline" size="sm" onClick={() => setAction("extendGrace")}>
                {t("machines.extendGrace", { hours: GRACE_EXTENSION_HOURS })}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setAction("toggleTrust")}>
                {t("machines.toggleTrustRule")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <OperatorActionDialog
        open={action !== null}
        title={action ? t(`machines.policyDialog.${action}.title`) : ""}
        description={action ? t(`machines.policyDialog.${action}.body`, { hours: GRACE_EXTENSION_HOURS }) : ""}
        confirmLabel={action ? t(`machines.policyDialog.${action}.confirm`) : ""}
        onConfirm={run}
        onClose={() => setAction(null)}
      />
    </Panel>
  );
}

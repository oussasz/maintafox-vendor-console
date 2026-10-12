import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  claimActivation,
  getTenantOfflinePolicy,
  listTenantActivations,
  listTenants,
  rebindMachine,
  reinstateMachine,
  releaseMachineSlot,
  requestMachinePolicyRefresh,
  revokeMachine,
  updateTenantOfflinePolicy,
  type ActivationRow,
  type ControlTenant,
  type OfflinePolicy,
} from "@/services/license-control-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { useVendorConsole } from "../VendorConsoleContext";

export function MachineActivationPanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [rows, setRows] = useState<ActivationRow[]>([]);
  const [policy, setPolicy] = useState<OfflinePolicy | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveSuccess, setLiveSuccess] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [machineFingerprint, setMachineFingerprint] = useState("");
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [claimResult, setClaimResult] = useState<null | {
    tenant_id: string;
    license_id: string;
    machine_fingerprint: string;
    force_update_required?: boolean;
  }>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const [slotAction, setSlotAction] = useState<{
    row: ActivationRow;
    action: "revoke" | "reinstate" | "release" | "rebind" | "refresh";
  } | null>(null);
  const [rebindTarget, setRebindTarget] = useState("");
  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  // Keeps the current selection; selects the first tenant only when none is selected yet.
  const loadTenants = useCallback(async () => {
    const list = await listTenants();
    setTenants(list);
    setSelectedTenantId((current) => current || (list[0]?.id ?? ""));
  }, []);

  const loadRowsAndPolicy = async (tenantId: string) => {
    if (!tenantId) {
      setRows([]);
      setPolicy(null);
      return;
    }
    setLoadingRows(true);
    setLiveError(null);
    try {
      const [activationRows, offlinePolicy] = await Promise.all([
        listTenantActivations(tenantId),
        getTenantOfflinePolicy(tenantId),
      ]);
      setRows(activationRows);
      setPolicy(offlinePolicy);
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : "Failed to load machine state");
    } finally {
      setLoadingRows(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        await loadTenants();
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : "Failed to load tenants");
      }
    })();
  }, [loadTenants]);

  useEffect(() => {
    void loadRowsAndPolicy(selectedTenantId);
  }, [selectedTenantId]);

  /**
   * Revoke / reinstate / release / rebind (step-up machine_trust_change) and policy refresh
   * (audited, no step-up). The operator's reason goes to the audit ledger.
   */
  const runSlotAction = async (reason: string) => {
    if (!slotAction) return;
    const { row, action } = slotAction;
    setLiveError(null);
    setLiveSuccess(null);
    if (action === "refresh") {
      await requestMachinePolicyRefresh(row.tenant_id, row.machine_id, reason);
      setLiveSuccess(t("machines.refreshRequested"));
    } else {
      const privileged = { reason_code: reason, step_up_token: await requireStepUp(StepUpKinds.machineTrustChange) };
      if (action === "revoke") {
        await revokeMachine(row.tenant_id, row.machine_id, reason, privileged);
        setLiveSuccess(t("machines.revoked", "Device revoked."));
      } else if (action === "reinstate") {
        await reinstateMachine(row.tenant_id, row.machine_id, reason, privileged);
        setLiveSuccess(t("machines.reinstated", "Device reinstated."));
      } else if (action === "release") {
        await releaseMachineSlot(row.tenant_id, row.machine_id, privileged);
        setLiveSuccess(t("machines.released"));
      } else {
        await rebindMachine(row.tenant_id, row.machine_id, rebindTarget.trim(), privileged);
        setLiveSuccess(t("machines.rebound", { fingerprint: rebindTarget.trim() }));
      }
    }
    await loadRowsAndPolicy(row.tenant_id);
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{t("machines.title", "Machines & activation")}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "machines.intro",
            "Heartbeat visibility, trusted-device lifecycle, and offline-policy controls. Actions require step-up and server enforcement.",
          )}
        </p>
      </header>

      {liveError ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {liveError}
        </ConsoleStatusBanner>
      ) : null}
      {liveSuccess ? <ConsoleStatusBanner tone="success">{liveSuccess}</ConsoleStatusBanner> : null}

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("machines.offlinePolicy", "Offline policy (read model)")}</h2>
        <div className="mt-2">
          <Label htmlFor="machine-tenant">{t("machines.tenant", "Tenant")}</Label>
          <select
            id="machine-tenant"
            className="mt-1 flex h-10 w-full max-w-md rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
            value={selectedTenantId}
            onChange={(e) => setSelectedTenantId(e.target.value)}
          >
            {tenants.length === 0 ? <option value="">{t("machines.noTenants", "No tenants")}</option> : null}
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.slug} ({tenant.id})
              </option>
            ))}
          </select>
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-muted">{t("machines.graceHours", "Grace hours")}</dt>
            <dd>{policy?.grace_hours ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-text-muted">{t("machines.trustRevoke", "Trust revoke disconnects")}</dt>
            <dd>
              {policy
                ? policy.trust_revocation_disconnects_immediately
                  ? t("machines.yes", "Yes")
                  : t("machines.no", "No")
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">{t("machines.reconnectFreshHb", "Reconnect needs fresh heartbeat")}</dt>
            <dd>
              {policy
                ? policy.reconnect_requires_fresh_heartbeat
                  ? t("machines.yes", "Yes")
                  : t("machines.no", "No")
                : "—"}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!policy || policyBusy || !selectedTenantId}
            onClick={async () => {
              if (!policy || !selectedTenantId) return;
              setPolicyBusy(true);
              setLiveError(null);
              setLiveSuccess(null);
              try {
                const updated = await updateTenantOfflinePolicy(selectedTenantId, {
                  offline_grace_hours: policy.grace_hours + 12,
                  trust_revocation_disconnects_immediately:
                    policy.trust_revocation_disconnects_immediately,
                  reconnect_requires_fresh_heartbeat: policy.reconnect_requires_fresh_heartbeat,
                }, {
                  reason_code: "offline-policy-change",
                  step_up_token: await requireStepUp(StepUpKinds.offlinePolicyChange),
                });
                setPolicy(updated);
                setLiveSuccess("Offline grace window updated (+12h).");
              } catch (err) {
                setLiveError(err instanceof Error ? err.message : "Policy update failed");
              } finally {
                setPolicyBusy(false);
              }
            }}
          >
            {t("machines.extendGrace", "Extend grace +12h")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!policy || policyBusy || !selectedTenantId}
            onClick={async () => {
              if (!policy || !selectedTenantId) return;
              setPolicyBusy(true);
              setLiveError(null);
              setLiveSuccess(null);
              try {
                const updated = await updateTenantOfflinePolicy(selectedTenantId, {
                  offline_grace_hours: policy.grace_hours,
                  trust_revocation_disconnects_immediately:
                    !policy.trust_revocation_disconnects_immediately,
                  reconnect_requires_fresh_heartbeat: policy.reconnect_requires_fresh_heartbeat,
                }, {
                  reason_code: "offline-policy-change",
                  step_up_token: await requireStepUp(StepUpKinds.offlinePolicyChange),
                });
                setPolicy(updated);
                setLiveSuccess("Trust revoke behavior updated.");
              } catch (err) {
                setLiveError(err instanceof Error ? err.message : "Policy update failed");
              } finally {
                setPolicyBusy(false);
              }
            }}
          >
            {t("machines.toggleTrustRule", "Toggle trust-revoke disconnect behavior")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadRowsAndPolicy(selectedTenantId)}>
            {loadingRows ? t("machines.refreshing", "Refreshing…") : t("machines.refresh", "Refresh tenant machine state")}
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">
          {t("machines.activationClaim", "Activation claim (live API)")}
        </h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            "machines.activationClaimHint",
            "Use this to verify that the control-plane activation endpoint accepts a key + machine fingerprint.",
          )}
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="machine-license-key">License key</Label>
            <Input
              id="machine-license-key"
              className="mt-1 font-mono text-xs"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="machine-fingerprint">Machine fingerprint</Label>
            <Input
              id="machine-fingerprint"
              className="mt-1 font-mono text-xs"
              value={machineFingerprint}
              onChange={(e) => setMachineFingerprint(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="machine-app-version">App version</Label>
            <Input
              id="machine-app-version"
              className="mt-1"
              value={appVersion}
              onChange={(e) => setAppVersion(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            onClick={async () => {
              setClaimBusy(true);
              setClaimError(null);
              setClaimResult(null);
              setLiveSuccess(null);
              try {
                const out = await claimActivation({
                  license_key: licenseKey.trim(),
                  machine_fingerprint: machineFingerprint.trim(),
                  app_version: appVersion.trim() || undefined,
                });
                setClaimResult(out);
                await loadRowsAndPolicy(out.tenant_id);
                setLiveSuccess("Activation claim completed and machine data refreshed.");
              } catch (err) {
                setClaimError(err instanceof Error ? err.message : "Activation claim failed");
              } finally {
                setClaimBusy(false);
              }
            }}
            disabled={claimBusy || !licenseKey.trim() || !machineFingerprint.trim()}
          >
            {claimBusy ? "Claiming…" : "Claim activation"}
          </Button>
        </div>
        {claimError ? <p className="mt-2 text-xs text-text-danger">{claimError}</p> : null}
        {claimResult ? (
          <pre className="mt-2 overflow-auto rounded bg-surface-2 p-2 text-xs">
            {JSON.stringify(claimResult, null, 2)}
          </pre>
        ) : null}
      </section>

      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2">{t("machines.col.machine", "Machine")}</th>
              <th className="px-3 py-2">{t("machines.col.heartbeat", "Heartbeat")}</th>
              <th className="px-3 py-2">{t("machines.col.version", "App")}</th>
              <th className="px-3 py-2">{t("machines.col.trust", "Trusted")}</th>
              <th className="px-3 py-2">{t("machines.col.fresh", "Freshness")}</th>
              <th className="px-3 py-2">{t("machines.col.actions", "Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-sm text-text-muted">
                  {loadingRows
                    ? t("machines.loading", "Loading machine activations…")
                    : t("machines.empty", "No activated machines for this tenant yet.")}
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.machine_id} className="border-b border-surface-border last:border-0">
                <td className="px-3 py-2 font-mono text-xs">{row.machine_id}</td>
                <td className="px-3 py-2 text-xs">{row.last_heartbeat_rfc3339 ?? "—"}</td>
                <td className="px-3 py-2">{row.app_version ?? "—"}</td>
                <td className="px-3 py-2">{row.trusted_device ? "✓" : "—"}</td>
                <td className="px-3 py-2">
                  <Badge variant={row.heartbeat_freshness === "live" ? "default" : "secondary"}>
                    {row.heartbeat_freshness}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {row.revocation_kind === "released" ? (
                      <Badge variant="secondary">{t("machines.slotReleased")}</Badge>
                    ) : null}
                    {row.policy_refresh_requested_at ? (
                      <Badge variant="secondary" title={row.policy_refresh_requested_at}>
                        {t("machines.refreshPending")}
                      </Badge>
                    ) : null}
                    {row.trusted_device ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setSlotAction({ row, action: "release" })}
                        >
                          {t("machines.action.slotRelease", "Slot release")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRebindTarget("");
                            setSlotAction({ row, action: "rebind" });
                          }}
                        >
                          {t("machines.action.rebind", "Rebind")}
                        </Button>
                      </>
                    ) : null}
                    {row.trusted_device ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => setSlotAction({ row, action: "revoke" })}
                      >
                        {t("machines.action.revoke", "Revoke")}
                      </Button>
                    ) : row.revocation_kind === "machine" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setSlotAction({ row, action: "reinstate" })}
                      >
                        {t("machines.action.reinstate", "Reinstate")}
                      </Button>
                    ) : (
                      <span className="self-center text-xs text-text-muted">
                        {t("machines.licenceRevoked", "Licence revoked")}
                      </span>
                    )}
                    {row.trusted_device ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={Boolean(row.policy_refresh_requested_at)}
                        onClick={() => setSlotAction({ row, action: "refresh" })}
                      >
                        {t("machines.action.policyRefresh", "Policy refresh")}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedTenant ? (
        <p className="text-xs text-text-muted">
          {t("machines.selectedTenant", "Selected tenant")}: {selectedTenant.slug} ({selectedTenant.id})
        </p>
      ) : null}

      <p className="text-xs text-text-muted">
        {t(
          "machines.fingerprintHint",
          "Fingerprint confidence and rebind thresholds are evaluated server-side to limit unnecessary churn.",
        )}
      </p>
      <OperatorActionDialog
        open={slotAction !== null}
        title={slotAction ? t(`machines.dialog.${slotAction.action}.title`) : ""}
        description={
          slotAction ? t(`machines.dialog.${slotAction.action}.body`, { fingerprint: slotAction.row.machine_id }) : ""
        }
        confirmLabel={slotAction ? t(`machines.dialog.${slotAction.action}.confirm`) : ""}
        destructive={slotAction?.action !== "refresh" && slotAction?.action !== "reinstate"}
        extraValid={
          slotAction?.action !== "rebind" ||
          (rebindTarget.trim().length >= 8 && rebindTarget.trim() !== slotAction.row.machine_id)
        }
        onConfirm={runSlotAction}
        onClose={() => setSlotAction(null)}
      >
        {slotAction?.action === "rebind" ? (
          <div className="grid gap-1">
            <Label htmlFor="rebind-target">{t("machines.dialog.rebind.targetLabel")}</Label>
            <Input
              id="rebind-target"
              autoComplete="off"
              className="font-mono"
              value={rebindTarget}
              onChange={(e) => setRebindTarget(e.target.value)}
            />
          </div>
        ) : null}
      </OperatorActionDialog>
    </div>
  );
}

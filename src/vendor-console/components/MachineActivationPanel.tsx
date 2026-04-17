import { useEffect, useMemo, useState } from "react";
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
  updateTenantOfflinePolicy,
  type ActivationRow,
  type ControlTenant,
  type OfflinePolicy,
} from "@/services/license-control-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { useVendorConsole } from "../VendorConsoleContext";

export function MachineActivationPanel() {
  const { t } = useTranslation("vendorConsole");
  const { openStepUp } = useVendorConsole();
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
  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  const loadTenants = async () => {
    const list = await listTenants();
    setTenants(list);
    if (list.length > 0 && !selectedTenantId) {
      setSelectedTenantId(list[0]!.id);
    }
  };

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
  }, []);

  useEffect(() => {
    void loadRowsAndPolicy(selectedTenantId);
  }, [selectedTenantId]);

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
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openStepUp("slot_release")}
                      title="Requires step-up confirmation before server-side slot release."
                    >
                      {t("machines.action.slotRelease", "Slot release")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openStepUp("device_rebind")}
                      title="Requires step-up confirmation before server-side device rebind."
                    >
                      {t("machines.action.rebind", "Rebind")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => openStepUp("soft_suspend")}
                      title="Requires step-up confirmation before server-side soft suspend."
                    >
                      {t("machines.action.softSuspend", "Soft suspend")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => openStepUp("policy_refresh")}
                      title="Requires step-up confirmation before server-side policy refresh."
                    >
                      {t("machines.action.policyRefresh", "Policy refresh")}
                    </Button>
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
    </div>
  );
}

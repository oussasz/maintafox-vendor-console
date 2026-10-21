/**
 * Checks that the activation endpoint accepts a licence key and a machine fingerprint (a real
 * claim: the machine takes a seat on that licence; free it again from the device list).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/error-text";
import { claimActivation } from "@/services/license-control-service";

import { FactRow, Notice, Panel } from "../ui/kit";

export function ActivationTestPanel() {
  const { t } = useTranslation("vendorConsole");
  const [licenseKey, setLicenseKey] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tenant_id: string; license_id: string; machine_fingerprint: string } | null>(null);

  const claim = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await claimActivation({
          license_key: licenseKey.trim(),
          machine_fingerprint: fingerprint.trim(),
          app_version: appVersion.trim() || undefined,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t("machines.activationClaim")} labelledBy="activation-test-h">
      <p className="text-[13px] text-text-secondary">{t("devices.test.body")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label htmlFor="machine-license-key">{t("machines.licenseKey")}</Label>
          <Input id="machine-license-key" className="font-mono text-xs" value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="machine-fingerprint">{t("machines.fingerprint")}</Label>
          <Input id="machine-fingerprint" className="font-mono text-xs" value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="machine-app-version">{t("devices.test.appVersionOptional")}</Label>
          <Input id="machine-app-version" value={appVersion} onChange={(e) => setAppVersion(e.target.value)} />
        </div>
      </div>
      <div>
        <Button type="button" onClick={() => void claim()} disabled={busy || !licenseKey.trim() || !fingerprint.trim()}>
          {busy ? t("machines.claiming") : t("machines.claim")}
        </Button>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {result ? (
        <div className="flex flex-col gap-2">
          <Notice tone="ok">{t("devices.test.accepted")}</Notice>
          <FactRow label={t("devices.test.customer")} value={result.tenant_id} />
          <FactRow label={t("devices.test.licence")} value={result.license_id} />
          <FactRow label={t("machines.fingerprint")} value={result.machine_fingerprint} />
        </div>
      ) : null}
    </Panel>
  );
}

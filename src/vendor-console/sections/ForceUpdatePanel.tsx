/**
 * Minimum desktop version a customer (or its whole rollout group) must run. "Required" asks users
 * to update; "Emergency" blocks work until they do. Every change needs an audit reason and an
 * authenticator code (step-up rollout_publish; going back: forced_rollback).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  getCohortUpdatePolicy,
  getTenantUpdatePolicy,
  listTenants,
  PRIVILEGED_REASON_MIN_LENGTH,
  rollbackCohortUpdatePolicy,
  rollbackTenantUpdatePolicy,
  updateCohortUpdatePolicy,
  updateTenantUpdatePolicy,
  type ControlTenant,
} from "@/services/license-control-service";

import { StepUpCancelledError, useVendorConsole } from "../VendorConsoleContext";
import { EmptyState, LoadError, Notice, Panel } from "../ui/kit";

type TenantMode = "off" | "required" | "emergency" | "inherit";
type CohortMode = "off" | "required" | "emergency";
type Policy<M> = { version: string; mode: M; userReason: string };

const selectClass = "h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";

export function ForceUpdatePanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [tenants, setTenants] = useState<ControlTenant[] | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [tenantPolicy, setTenantPolicy] = useState<Policy<TenantMode>>({ version: "", mode: "inherit", userReason: "" });
  const [cohortPolicy, setCohortPolicy] = useState<Policy<CohortMode>>({ version: "", mode: "off", userReason: "" });
  const [auditReason, setAuditReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tenant = tenants?.find((x) => x.id === tenantId) ?? null;
  const channel = tenant?.update_channel ?? "stable";
  const cohort = tenant?.rollout_cohort ?? "stable-main";

  const loadTenants = useCallback(async () => {
    setError(null);
    try {
      const list = await listTenants();
      setTenants(list);
      setTenantId((current) => current || (list[0]?.id ?? ""));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    if (!tenant) return;
    setError(null);
    Promise.all([getTenantUpdatePolicy(tenant.id), getCohortUpdatePolicy(channel, cohort)])
      .then(([tp, cp]) => {
        setTenantPolicy({ version: tp.force_min_app_version ?? "", mode: tp.force_update_mode, userReason: tp.force_update_reason ?? "" });
        setCohortPolicy({ version: cp.force_min_app_version ?? "", mode: cp.force_update_mode, userReason: cp.force_update_reason ?? "" });
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [tenant, channel, cohort]);

  const reasonOk = auditReason.trim().length >= PRIVILEGED_REASON_MIN_LENGTH;

  const act = async (work: () => Promise<void>, doneKey: string) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await work();
      setSuccess(t(doneKey));
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const privileged = async (kind: typeof StepUpKinds.rolloutPublish) => ({ reason_code: auditReason.trim(), step_up_token: await requireStepUp(kind) });

  const applyTenant = () =>
    act(async () => {
      const p = await updateTenantUpdatePolicy(
        tenantId,
        { force_min_app_version: tenantPolicy.version.trim() || null, force_update_mode: tenantPolicy.mode, force_update_reason: tenantPolicy.userReason.trim() || null },
        await privileged(StepUpKinds.rolloutPublish),
      );
      setTenantPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    }, "updates.force.saved");
  const rollbackTenant = () =>
    act(async () => {
      const p = await rollbackTenantUpdatePolicy(tenantId, await privileged(StepUpKinds.forcedRollback));
      setTenantPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    }, "updates.force.rolledBack");
  const applyCohort = () =>
    act(async () => {
      const p = await updateCohortUpdatePolicy(
        channel,
        cohort,
        { force_min_app_version: cohortPolicy.version.trim() || null, force_update_mode: cohortPolicy.mode, force_update_reason: cohortPolicy.userReason.trim() || null },
        await privileged(StepUpKinds.rolloutPublish),
      );
      setCohortPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    }, "updates.force.saved");
  const rollbackCohort = () =>
    act(async () => {
      const p = await rollbackCohortUpdatePolicy(channel, cohort, await privileged(StepUpKinds.forcedRollback));
      setCohortPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    }, "updates.force.rolledBack");

  return (
    <Panel title={t("customers.policy.title")} labelledBy="force-update-h">
      <p className="text-[13px] text-text-secondary">{t("customers.policy.body")}</p>
      {error ? <LoadError message={error} onRetry={tenants ? undefined : () => void loadTenants()} /> : null}
      {success ? <Notice tone="ok">{success}</Notice> : null}
      {tenants && tenants.length === 0 ? <EmptyState title={t("updates.force.noCustomers")} /> : null}
      {tenants && tenants.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="force-tenant">{t("updates.force.customer")}</Label>
              <select id="force-tenant" className={selectClass} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="operator-reason">{t("customers.policy.auditReason")}</Label>
              <Input id="operator-reason" value={auditReason} placeholder="INC-2026-042" onChange={(e) => setAuditReason(e.target.value)} />
            </div>
          </div>
          {!reasonOk ? <p className="text-[13px] text-text-secondary">{t("customers.policy.needReason")}</p> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <PolicyEditor
              idPrefix="tenant"
              heading={t("customers.policy.tenantOverride", { slug: tenant?.display_name ?? "" })}
              modes={["inherit", "off", "required", "emergency"]}
              policy={tenantPolicy}
              onChange={setTenantPolicy}
              disabled={busy || !reasonOk}
              applyLabel={t("customers.policy.applyTenant")}
              rollbackLabel={t("customers.policy.rollbackTenant")}
              onApply={() => void applyTenant()}
              onRollback={() => void rollbackTenant()}
            />
            <PolicyEditor
              idPrefix="cohort"
              heading={t("customers.policy.cohortBaseline", { channel, cohort })}
              modes={["off", "required", "emergency"]}
              policy={cohortPolicy}
              onChange={setCohortPolicy}
              disabled={busy || !reasonOk}
              applyLabel={t("customers.policy.applyCohort")}
              rollbackLabel={t("customers.policy.rollbackCohort")}
              onApply={() => void applyCohort()}
              onRollback={() => void rollbackCohort()}
            />
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function PolicyEditor<M extends string>({
  idPrefix,
  heading,
  modes,
  policy,
  onChange,
  disabled,
  applyLabel,
  rollbackLabel,
  onApply,
  onRollback,
}: {
  idPrefix: string;
  heading: string;
  modes: M[];
  policy: Policy<M>;
  onChange: (p: Policy<M>) => void;
  disabled: boolean;
  applyLabel: string;
  rollbackLabel: string;
  onApply: () => void;
  onRollback: () => void;
}) {
  const { t } = useTranslation("vendorConsole");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border p-4">
      <p className="text-sm font-semibold text-text-primary">{heading}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-min-version`}>{t("customers.policy.minVersion")}</Label>
        <Input id={`${idPrefix}-min-version`} value={policy.version} placeholder="1.8.0" aria-describedby={`${idPrefix}-min-version-hint`} onChange={(e) => onChange({ ...policy, version: e.target.value })} />
        <p id={`${idPrefix}-min-version-hint`} className="text-[12px] text-text-secondary">{t("customers.policy.minVersionHint")}</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-force-mode`}>{t("customers.policy.mode")}</Label>
        <select id={`${idPrefix}-force-mode`} className={selectClass} value={policy.mode} onChange={(e) => onChange({ ...policy, mode: e.target.value as M })}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {t(`customers.policy.modes.${m}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-force-reason`}>{t("customers.policy.userReason")}</Label>
        <Input id={`${idPrefix}-force-reason`} value={policy.userReason} onChange={(e) => onChange({ ...policy, userReason: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Button type="button" size="sm" disabled={disabled} onClick={onApply}>
          {applyLabel}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRollback}>
          {rollbackLabel}
        </Button>
      </div>
    </div>
  );
}

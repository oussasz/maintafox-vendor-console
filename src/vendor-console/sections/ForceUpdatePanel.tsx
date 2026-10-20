/**
 * Minimum desktop version a customer (or its whole rollout group) must run. "Required" asks users
 * to update; "Emergency" blocks work until they do. Every change needs an audit reason and an
 * authenticator code (step-up rollout_publish; going back: forced_rollback). An empty version field
 * keeps the stored minimum version; removing it is its own confirmed action (same step-up).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  clearCohortMinAppVersion,
  clearTenantMinAppVersion,
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

import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { StepUpCancelledError, useVendorConsole } from "../VendorConsoleContext";
import { EmptyState, LoadError, Notice, Panel } from "../ui/kit";

type TenantMode = "off" | "required" | "emergency" | "inherit";
type CohortMode = "off" | "required" | "emergency";
type Policy<M> = { version: string; mode: M; userReason: string };
type ServerPolicy<M> = { force_min_app_version: string | null; force_update_mode: M; force_update_reason: string | null };
/** What the server holds (the edit fields may differ until applied). */
type Saved<M> = { floor: string | null; mode: M };
type Removal = { target: "tenant" | "cohort"; floor: string; mode: TenantMode };

const selectClass = "h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";

export function ForceUpdatePanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [tenants, setTenants] = useState<ControlTenant[] | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [tenantPolicy, setTenantPolicy] = useState<Policy<TenantMode>>({ version: "", mode: "inherit", userReason: "" });
  const [cohortPolicy, setCohortPolicy] = useState<Policy<CohortMode>>({ version: "", mode: "off", userReason: "" });
  const [tenantSaved, setTenantSaved] = useState<Saved<TenantMode>>({ floor: null, mode: "inherit" });
  const [cohortSaved, setCohortSaved] = useState<Saved<CohortMode>>({ floor: null, mode: "off" });
  const [removal, setRemoval] = useState<Removal | null>(null);
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

  const showTenant = useCallback((p: ServerPolicy<TenantMode>) => {
    setTenantPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    setTenantSaved({ floor: p.force_min_app_version, mode: p.force_update_mode });
  }, []);
  const showCohort = useCallback((p: ServerPolicy<CohortMode>) => {
    setCohortPolicy({ version: p.force_min_app_version ?? "", mode: p.force_update_mode, userReason: p.force_update_reason ?? "" });
    setCohortSaved({ floor: p.force_min_app_version, mode: p.force_update_mode });
  }, []);

  useEffect(() => {
    if (!tenant) return;
    setError(null);
    Promise.all([getTenantUpdatePolicy(tenant.id), getCohortUpdatePolicy(channel, cohort)])
      .then(([tp, cp]) => {
        showTenant(tp);
        showCohort(cp);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [tenant, channel, cohort, showTenant, showCohort]);

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
      showTenant(p);
    }, "updates.force.saved");
  const rollbackTenant = () =>
    act(async () => {
      const p = await rollbackTenantUpdatePolicy(tenantId, await privileged(StepUpKinds.forcedRollback));
      showTenant(p);
    }, "updates.force.rolledBack");
  const applyCohort = () =>
    act(async () => {
      const p = await updateCohortUpdatePolicy(
        channel,
        cohort,
        { force_min_app_version: cohortPolicy.version.trim() || null, force_update_mode: cohortPolicy.mode, force_update_reason: cohortPolicy.userReason.trim() || null },
        await privileged(StepUpKinds.rolloutPublish),
      );
      showCohort(p);
    }, "updates.force.saved");
  const rollbackCohort = () =>
    act(async () => {
      const p = await rollbackCohortUpdatePolicy(channel, cohort, await privileged(StepUpKinds.forcedRollback));
      showCohort(p);
    }, "updates.force.rolledBack");

  // Runs from the confirmation dialog with the reason typed there; a refusal stays in the dialog.
  const removeFloor = async (reason: string) => {
    if (!removal) return;
    const ctx = { reason_code: reason, step_up_token: await requireStepUp(StepUpKinds.rolloutPublish) };
    if (removal.target === "tenant") showTenant(await clearTenantMinAppVersion(tenantId, removal.floor, ctx));
    else showCohort(await clearCohortMinAppVersion(channel, cohort, removal.floor, ctx));
    setError(null);
    setSuccess(t("customers.policy.floorRemoved", { floor: removal.floor }));
  };
  const removalTarget = !removal
    ? ""
    : removal.target === "tenant"
      ? t("customers.policy.removeFloorDialog.tenantTarget", { floor: removal.floor, name: tenant?.display_name ?? "" })
      : t("customers.policy.removeFloorDialog.cohortTarget", { floor: removal.floor, channel, cohort });

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
              savedFloor={tenantSaved.floor}
              removeDisabled={busy}
              onRemoveFloor={(floor) => setRemoval({ target: "tenant", floor, mode: tenantSaved.mode })}
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
              savedFloor={cohortSaved.floor}
              removeDisabled={busy}
              onRemoveFloor={(floor) => setRemoval({ target: "cohort", floor, mode: cohortSaved.mode })}
            />
          </div>
        </>
      ) : null}
      <OperatorActionDialog
        open={removal !== null}
        title={t("customers.policy.removeFloorDialog.title")}
        description={removalTarget}
        confirmLabel={t("customers.policy.removeFloorDialog.confirm")}
        destructive
        extraValid={removal?.mode !== "required"}
        onConfirm={removeFloor}
        onClose={() => setRemoval(null)}
      >
        {removal ? (
          <div className="grid gap-2 text-sm text-text-secondary">
            <p>{t(`customers.policy.removeFloorDialog.effect.${removal.mode}`)}</p>
            {removal.mode !== "required" ? <p>{t("customers.policy.removeFloorDialog.rollbackNote", { floor: removal.floor })}</p> : null}
          </div>
        ) : null}
      </OperatorActionDialog>
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
  savedFloor,
  removeDisabled,
  onRemoveFloor,
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
  /** The stored minimum version; the remove action is offered only when one is set. */
  savedFloor: string | null;
  removeDisabled: boolean;
  onRemoveFloor: (floor: string) => void;
}) {
  const { t } = useTranslation("vendorConsole");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border p-4">
      <p className="text-sm font-semibold text-text-primary">{heading}</p>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-min-version`}>{t("customers.policy.minVersion")}</Label>
        <Input id={`${idPrefix}-min-version`} value={policy.version} placeholder="1.8.0" aria-describedby={`${idPrefix}-min-version-hint`} onChange={(e) => onChange({ ...policy, version: e.target.value })} />
        <p id={`${idPrefix}-min-version-hint`} className="text-[12px] text-text-secondary">{t("customers.policy.minVersionHint")}</p>
        {savedFloor ? (
          <div>
            <Button type="button" size="sm" variant="outline" disabled={removeDisabled} onClick={() => onRemoveFloor(savedFloor)}>
              {t("customers.policy.removeFloor")}
            </Button>
          </div>
        ) : null}
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

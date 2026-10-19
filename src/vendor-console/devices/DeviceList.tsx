/**
 * The devices of a customer in plain words ("Online", "Not seen for 3 days", "Seat freed"), with
 * what an operator may do to each: free its seat, move the seat to a replacement computer, ask it
 * to refresh its licence now, block or unblock it, or give its site a one-time administrator
 * recovery code. Every action asks for a reason (audit ledger); all but the refresh also ask for an
 * authenticator code (step-up machine_trust_change; admin_recovery_code for the recovery code).
 */
import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  issueAdminRecoveryCode,
  listAdminRecoveryCodes,
  listTenantActivations,
  rebindMachine,
  reinstateMachine,
  releaseMachineSlot,
  requestMachinePolicyRefresh,
  revokeMachine,
  type ActivationRow,
  type AdminRecoveryCodeIssued,
} from "@/services/license-control-service";

import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { AdminRecoveryCodeDialog } from "./AdminRecoveryCodeDialog";
import { useVendorConsole } from "../VendorConsoleContext";
import { formatAgo, formatDateTime } from "../ui/format";
import { EmptyState, LoadError, Loading, Notice, StatusPill, type Tone } from "../ui/kit";

/** A device seen within this long is online (same window as the sync health of the server). */
const ONLINE_WINDOW_MS = 15 * 60_000;
/** Not seen for longer than this needs a look (same as "not syncing" on the Overview). */
const NOT_SEEN_ATTENTION_MS = 24 * 3600_000;

type SlotAction = "revoke" | "reinstate" | "release" | "rebind" | "refresh" | "recovery";

export function deviceName(row: Pick<ActivationRow, "machine_label" | "machine_id">): string {
  return row.machine_label?.trim() || row.machine_id;
}

/** Plain status of a device: label key, its values, and colour. */
export function deviceStatus(row: ActivationRow, nowMs: number): { key: string; values: Record<string, string | number>; tone: Tone } {
  if (row.revocation_kind === "released") return { key: "devices.status.released", values: {}, tone: "neutral" };
  if (row.revocation_kind === "machine") return { key: "devices.status.blocked", values: {}, tone: "danger" };
  if (row.revocation_kind === "license") return { key: "devices.status.licenceRevoked", values: {}, tone: "danger" };
  const seenMs = row.last_heartbeat_rfc3339 ? Date.parse(row.last_heartbeat_rfc3339) : NaN;
  if (!Number.isFinite(seenMs)) return { key: "devices.status.neverSeen", values: {}, tone: "attention" };
  const age = nowMs - seenMs;
  if (age <= ONLINE_WINDOW_MS) return { key: "devices.status.online", values: {}, tone: "ok" };
  if (age > NOT_SEEN_ATTENTION_MS) return { key: "devices.status.notSeenDays", values: { count: Math.floor(age / 86_400_000) }, tone: "attention" };
  return { key: "devices.status.lastSeen", values: { ago: formatAgo(row.last_heartbeat_rfc3339) }, tone: "neutral" };
}

export function DeviceList({ tenantId, onSeeHistory }: { tenantId: string; onSeeHistory?: (machineId: string) => void }) {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const { requireStepUp } = useVendorConsole();
  const [rows, setRows] = useState<ActivationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState<{ row: ActivationRow; action: SlotAction } | null>(null);
  const [rebindTarget, setRebindTarget] = useState("");
  const [issuedCode, setIssuedCode] = useState<{ issued: AdminRecoveryCodeIssued; label: string } | null>(null);
  /** Codes already issued for the PC of the open recovery dialog that are still valid (null: unknown). */
  const [validCodes, setValidCodes] = useState<{ count: number; until: string | null } | null>(null);
  /** Increases on every ask(): a code list that arrives for an earlier dialog is ignored. */
  const askSeq = useRef(0);
  const canManage = can("entitlement.manage");

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listTenantActivations(tenantId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (reason: string) => {
    if (!pending) return;
    const { row, action } = pending;
    setSuccess(null);
    if (action === "refresh") {
      await requestMachinePolicyRefresh(row.tenant_id, row.machine_id, reason);
      setSuccess(t("machines.refreshRequested"));
    } else if (action === "recovery") {
      const privileged = { reason_code: reason, step_up_token: await requireStepUp(StepUpKinds.adminRecoveryCode) };
      const issued = await issueAdminRecoveryCode(row.tenant_id, row.machine_id, privileged);
      setIssuedCode({ issued, label: deviceName(row) });
      return;
    } else {
      const privileged = { reason_code: reason, step_up_token: await requireStepUp(StepUpKinds.machineTrustChange) };
      if (action === "revoke") {
        await revokeMachine(row.tenant_id, row.machine_id, reason, privileged);
        setSuccess(t("machines.revoked"));
      } else if (action === "reinstate") {
        await reinstateMachine(row.tenant_id, row.machine_id, reason, privileged);
        setSuccess(t("machines.reinstated"));
      } else if (action === "release") {
        await releaseMachineSlot(row.tenant_id, row.machine_id, privileged);
        setSuccess(t("machines.released"));
      } else {
        await rebindMachine(row.tenant_id, row.machine_id, rebindTarget.trim(), privileged);
        setSuccess(t("machines.rebound", { fingerprint: rebindTarget.trim() }));
      }
    }
    await load();
  };

  const ask = (row: ActivationRow, action: SlotAction) => {
    setRebindTarget("");
    setValidCodes(null);
    setPending({ row, action });
    const seq = ++askSeq.current;
    if (action === "recovery") {
      // Tells the operator when codes sent earlier are still usable (the list never holds codes).
      listAdminRecoveryCodes(row.tenant_id, row.machine_id)
        .then((codes) => {
          if (seq !== askSeq.current) return;
          const valid = codes.filter((c) => !c.expired);
          const until = valid.map((c) => c.expires_at).sort().pop() ?? null;
          setValidCodes({ count: valid.length, until });
        })
        .catch(() => {
          if (seq === askSeq.current) setValidCodes(null);
        });
    }
  };

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!rows) return <Loading />;
  const nowMs = Date.now();
  return (
    <div className="flex flex-col">
      {success ? <Notice tone="ok">{success}</Notice> : null}
      {rows.length === 0 ? <EmptyState title={t("devices.empty.title")} body={t("devices.empty.body")} /> : null}
      <ul className="flex flex-col">
        {rows.map((row) => {
          const status = deviceStatus(row, nowMs);
          const active = row.trusted_device;
          return (
            <li key={row.machine_id} className="flex flex-wrap items-center gap-3.5 border-t border-surface-3 py-3.5 first:border-t-0">
              <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
                <span className="font-semibold text-text-primary">{deviceName(row)}</span>
                <span className="text-[13px] text-text-secondary">
                  {[
                    row.app_version ? t("devices.version", { version: row.app_version }) : null,
                    row.last_heartbeat_rfc3339 ? t("devices.seen", { ago: formatAgo(row.last_heartbeat_rfc3339, nowMs) }) : null,
                    row.machine_label ? row.machine_id : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <StatusPill tone={status.tone}>{t(status.key, status.values)}</StatusPill>
              {row.policy_refresh_requested_at ? <StatusPill tone="info">{t("machines.refreshPending")}</StatusPill> : null}
              {status.tone === "attention" && onSeeHistory ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onSeeHistory(row.machine_id)}>
                  {t("devices.action.seeWhatHappened")}
                </Button>
              ) : null}
              {canManage && active ? (
                <Button type="button" variant="outline" size="sm" onClick={() => ask(row, "release")}>
                  {t("devices.action.freeSeat")}
                </Button>
              ) : null}
              {canManage && row.revocation_kind === "machine" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => ask(row, "reinstate")}>
                  {t("devices.action.unblock")}
                </Button>
              ) : null}
              {canManage && active ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" aria-label={t("devices.action.more", { name: deviceName(row) })}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => ask(row, "rebind")}>{t("devices.action.moveSeat")}</DropdownMenuItem>
                    <DropdownMenuItem disabled={Boolean(row.policy_refresh_requested_at)} onSelect={() => ask(row, "refresh")}>
                      {t("devices.action.refresh")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => ask(row, "recovery")}>{t("devices.action.recoveryCode")}</DropdownMenuItem>
                    {onSeeHistory ? (
                      <DropdownMenuItem onSelect={() => onSeeHistory(row.machine_id)}>{t("devices.action.seeWhatHappened")}</DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem className="text-danger" onSelect={() => ask(row, "revoke")}>
                      {t("devices.action.block")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          );
        })}
      </ul>
      <OperatorActionDialog
        open={pending !== null}
        title={pending ? t(`machines.dialog.${pending.action}.title`) : ""}
        description={pending ? t(`machines.dialog.${pending.action}.body`, { fingerprint: deviceName(pending.row) }) : ""}
        confirmLabel={pending ? t(`machines.dialog.${pending.action}.confirm`) : ""}
        destructive={pending?.action === "revoke" || pending?.action === "release" || pending?.action === "rebind"}
        extraValid={pending?.action !== "rebind" || (rebindTarget.trim().length >= 8 && rebindTarget.trim() !== pending.row.machine_id)}
        onConfirm={run}
        onClose={() => setPending(null)}
      >
        {pending?.action === "recovery" ? (
          <div className="grid gap-2 text-sm text-text-secondary">
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("machines.dialog.recovery.pointOnce")}</li>
              <li>{t("machines.dialog.recovery.pointNotice")}</li>
              <li>{t("machines.dialog.recovery.pointExpiry")}</li>
              <li>{t("machines.dialog.recovery.pointShownOnce")}</li>
            </ul>
            {validCodes && validCodes.count > 0 ? (
              <p className="text-text-primary">
                {t("machines.dialog.recovery.stillValid", { count: validCodes.count, at: formatDateTime(validCodes.until) })}
              </p>
            ) : null}
          </div>
        ) : null}
        {pending?.action === "rebind" ? (
          <div className="grid gap-1">
            <Label htmlFor="rebind-target">{t("machines.dialog.rebind.targetLabel")}</Label>
            <Input id="rebind-target" autoComplete="off" className="font-mono" value={rebindTarget} onChange={(e) => setRebindTarget(e.target.value)} />
          </div>
        ) : null}
      </OperatorActionDialog>
      <AdminRecoveryCodeDialog issued={issuedCode?.issued ?? null} deviceLabel={issuedCode?.label ?? ""} onClose={() => setIssuedCode(null)} />
    </div>
  );
}

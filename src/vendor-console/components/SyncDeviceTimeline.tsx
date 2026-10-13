import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Label } from "@/components/ui";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { listTenantActivations, listTenants, type ActivationRow, type ControlTenant } from "@/services/license-control-service";
import { getDeviceTimeline, requestDeviceResync, type DeviceTimeline } from "@/services/vendor-ops-telemetry-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";
import { errorText } from "@/lib/error-text";

/** Spans offered for the timeline (the API accepts 1 h to 30 days). */
const TIMELINE_SPANS_HOURS = [24, 72, 168, 720] as const;
const DEFAULT_SPAN_HOURS = 72;

const selectClass = "h-11 rounded-lg border border-input bg-white pl-3 pr-9 text-sm text-text-primary";

/**
 * One device's sync history as the server recorded it (exchanges, retries, refused items,
 * conflicts, resynchronisations, operator actions) and the repair action: a full
 * resynchronisation (step-up `sync_repair`). Refused items cannot be replayed by the server (it
 * keeps no payload); the device replays its own from its Sync Center.
 */
export function SyncDeviceTimeline({
  fixedTenantId,
  initialMachineId,
}: {
  /** Shown inside a customer page: that customer only, no customer selector. */
  fixedTenantId?: string;
  /** Device selected first (e.g. from "See what happened"). */
  initialMachineId?: string | null;
} = {}) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [tenantId, setTenantId] = useState(fixedTenantId ?? "");
  const [machines, setMachines] = useState<ActivationRow[]>([]);
  const [machineId, setMachineId] = useState("");
  const [hours, setHours] = useState<number>(DEFAULT_SPAN_HOURS);
  const [timeline, setTimeline] = useState<DeviceTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (fixedTenantId) return;
    listTenants()
      .then((list) => {
        setTenants(list);
        setTenantId((current) => current || (list[0]?.id ?? ""));
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [fixedTenantId]);

  useEffect(() => {
    if (!tenantId) return;
    setTimeline(null);
    listTenantActivations(tenantId)
      .then((rows) => {
        setMachines(rows);
        setMachineId((current) =>
          initialMachineId && rows.some((r) => r.machine_id === initialMachineId)
            ? initialMachineId
            : rows.some((r) => r.machine_id === current)
              ? current
              : (rows[0]?.machine_id ?? ""),
        );
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [tenantId, initialMachineId]);

  const load = useCallback(async () => {
    if (!tenantId || !machineId) return;
    setError(null);
    try {
      setTimeline(await getDeviceTimeline(tenantId, machineId, hours));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId, machineId, hours]);

  useEffect(() => {
    void load();
  }, [load]);

  const resync = async (reason: string) => {
    await requestDeviceResync(tenantId, machineId, {
      reason_code: reason,
      step_up_token: await requireStepUp(StepUpKinds.syncRepair),
    });
    setSuccess(t("sync.timeline.resyncRequested"));
    await load();
  };

  return (
    <section className="space-y-3" aria-labelledby="sync-device-timeline">
      <h2 id="sync-device-timeline" className="text-sm font-semibold">
        {t("sync.timeline.title")}
      </h2>
      <p className="text-xs text-text-secondary">{t("sync.timeline.body")}</p>
      <div className="flex flex-wrap items-end gap-3">
        {fixedTenantId ? null : (
        <div className="grid gap-1">
          <Label htmlFor="timeline-tenant">{t("sync.timeline.customer")}</Label>
          <select id="timeline-tenant" className={selectClass} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.display_name}
              </option>
            ))}
          </select>
        </div>
        )}
        <div className="grid gap-1">
          <Label htmlFor="timeline-machine">{t("sync.timeline.machine")}</Label>
          <select id="timeline-machine" className={selectClass} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
            {machines.map((m) => (
              <option key={m.machine_id} value={m.machine_id}>
                {m.machine_id}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="timeline-span">{t("sync.timeline.span")}</Label>
          <select id="timeline-span" className={selectClass} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {TIMELINE_SPANS_HOURS.map((h) => (
              <option key={h} value={h}>
                {t("sync.timeline.hours", { count: h })}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="destructive"
          disabled={!timeline || timeline.open_resync !== null || timeline.device.revoked_at !== null}
          onClick={() => setConfirming(true)}
        >
          {t("sync.timeline.resync")}
        </Button>
      </div>

      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}
      {success ? (
        <ConsoleStatusBanner tone="success" role="status">
          {success}
        </ConsoleStatusBanner>
      ) : null}
      {machines.length === 0 && tenantId ? <p className="text-sm text-text-muted">{t("sync.timeline.noMachine")}</p> : null}

      {timeline ? (
        <div className="space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-4">
            <p>
              {t("sync.timeline.protocol")}: <span className="font-mono">{timeline.measured?.protocol ?? "-"}</span>
            </p>
            <p>
              {t("sync.timeline.lag")}: {timeline.measured ? `${timeline.measured.lag_seconds} s` : "-"}
            </p>
            <p>
              {t("sync.timeline.checkpointAge")}: {timeline.measured ? `${timeline.measured.checkpoint_age_seconds} s` : "-"}
            </p>
            <p>
              {t("sync.timeline.lastSeen")}: {new Date(timeline.device.last_seen_at).toLocaleString()}
            </p>
          </div>
          {timeline.open_resync ? (
            <ConsoleStatusBanner tone="info" role="status">
              {t("sync.timeline.resyncOpen", {
                at: new Date(timeline.open_resync.requested_at).toLocaleString(),
                by: timeline.open_resync.requested_by,
              })}
            </ConsoleStatusBanner>
          ) : null}
          <ol className="space-y-1" data-testid="timeline-events">
            {timeline.events.length === 0 ? <li className="text-sm text-text-muted">{t("sync.timeline.empty")}</li> : null}
            {timeline.events.map((e, i) => (
              <li key={`${e.at}-${e.kind}-${i}`} className="flex gap-3 border-b border-surface-border py-1 text-xs last:border-0">
                <span className="w-40 shrink-0 text-text-muted">{new Date(e.at).toLocaleString()}</span>
                <Badge variant={e.kind === "rejection" || e.kind === "conflict" ? "destructive" : "secondary"}>
                  {t(`sync.timeline.kind.${e.kind}`)}
                </Badge>
                <span className="break-all font-mono text-text-secondary">
                  {Object.entries(e.detail)
                    .filter(([, v]) => v !== null && v !== undefined && v !== "")
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <OperatorActionDialog
        open={confirming}
        title={t("sync.timeline.resyncTitle")}
        description={t("sync.timeline.resyncBody", { machine: machineId })}
        confirmLabel={t("sync.timeline.resyncConfirm")}
        destructive
        onConfirm={resync}
        onClose={() => setConfirming(false)}
      />
    </section>
  );
}

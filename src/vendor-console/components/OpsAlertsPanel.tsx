import { useTranslation } from "react-i18next";

import type { OpsAlertV1 } from "@maintafox/contracts";

import { tenantSafeDrillThrough } from "@/services/vendor-ops-contracts";

import { OpsSeverityBadge } from "./opsSeverityBadge";

function drillSummary(refs: OpsAlertV1["drill_refs"]): string {
  const parts: string[] = [];
  if (refs.tenant_id_hint) parts.push(`tenant:${refs.tenant_id_hint}`);
  if (refs.sync_batch_id) parts.push(`batch:${refs.sync_batch_id}`);
  if (refs.rollout_release_id) parts.push(`release:${refs.rollout_release_id}`);
  if (refs.correlation_id) parts.push(`corr:${refs.correlation_id}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function OpsAlertsPanel({
  alerts,
  compact = false,
}: {
  alerts: OpsAlertV1[];
  compact?: boolean;
}) {
  const { t } = useTranslation("vendorConsole");

  const visible = compact ? alerts.slice(0, 2) : alerts;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">
        {t("ops.alerts.title")}
      </h2>
      <p className="text-xs text-text-secondary">
        {t("ops.alerts.hint")}
      </p>
      <ul className="space-y-3">
        {visible.length === 0 ? (
          <li className="rounded-lg border border-surface-border bg-surface-1 p-3 text-sm text-text-muted">
            {t("ops.alerts.empty")}
          </li>
        ) : null}
        {visible.map((a) => {
          const safe = tenantSafeDrillThrough(a.drill_refs);
          return (
            <li
              key={a.alert_id}
              className="rounded-lg border border-surface-border bg-surface-1 p-3 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{a.title}</p>
                  <p className="mt-1 font-mono text-xs text-text-muted">{a.alert_id}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <OpsSeverityBadge severity={a.severity} />
                  <span className="text-xs uppercase text-text-muted">{a.state}</span>
                </div>
              </div>
              <p className="mt-2 text-xs text-text-secondary">
                {t("ops.alerts.drill")}: {drillSummary(a.drill_refs)}
                {!safe ? (
                  <span className="ml-2 text-destructive">
                    {t("ops.alerts.unsafe")}
                  </span>
                ) : null}
              </p>
              {a.notes.length > 0 ? (
                <ul className="mt-2 list-inside list-disc text-xs text-text-secondary">
                  {a.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {!compact ? (
                <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-surface-border pt-3">
                  <div className="text-xs text-text-secondary">
                    <p>
                      {t("ops.alerts.owner")}:
                      <span className="ml-1 font-mono">{a.owner_actor_id ?? "—"}</span>
                    </p>
                    <p className="mt-1">
                      {t("ops.alerts.note")}:{" "}
                      {t("ops.alerts.readOnly")}
                    </p>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

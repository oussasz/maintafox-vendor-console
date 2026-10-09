import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/use-permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createSupportIntervention,
  downloadSupportTicketsCsv,
  getLatestDiagnosticBundle,
  listOfflineReconciliation,
  listSupportTickets,
  type DiagnosticBundle,
  type OfflineReconciliationRow,
  type SupportTicket,
} from "@/services/vendor-audit-support-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OpsSeverityBadge } from "./opsSeverityBadge";
import { useVendorConsole } from "../VendorConsoleContext";

const COMPLIANCE_EXPORT_LABELS: Record<
  "entitlement_history" | "machine_state_timeline" | "rollout_actions" | "support_resolution_chronology",
  string
> = {
  entitlement_history: "Entitlement history",
  machine_state_timeline: "Machine state timeline",
  rollout_actions: "Rollout actions",
  support_resolution_chronology: "Support resolution chronology",
};

export function SupportOperationsPanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const { can } = usePermissions();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [bundle, setBundle] = useState<DiagnosticBundle | null>(null);
  const [offlineRows, setOfflineRows] = useState<OfflineReconciliationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ticketRows, latestBundle, offline] = await Promise.all([
        listSupportTickets(),
        getLatestDiagnosticBundle(),
        listOfflineReconciliation(),
      ]);
      setTickets(ticketRows);
      setBundle(latestBundle);
      setOfflineRows(offline);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load support workflows.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onIntervene = async (ticket: SupportTicket, nextState: SupportTicket["state"]) => {
    const note = (noteDraft[ticket.ticket_id] ?? "").trim();
    if (note.length < 3) {
      setError("Intervention note must be at least 3 characters.");
      return;
    }
    setBusyTicketId(ticket.ticket_id);
    setError(null);
    setSuccess(null);
    try {
      await createSupportIntervention(ticket.ticket_id, {
        action_code: "ticket_intervention",
        note,
        next_state: nextState,
        reason_code: "operator_action",
      }, {
        reason_code: "support-intervention",
        step_up_token: await requireStepUp("support intervention"),
      });
      setNoteDraft((prev) => ({ ...prev, [ticket.ticket_id]: "" }));
      await load();
      setSuccess(`Intervention logged for ${ticket.ticket_id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Intervention failed.");
    } finally {
      setBusyTicketId(null);
    }
  };

  const onExportTickets = async () => {
    setError(null);
    setSuccess(null);
    try {
      const blob = await downloadSupportTicketsCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "support-tickets.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSuccess("Support ticket CSV export downloaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Support ticket export failed.");
    }
  };

  const onDownloadBundleManifest = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bundle.bundle_id}.manifest.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setSuccess(`Diagnostic bundle manifest downloaded (${bundle.bundle_id}).`);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        {t(
          "audit.support.intro",
          "Structured tickets, diagnostic bundles with redaction, offline reconciliation, and explicit links to audit records.",
        )}
      </p>
      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}
      {success ? <ConsoleStatusBanner tone="success">{success}</ConsoleStatusBanner> : null}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("audit.support.tickets.title", "Tickets")}</h3>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void onExportTickets()}>
              {t("audit.support.tickets.export", "Export CSV")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t("audit.support.tickets.refresh", "Refresh")}
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("audit.support.tickets.col.id", "Ticket")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.tenant", "Tenant")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.state", "State")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.sev", "Severity")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.module", "Module")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.sync", "Sync hint")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.audit", "Linked audit IDs")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.intervene", "Intervention")}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={8} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.support.tickets.loading", "Loading tickets…")
                      : t("audit.support.tickets.empty", "No support tickets yet.")}
                  </td>
                </tr>
              ) : null}
              {tickets.map((tk) => (
                <tr key={tk.ticket_id} className="border-b border-surface-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{tk.ticket_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{tk.tenant_id}</td>
                  <td className="px-3 py-2 text-xs">{tk.state}</td>
                  <td className="px-3 py-2">
                    <OpsSeverityBadge severity={tk.severity} />
                  </td>
                  <td className="px-3 py-2">{tk.affected_module}</td>
                  <td className="max-w-[200px] px-3 py-2 text-xs text-text-secondary">{tk.sync_status_hint}</td>
                  <td className="px-3 py-2 font-mono text-[10px]">{tk.linked_audit_record_ids.join(", ") || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-[280px] items-center gap-2">
                      <Input
                        className="h-8 text-xs"
                        value={noteDraft[tk.ticket_id] ?? ""}
                        onChange={(e) =>
                          setNoteDraft((prev) => ({ ...prev, [tk.ticket_id]: e.target.value }))
                        }
                        placeholder={t("audit.support.tickets.notePh", "Intervention note")}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={busyTicketId === tk.ticket_id}
                        onClick={() =>
                          void onIntervene(
                            tk,
                            tk.state === "resolved" || tk.state === "closed" ? "resolved" : "triaged",
                          )
                        }
                      >
                        {busyTicketId === tk.ticket_id
                          ? t("audit.support.tickets.saving", "Saving…")
                          : t("audit.support.tickets.intervene", "Log intervention")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("audit.support.bundle.title", "Diagnostic bundle (export)")}</CardTitle>
          <CardDescription>
            {bundle ? `${bundle.bundle_id} · ${bundle.redaction_profile}` : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <ul className="list-inside list-disc font-mono text-xs">
            {(bundle?.artifacts ?? []).map((a) => (
              <li key={a.logical_path}>
                {a.logical_path} · {a.kind} · {a.sha256.slice(0, 12)}…
              </li>
            ))}
          </ul>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!bundle}
            onClick={onDownloadBundleManifest}
            title={!bundle ? "No diagnostic bundle is available yet." : undefined}
          >
            {t("audit.support.bundle.export", "Request signed export (VPS)")}
          </Button>
          {!bundle ? (
            <p className="text-xs text-text-muted">Export is unavailable until a diagnostic bundle exists.</p>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("audit.support.offline.title", "Offline-origin reconciliation")}
        </h3>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("audit.support.offline.col.desktop", "Desktop queue")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.vendor", "Vendor ticket")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.sync", "Sync state")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.dup", "Duplicate of")}</th>
              </tr>
            </thead>
            <tbody>
              {offlineRows.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={4} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.support.offline.loading", "Loading reconciliation rows…")
                      : t("audit.support.offline.empty", "No offline reconciliation rows.")}
                  </td>
                </tr>
              ) : null}
              {offlineRows.map((row) => (
                <tr key={row.desktop_queue_id} className="border-b border-surface-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{row.desktop_queue_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.vendor_ticket_id ?? "—"}</td>
                  <td className="px-3 py-2">{row.sync_state}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.duplicate_of ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-dashed border-surface-border bg-surface-1/50 p-4">
        <h3 className="text-sm font-semibold">{t("audit.support.exports.title", "Compliance export kinds")}</h3>
        <ul className="mt-2 list-inside list-disc text-xs text-text-secondary">
          {(Object.keys(COMPLIANCE_EXPORT_LABELS) as (keyof typeof COMPLIANCE_EXPORT_LABELS)[]).map((k) => (
            <li key={k}>{COMPLIANCE_EXPORT_LABELS[k]}</li>
          ))}
        </ul>
        {can("sync.operate") ? (
          <Button className="mt-3" type="button" size="sm" variant="secondary" asChild>
            <Link to="/vendor-console/sync">{t("audit.support.exports.syncLink", "Open sync evidence")}</Link>
          </Button>
        ) : null}
      </section>
    </div>
  );
}

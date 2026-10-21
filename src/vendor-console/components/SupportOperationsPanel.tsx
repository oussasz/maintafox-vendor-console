import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/use-permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listTenants, type ControlTenant } from "@/services/license-control-service";
import {
  createSupportIntervention,
  createSupportTicket,
  downloadSupportTicketsCsv,
  getDiagnosticBundleDownload,
  listDiagnosticBundles,
  listOfflineReconciliation,
  listSupportTickets,
  type DiagnosticBundleSummary,
  type OfflineReconciliationRow,
  type SupportTicket,
} from "@/services/vendor-audit-support-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OpsSeverityBadge } from "./opsSeverityBadge";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { useVendorConsole } from "../VendorConsoleContext";
import { errorText } from "@/lib/error-text";

/** Compliance export kinds (labels: vendorConsole `audit.support.exports.kinds.*`). */
const COMPLIANCE_EXPORT_KINDS = [
  "entitlement_history",
  "machine_state_timeline",
  "rollout_actions",
  "support_resolution_chronology",
] as const;

export function SupportOperationsPanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const { can } = usePermissions();
  /** A ticket to show first (from "Open ticket" on the Overview or a customer page). */
  const focusTicket = useSearchParams()[0].get("ticket");
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [bundles, setBundles] = useState<DiagnosticBundleSummary[]>([]);
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [newTicket, setNewTicket] = useState({
    tenant_id: "",
    severity: "warn" as SupportTicket["severity"],
    affected_module: "",
    summary: "",
  });
  const [creatingTicket, setCreatingTicket] = useState(false);
  const [downloadingBundleId, setDownloadingBundleId] = useState<string | null>(null);
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
      const [ticketRows, bundleRows, offline, tenantRows] = await Promise.all([
        listSupportTickets(),
        listDiagnosticBundles(),
        listOfflineReconciliation(),
        listTenants(),
      ]);
      setTickets(ticketRows);
      setBundles(bundleRows);
      setOfflineRows(offline);
      setTenants(tenantRows);
    } catch (err) {
      setError(errorText(err));
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
      setError(t("audit.support.tickets.noteTooShort"));
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
        step_up_token: await requireStepUp(StepUpKinds.supportIntervention),
      });
      setNoteDraft((prev) => ({ ...prev, [ticket.ticket_id]: "" }));
      await load();
      setSuccess(t("audit.support.tickets.intervened", { id: ticket.ticket_id }));
    } catch (err) {
      setError(errorText(err));
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
      setSuccess(t("audit.support.tickets.exported"));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const onCreateTicket = async () => {
    if (!newTicket.tenant_id || newTicket.affected_module.trim().length < 2 || newTicket.summary.trim().length < 3) {
      setError(t("audit.support.newTicket.incomplete"));
      return;
    }
    setCreatingTicket(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createSupportTicket({
        tenant_id: newTicket.tenant_id,
        severity: newTicket.severity,
        affected_module: newTicket.affected_module.trim(),
        summary: newTicket.summary.trim(),
      });
      setNewTicket((prev) => ({ ...prev, affected_module: "", summary: "" }));
      await load();
      setSuccess(t("audit.support.newTicket.opened", { id: created.ticket_id }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCreatingTicket(false);
    }
  };

  const onDownloadBundle = async (bundleId: string) => {
    setDownloadingBundleId(bundleId);
    setError(null);
    setSuccess(null);
    try {
      const link = await getDiagnosticBundleDownload(bundleId);
      const a = document.createElement("a");
      a.href = link.url;
      a.download = `${bundleId}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setSuccess(t("audit.support.bundle.downloadStarted", { id: bundleId, record: link.audit_record_id }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDownloadingBundleId(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-secondary">
        {t("audit.support.intro")}
      </p>
      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}
      {success ? <ConsoleStatusBanner tone="success">{success}</ConsoleStatusBanner> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("audit.support.newTicket.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-[1fr_auto_1fr_2fr_auto]">
          <select
            aria-label={t("audit.support.newTicket.tenant")}
            className="h-9 rounded-lg border border-input bg-surface-1 pl-2.5 pr-8 text-xs text-text-primary"
            value={newTicket.tenant_id}
            onChange={(e) => setNewTicket((prev) => ({ ...prev, tenant_id: e.target.value }))}
          >
            <option value="">{t("audit.support.newTicket.tenant")}</option>
            {tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.display_name}
              </option>
            ))}
          </select>
          <select
            aria-label={t("audit.support.newTicket.severity")}
            className="h-9 rounded-lg border border-input bg-surface-1 pl-2.5 pr-8 text-xs text-text-primary"
            value={newTicket.severity}
            onChange={(e) => setNewTicket((prev) => ({ ...prev, severity: e.target.value as SupportTicket["severity"] }))}
          >
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="critical">critical</option>
          </select>
          <Input
            className="h-8 text-xs"
            value={newTicket.affected_module}
            onChange={(e) => setNewTicket((prev) => ({ ...prev, affected_module: e.target.value }))}
            placeholder={t("audit.support.newTicket.module")}
          />
          <Input
            className="h-8 text-xs"
            value={newTicket.summary}
            onChange={(e) => setNewTicket((prev) => ({ ...prev, summary: e.target.value }))}
            placeholder={t("audit.support.newTicket.summary")}
          />
          <Button type="button" size="sm" disabled={creatingTicket} onClick={() => void onCreateTicket()}>
            {creatingTicket ? t("audit.support.tickets.saving") : t("audit.support.newTicket.submit")}
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("audit.support.tickets.title")}</h3>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void onExportTickets()}>
              {t("audit.support.tickets.export")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {t("audit.support.tickets.refresh")}
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("audit.support.tickets.col.id")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.tenant")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.state")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.sev")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.module")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.sync")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.audit")}</th>
                <th className="px-3 py-2">{t("audit.support.tickets.col.intervene")}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={8} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.support.tickets.loading")
                      : t("audit.support.tickets.empty")}
                  </td>
                </tr>
              ) : null}
              {tickets.map((tk) => (
                <tr
                  key={tk.ticket_id}
                  ref={tk.ticket_id === focusTicket ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}
                  aria-current={tk.ticket_id === focusTicket ? "true" : undefined}
                  className={tk.ticket_id === focusTicket ? "border-b border-surface-border bg-attention-bg last:border-0" : "border-b border-surface-border last:border-0"}
                >
                  <td className="px-3 py-2 font-mono text-xs">{tk.ticket_id}</td>
                  <td className="px-3 py-2 font-mono text-xs">{tk.tenant_id}</td>
                  <td className="px-3 py-2 text-xs">{tk.state}</td>
                  <td className="px-3 py-2">
                    <OpsSeverityBadge severity={tk.severity} />
                  </td>
                  <td className="px-3 py-2">{tk.affected_module}</td>
                  <td className="max-w-[200px] px-3 py-2 text-xs text-text-secondary">
                    {tk.summary ?? tk.sync_status_hint ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px]">{tk.linked_audit_record_ids.join(", ") || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-[280px] items-center gap-2">
                      <Input
                        className="h-8 text-xs"
                        value={noteDraft[tk.ticket_id] ?? ""}
                        onChange={(e) =>
                          setNoteDraft((prev) => ({ ...prev, [tk.ticket_id]: e.target.value }))
                        }
                        placeholder={t("audit.support.tickets.notePh")}
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
                          ? t("audit.support.tickets.saving")
                          : t("audit.support.tickets.intervene")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t("audit.support.bundle.title")}</h3>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("audit.support.bundle.col.id")}</th>
                <th className="px-3 py-2">{t("audit.support.bundle.col.tenant")}</th>
                <th className="px-3 py-2">{t("audit.support.bundle.col.status")}</th>
                <th className="px-3 py-2">{t("audit.support.bundle.col.size")}</th>
                <th className="px-3 py-2">{t("audit.support.bundle.col.ticket")}</th>
                <th className="px-3 py-2">{t("audit.support.bundle.col.download")}</th>
              </tr>
            </thead>
            <tbody>
              {bundles.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={6} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.support.bundle.loading")
                      : t("audit.support.bundle.empty")}
                  </td>
                </tr>
              ) : null}
              {bundles.map((b) => (
                <tr key={b.bundle_id} className="border-b border-surface-border last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.bundle_id}
                    <div className="text-[10px] text-text-muted">
                      {b.created_at_rfc3339} · {b.redaction_profile} · {b.app_version ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.tenant_id ?? "—"}
                    <div className="text-[10px] text-text-muted">{b.machine_id ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs" title={b.rejection_reason ?? undefined}>
                    {b.status ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {b.byte_size === null ? "—" : `${(b.byte_size / 1024).toFixed(1)} KiB`}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{b.ticket_id ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={b.status !== "uploaded" || downloadingBundleId === b.bundle_id}
                      onClick={() => void onDownloadBundle(b.bundle_id)}
                    >
                      {t("audit.support.bundle.download")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("audit.support.offline.title")}
        </h3>
        <div className="overflow-x-auto rounded-lg border border-surface-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">{t("audit.support.offline.col.desktop")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.vendor")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.sync")}</th>
                <th className="px-3 py-2">{t("audit.support.offline.col.dup")}</th>
              </tr>
            </thead>
            <tbody>
              {offlineRows.length === 0 ? (
                <tr className="border-b border-surface-border last:border-0">
                  <td colSpan={4} className="px-3 py-4 text-center text-sm text-text-muted">
                    {loading
                      ? t("audit.support.offline.loading")
                      : t("audit.support.offline.empty")}
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
        <h3 className="text-sm font-semibold">{t("audit.support.exports.title")}</h3>
        <ul className="mt-2 list-inside list-disc text-xs text-text-secondary">
          {COMPLIANCE_EXPORT_KINDS.map((k) => (
            <li key={k}>{t(`audit.support.exports.kinds.${k}`)}</li>
          ))}
        </ul>
        {can("sync.operate") ? (
          <Button className="mt-3" type="button" size="sm" variant="secondary" asChild>
            <Link to="/vendor-console/sync">{t("audit.support.exports.syncLink")}</Link>
          </Button>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Support tab of a customer: their open and closed tickets and the diagnostic files their devices
 * sent. Working on a ticket (notes, state, downloads) happens in the Support section.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import {
  listDiagnosticBundles,
  listSupportTickets,
  type DiagnosticBundleSummary,
  type SupportTicket,
} from "@/services/vendor-audit-support-service";

import { formatDateTime } from "../ui/format";
import { EmptyState, LoadError, Loading, Panel, StatusPill, type Tone } from "../ui/kit";

const OPEN_STATES = new Set(["new", "triaged", "waiting_for_vendor", "waiting_for_customer"]);
const ticketTone = (state: string): Tone => (state === "new" ? "attention" : OPEN_STATES.has(state) ? "info" : "neutral");

export function CustomerSupportTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [bundles, setBundles] = useState<DiagnosticBundleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [allTickets, allBundles] = await Promise.all([listSupportTickets(), listDiagnosticBundles()]);
      setTickets(allTickets.filter((x) => x.tenant_id === tenantId));
      setBundles(allBundles.filter((b) => b.tenant_id === tenantId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!can("support.manage")) return <EmptyState title={t("customer.support.noAccess")} />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!tickets || !bundles) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <Panel title={t("audit.support.tickets.title")} labelledBy="customer-tickets-h">
        {tickets.length === 0 ? (
          <EmptyState title={t("customer.support.noTickets")} body={t("customer.support.noTicketsBody")} />
        ) : (
          <ul className="flex flex-col">
            {tickets.map((x) => (
              <li key={x.ticket_id} className="flex flex-wrap items-center gap-3.5 border-t border-surface-3 py-3.5 first:border-t-0">
                <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
                  <span className="font-semibold text-text-primary">{x.summary || x.affected_module}</span>
                  <span className="text-[13px] text-text-secondary">
                    {formatDateTime(x.created_at_rfc3339)}
                    {x.diagnostic_bundle_ids.length > 0 ? ` · ${t("customer.support.withFile", { count: x.diagnostic_bundle_ids.length })}` : ""}
                  </span>
                </div>
                <StatusPill tone={ticketTone(x.state)}>{t(`customer.support.state.${x.state}`)}</StatusPill>
                <Link
                  to={`/vendor-console/support?ticket=${encodeURIComponent(x.ticket_id)}`}
                  className="text-sm font-semibold text-primary hover:underline"
                >
                  {t("attention.action.openTicket")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t("customer.support.files")} labelledBy="customer-bundles-h">
        {bundles.length === 0 ? (
          <EmptyState title={t("customer.support.noFiles")} />
        ) : (
          <ul className="flex flex-col">
            {bundles.map((b) => (
              <li key={b.bundle_id} className="flex flex-wrap items-center gap-3.5 border-t border-surface-3 py-3 text-sm first:border-t-0">
                <span className="flex-1 font-mono text-xs text-text-secondary">{b.bundle_id}</span>
                <span className="text-text-secondary">{formatDateTime(b.uploaded_at_rfc3339 ?? b.created_at_rfc3339)}</span>
                {b.machine_id ? <span className="font-mono text-xs text-text-secondary">{b.machine_id}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <Link to="/vendor-console/support" className="text-sm font-semibold text-primary hover:underline">
          {t("customer.support.goToSupport")}
        </Link>
      </Panel>
    </div>
  );
}

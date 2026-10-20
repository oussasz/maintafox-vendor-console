/**
 * The customer table of the Overview and Customers pages: name, edition, devices used of seats,
 * licence end, standing, and a link to the customer's page.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import type { CustomerRow } from "@/services/console-dashboard-service";

import { customerStatusKey, customerStatusTone } from "./customer-status";
import { formatDate } from "./format";
import { EmptyState, StatusPill } from "./kit";

export function CustomerTable({
  customers,
  statusFilter,
  searchId,
  emptyAction,
}: {
  customers: CustomerRow[];
  /** Only customers with this standing (e.g. "expires_soon" from the Overview tile). */
  statusFilter?: string | null;
  searchId: string;
  emptyAction?: ReactNode;
}) {
  const { t } = useTranslation("vendorConsole");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customers.filter(
      (c) =>
        (!statusFilter || c.status === statusFilter) &&
        (!q || c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q) || c.tenant_id.toLowerCase().includes(q)),
    );
  }, [customers, query, statusFilter]);

  const licenceText = (c: CustomerRow): string => {
    if (c.licence_until) return formatDate(c.licence_until);
    if (c.licence_never_ends) return t("customers.table.noEndDate");
    if (c.licence_ended_at) return t("customers.table.ended", { date: formatDate(c.licence_ended_at) });
    return "—";
  };

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={searchId} className="flex items-center gap-2 self-end text-[13px] text-text-secondary">
        {t("customers.table.search")}
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("customers.table.searchPh")}
          className="h-10 w-56 rounded-lg border border-input bg-surface-1 px-3 text-sm text-text-primary"
        />
      </label>
      {customers.length === 0 ? (
        <EmptyState title={t("customers.table.emptyTitle")} body={t("customers.table.emptyBody")} action={emptyAction} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("customers.table.noMatch")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.04em] text-text-secondary">
                <th className="px-2 py-2.5 font-semibold">{t("customers.table.col.customer")}</th>
                <th className="px-2 py-2.5 font-semibold">{t("customers.table.col.edition")}</th>
                <th className="px-2 py-2.5 font-semibold">{t("customers.table.col.devices")}</th>
                <th className="px-2 py-2.5 font-semibold">{t("customers.table.col.licenceUntil")}</th>
                <th className="px-2 py-2.5 font-semibold">{t("customers.table.col.status")}</th>
                <th className="px-2 py-2.5">
                  <span className="sr-only">{t("customers.table.col.open")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.tenant_id} className="border-t border-surface-3">
                  <td className="px-2 py-3.5 font-semibold text-text-primary">{c.name}</td>
                  <td className="px-2 py-3.5">{c.edition_label}</td>
                  <td className="px-2 py-3.5">{t("customers.table.seats", { used: c.devices_used, seats: c.seats })}</td>
                  <td className="px-2 py-3.5">{licenceText(c)}</td>
                  <td className="px-2 py-3.5">
                    <StatusPill tone={customerStatusTone(c.status)}>{t(customerStatusKey(c.status))}</StatusPill>
                  </td>
                  <td className="px-2 py-3.5 text-right">
                    <Link
                      to={`/vendor-console/customers/${encodeURIComponent(c.tenant_id)}`}
                      aria-label={t("customers.table.openNamed", { name: c.name })}
                      className="font-semibold text-primary hover:underline"
                    >
                      {t("customers.table.open")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

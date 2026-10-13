/**
 * Customers: every customer with its standing, a filter by standing (e.g. "expires soon" from the
 * Overview), search, and a new customer. Opening one leads to its page.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { cn } from "@/lib/utils";
import { getConsoleOverview, type CustomerRow } from "@/services/console-dashboard-service";

import { CustomerFormDialog } from "../customers/CustomerFormDialog";
import { CustomerTable } from "../ui/CustomerTable";
import { KNOWN_CUSTOMER_STATUSES } from "../ui/customer-status";
import { LoadError, Loading, PageHeader, Panel } from "../ui/kit";

export function CustomersPage() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = params.get("status");
  const creating = params.get("new") === "1" && can("customer.manage");

  const load = useCallback(async () => {
    setError(null);
    try {
      setCustomers((await getConsoleOverview()).customers);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const counts = new Map<string, number>();
  for (const c of customers ?? []) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("nav.customers")}
        subtitle={t("customers.page.subtitle")}
        actions={
          can("customer.manage") ? (
            <Button type="button" onClick={() => setParam("new", "1")}>
              {t("overview.newCustomer")}
            </Button>
          ) : null
        }
      />
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {!customers && !error ? <Loading /> : null}
      {customers ? (
        <Panel>
          <div role="group" aria-label={t("customers.page.filter")} className="flex flex-wrap gap-2">
            {[null, ...KNOWN_CUSTOMER_STATUSES].map((s) => (
              <button
                key={s ?? "all"}
                type="button"
                aria-pressed={status === s}
                onClick={() => setParam("status", s)}
                className={cn(
                  "h-9 rounded-full border px-3.5 text-[13px] font-semibold",
                  status === s ? "border-primary bg-primary-bg text-primary" : "border-input bg-white text-text-secondary hover:text-text-primary",
                )}
              >
                {s ? t(`customers.status.${s}`) : t("customers.page.all")} ({s ? (counts.get(s) ?? 0) : customers.length})
              </button>
            ))}
          </div>
          <CustomerTable
            customers={customers}
            statusFilter={status}
            searchId="customers-search"
            emptyAction={
              can("customer.manage") ? (
                <Button type="button" onClick={() => setParam("new", "1")}>
                  {t("customers.addFirstCompany")}
                </Button>
              ) : null
            }
          />
        </Panel>
      ) : null}
      <CustomerFormDialog
        open={creating}
        onClose={() => setParam("new", null)}
        onSaved={(saved) => navigate(`/vendor-console/customers/${encodeURIComponent(saved.id)}`)}
      />
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Badge, Button, Input, Label } from "@/components/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  createPaymentLink,
  getSubscription,
  reconcilePayment,
  type PaymentOrder,
  type Subscription,
} from "@/services/billing-service";
import { listTenants, type ControlTenant } from "@/services/license-control-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";

/** Licences ending within this many days are highlighted. */
const RENEWAL_WARNING_DAYS = 30;

const selectClass = "h-9 rounded-md border border-surface-border bg-surface-1 px-2 text-sm text-text-primary";

function statusVariant(status: PaymentOrder["status"]): "default" | "secondary" | "destructive" {
  if (status === "paid") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

/**
 * Billing and subscription (master plan Phase 4.4): licence term and slots, every payment exactly as
 * stored, reconciliation with SlickPay (asks SlickPay; a payment is applied only when SlickPay says
 * it is paid), and payment links for renewals and extra slots. Manual extensions (bank transfer,
 * goodwill) are licence edits on the Entitlements page, audited there.
 */
export function BillingPanel() {
  const { t } = useTranslation("vendorConsole");
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [sub, setSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<PaymentOrder | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState({ plan: "", amount: "", extra_slots: "0" });
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  useEffect(() => {
    listTenants()
      .then((list) => {
        setTenants(list);
        setTenantId((current) => current || (list[0]?.id ?? ""));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setSub(await getSubscription(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tenantId);
  }, [tenantId, load]);

  const runReconcile = async (reason: string) => {
    if (!reconciling) return;
    const result = await reconcilePayment(reconciling.id, reason);
    setSuccess(t(`billing.reconcile.outcome.${result.outcome}`, { slickpay: result.slickpay_status, defaultValue: result.outcome }));
    await load(tenantId);
  };

  const runLink = async () => {
    const created = await createPaymentLink({
      tenant_id: tenantId,
      plan: link.plan.trim(),
      amount: Number(link.amount),
      extra_slots: Number(link.extra_slots),
    });
    setCheckoutUrl(created.checkout_url);
    setSuccess(t("billing.link.created", { amount: created.total_amount, currency: created.currency }));
    await load(tenantId);
  };

  const linkValid =
    link.plan.trim().length > 0 &&
    Number.isFinite(Number(link.amount)) &&
    Number(link.amount) > 0 &&
    Number.isInteger(Number(link.extra_slots)) &&
    Number(link.extra_slots) >= 0;
  const openOrders = sub?.payments.filter((p) => p.status !== "paid" && p.slickpay_invoice_id) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("billing.title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("billing.body")}</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="billing-tenant">{t("billing.customer")}</Label>
          <select id="billing-tenant" className={selectClass} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.display_name} ({tn.slug})
              </option>
            ))}
          </select>
        </div>
      </header>

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
      {sub && !sub.slickpay_configured ? (
        <ConsoleStatusBanner tone="warning" role="status">
          {t("billing.slickpayOff")}
        </ConsoleStatusBanner>
      ) : null}
      {openOrders.length > 0 ? (
        <ConsoleStatusBanner tone="info" role="status">
          {t("billing.openOrders", { count: openOrders.length })}
        </ConsoleStatusBanner>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2">
        {sub?.licences.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-text-muted">{t("billing.noLicence")}</CardContent>
          </Card>
        ) : null}
        {sub?.licences.map((l) => (
          <Card key={l.id} data-testid={`licence-${l.id}`}>
            <CardHeader className="pb-2">
              <CardTitle className="font-mono text-sm">{l.id}</CardTitle>
              <CardDescription>
                {l.revoked_at
                  ? t("billing.licence.revoked")
                  : l.expires_at
                    ? t("billing.licence.until", { date: new Date(l.expires_at).toLocaleDateString() })
                    : t("billing.licence.noEnd")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {l.days_left !== null ? (
                <p className={l.days_left <= RENEWAL_WARNING_DAYS ? "font-medium text-amber-500" : "text-text-secondary"}>
                  {l.days_left < 0
                    ? t("billing.licence.expiredAgo", { count: -l.days_left })
                    : t("billing.licence.daysLeft", { count: l.days_left })}
                </p>
              ) : null}
              <p>{t("billing.licence.slots", { active: l.active_machines, max: l.max_machines })}</p>
              <p className="text-xs text-text-muted">{t("billing.licence.channel", { channel: l.update_channel })}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!sub?.slickpay_configured || !tenantId}
          onClick={() => {
            setCheckoutUrl(null);
            setLinkOpen(true);
          }}
        >
          {t("billing.link.button")}
        </Button>
        <Button type="button" variant="outline" asChild>
          <Link to="/vendor-console/entitlements">{t("billing.manualExtension")}</Link>
        </Button>
      </div>
      {checkoutUrl ? (
        <p className="break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm" data-testid="checkout-url">
          {checkoutUrl}
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("billing.history")}</h2>
        <div className="rounded-lg border border-surface-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.col.created")}</TableHead>
                <TableHead>{t("billing.col.plan")}</TableHead>
                <TableHead>{t("billing.col.amount")}</TableHead>
                <TableHead>{t("billing.col.status")}</TableHead>
                <TableHead>{t("billing.col.slickpay")}</TableHead>
                <TableHead className="text-right">{t("billing.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sub?.payments.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-text-muted">
                    {loading ? t("billing.loading") : t("billing.noPayments")}
                  </TableCell>
                </TableRow>
              ) : null}
              {sub?.payments.map((p) => (
                <TableRow key={p.id} data-testid={`payment-${p.id}`}>
                  <TableCell className="text-xs">{new Date(p.created_at).toLocaleString()}</TableCell>
                  <TableCell>
                    {p.plan}
                    {p.extra_slots > 0 ? (
                      <span className="ml-1 text-xs text-text-muted">{t("billing.extraSlots", { count: p.extra_slots })}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {p.total_amount} {p.currency}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(p.status)}>{t(`billing.status.${p.status}`)}</Badge>
                    {p.paid_at ? <p className="text-xs text-text-muted">{new Date(p.paid_at).toLocaleString()}</p> : null}
                    {p.error_message ? <p className="text-xs text-text-danger">{p.error_message}</p> : null}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.slickpay_invoice_id ?? t("billing.noInvoice")}
                    {p.last_reconciled_status ? (
                      <p className="text-text-muted">
                        {t("billing.lastChecked", {
                          status: p.last_reconciled_status,
                          at: p.last_reconciled_at ? new Date(p.last_reconciled_at).toLocaleString() : "",
                        })}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.slickpay_invoice_id && sub.slickpay_configured ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setReconciling(p)}>
                        {t("billing.reconcile.button")}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <OperatorActionDialog
        open={reconciling !== null}
        title={t("billing.reconcile.title")}
        description={t("billing.reconcile.body", { invoice: reconciling?.slickpay_invoice_id ?? "" })}
        confirmLabel={t("billing.reconcile.confirm")}
        onConfirm={runReconcile}
        onClose={() => setReconciling(null)}
      />

      <OperatorActionDialog
        open={linkOpen}
        title={t("billing.link.title")}
        description={sub?.extra_slot_price ? t("billing.link.body", { price: sub.extra_slot_price }) : t("billing.link.bodyNoSlotPrice")}
        confirmLabel={t("billing.link.confirm")}
        requireReason={false}
        extraValid={linkValid && (Number(link.extra_slots) === 0 || Boolean(sub?.extra_slot_price))}
        onConfirm={async () => runLink()}
        onClose={() => setLinkOpen(false)}
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="link-plan">{t("billing.link.plan")}</Label>
            <Input id="link-plan" value={link.plan} onChange={(e) => setLink({ ...link, plan: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="link-amount">{t("billing.link.amount")}</Label>
            <Input id="link-amount" inputMode="decimal" value={link.amount} onChange={(e) => setLink({ ...link, amount: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="link-slots">{t("billing.link.extraSlots")}</Label>
            <Input
              id="link-slots"
              inputMode="numeric"
              value={link.extra_slots}
              onChange={(e) => setLink({ ...link, extra_slots: e.target.value })}
            />
          </div>
        </div>
      </OperatorActionDialog>
    </div>
  );
}

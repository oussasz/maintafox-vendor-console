import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Badge, Button, Input, Label } from "@/components/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePermissions } from "@/hooks/use-permissions";
import {
  createPaymentLink,
  getBillingStatus,
  getSubscription,
  listPayments,
  listPrices,
  reconcilePayment,
  setPrice,
  type BillingStatus,
  type PaymentOrder,
  type Price,
  type PriceInput,
  type Subscription,
} from "@/services/billing-service";
import { listTenants, type ControlTenant } from "@/services/license-control-service";

import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";
import { errorText } from "@/lib/error-text";

/** Licences ending within this many days are highlighted. */
const RENEWAL_WARNING_DAYS = 30;

const selectClass = "h-11 rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";

function statusVariant(status: PaymentOrder["status"]): "default" | "secondary" | "destructive" {
  if (status === "paid") return "default";
  if (status === "failed" || status === "needs_review") return "destructive";
  return "secondary";
}

const EMPTY_PRICE = { plan: "", base_amount: "", included_seats: "1", extra_seat_amount: "0", max_extra_seats: "0", term_months: "12", is_active: true };
type PriceForm = typeof EMPTY_PRICE;

function priceFormValid(f: PriceForm): boolean {
  const money = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());
  const int = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;
  return (
    f.plan.trim().length > 0 &&
    money(f.base_amount) &&
    Number(f.base_amount) > 0 &&
    money(f.extra_seat_amount) &&
    int(f.included_seats, 1, 10_000) &&
    int(f.max_extra_seats, 0, 10_000) &&
    int(f.term_months, 1, 36)
  );
}

function priceInput(f: PriceForm): PriceInput {
  return {
    base_amount: Number(f.base_amount),
    included_seats: Number(f.included_seats),
    extra_seat_amount: Number(f.extra_seat_amount),
    max_extra_seats: Number(f.max_extra_seats),
    term_months: Number(f.term_months),
    is_active: f.is_active,
  };
}

/** One payment order's state for an operator: status, and why when a person must act. */
function OrderStatusCell({ p }: { p: PaymentOrder }) {
  const { t } = useTranslation("vendorConsole");
  return (
    <>
      <Badge variant={statusVariant(p.status)}>{t(`billing.status.${p.status}`)}</Badge>
      {p.paid_at ? <p className="text-xs text-text-muted">{new Date(p.paid_at).toLocaleString()}</p> : null}
      {p.status === "paid" && p.licence_delivery ? (
        <p className={p.licence_delivery === "sent" ? "text-xs text-text-muted" : "text-xs text-attention-text"}>
          {t(`billing.delivery.${p.licence_delivery}`)}
        </p>
      ) : null}
      {p.error_message ? (
        <p className="text-xs text-text-danger">{t(`billing.reason.${p.error_message}`, { defaultValue: p.error_message })}</p>
      ) : null}
      {p.last_check_error && p.status === "awaiting_payment" ? (
        <p className="text-xs text-attention-text">{t("billing.lastCheckError", { error: p.last_check_error })}</p>
      ) : null}
    </>
  );
}

/**
 * Billing: licence term and slots, every payment exactly as stored, reconciliation with SlickPay
 * (asks SlickPay; a payment is applied only when SlickPay says it is paid), payment links priced
 * by the server, and (on the Billing page) the price list, the SlickPay set-up and the payments
 * that wait for a person. Manual extensions (bank transfer, goodwill) are licence edits on the
 * Entitlements page, audited there.
 */
export function BillingPanel({ fixedTenantId }: { /** Shown inside a customer page: that customer only, no selector. */ fixedTenantId?: string } = {}) {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const showBillingPage = !fixedTenantId;
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [tenantId, setTenantId] = useState(fixedTenantId ?? "");
  const [sub, setSub] = useState<Subscription | null>(null);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [prices, setPrices] = useState<Price[]>([]);
  const [review, setReview] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<PaymentOrder | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState({ plan: "", extra_slots: "0", firstname: "", lastname: "", email: "", phone: "" });
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [priceForm, setPriceForm] = useState<PriceForm | null>(null);

  useEffect(() => {
    if (fixedTenantId) return;
    listTenants()
      .then((list) => {
        setTenants(list);
        setTenantId((current) => current || (list[0]?.id ?? ""));
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [fixedTenantId]);

  const loadOverview = useCallback(async () => {
    if (!showBillingPage) return;
    try {
      const [s, p, r] = await Promise.all([getBillingStatus(), listPrices(), listPayments({ status: "needs_review" })]);
      setStatus(s);
      setPrices(p);
      setReview(r);
    } catch (err) {
      setError(errorText(err));
    }
  }, [showBillingPage]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setSub(await getSubscription(id));
    } catch (err) {
      setError(errorText(err));
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
    await Promise.all([load(tenantId), loadOverview()]);
  };

  const linkPrice = sub?.prices.find((p) => p.plan === link.plan) ?? null;
  const linkSlots = Number(link.extra_slots);
  const linkTotal = linkPrice && Number.isInteger(linkSlots) ? linkPrice.base_amount + linkSlots * linkPrice.extra_seat_amount : null;
  const linkValid =
    linkPrice !== null &&
    Number.isInteger(linkSlots) &&
    linkSlots >= 0 &&
    linkSlots <= linkPrice.max_extra_seats &&
    link.firstname.trim().length > 0 &&
    link.lastname.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+$/.test(link.email.trim()) &&
    link.phone.trim().length >= 6;

  const runLink = async () => {
    const created = await createPaymentLink({
      tenant_id: tenantId,
      plan: link.plan,
      extra_slots: linkSlots,
      buyer: { firstname: link.firstname.trim(), lastname: link.lastname.trim(), email: link.email.trim(), phone: link.phone.trim() },
    });
    setCheckoutUrl(created.checkout_url);
    setSuccess(t("billing.link.created", { amount: created.total_amount, currency: created.currency }));
    await load(tenantId);
  };

  const runPrice = async (reason: string) => {
    if (!priceForm) return;
    await setPrice(priceForm.plan.trim(), priceInput(priceForm), reason);
    setSuccess(t("billing.prices.saved", { plan: priceForm.plan.trim() }));
    await Promise.all([loadOverview(), load(tenantId)]);
  };

  const openOrders = sub?.payments.filter((p) => p.status === "awaiting_payment") ?? [];
  const slickpayConfigured = sub ? sub.slickpay_configured : status ? status.slickpay.mode === "enabled" : null;

  return (
    <div className="space-y-6">
      {fixedTenantId ? null : (
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold text-text-primary">{t("billing.title")}</h2>
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
      )}

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
      {slickpayConfigured === false ? (
        <ConsoleStatusBanner tone="warning" role="status">
          {t("billing.slickpayOff")}
        </ConsoleStatusBanner>
      ) : null}
      {status && status.slickpay.mode === "enabled" && status.email_delivery === "disabled" ? (
        <ConsoleStatusBanner tone="warning" role="status">
          {t("billing.emailOff")}
        </ConsoleStatusBanner>
      ) : null}
      {status && status.slickpay.ignored_settings.length > 0 ? (
        <ConsoleStatusBanner tone="warning" role="status">
          {t("billing.ignoredSettings", { names: status.slickpay.ignored_settings.join(", ") })}
        </ConsoleStatusBanner>
      ) : null}
      {status?.reconciler && !status.reconciler.ok ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {t("billing.reconcilerFailed", { at: new Date(status.reconciler.at_rfc3339).toLocaleString() })}
        </ConsoleStatusBanner>
      ) : null}
      {openOrders.length > 0 ? (
        <ConsoleStatusBanner tone="info" role="status">
          {t("billing.openOrders", { count: openOrders.length })}
        </ConsoleStatusBanner>
      ) : null}

      {showBillingPage && review.length > 0 ? (
        <section className="space-y-2" data-testid="needs-review">
          <h2 className="text-sm font-semibold text-text-danger">{t("billing.review.title", { count: review.length })}</h2>
          <p className="text-sm text-text-secondary">{t("billing.review.body")}</p>
          <div className="rounded-lg border border-surface-border">
            <Table>
              <TableBody>
                {review.map((p) => (
                  <TableRow key={p.id} data-testid={`review-${p.id}`}>
                    <TableCell className="text-xs">{new Date(p.created_at).toLocaleString()}</TableCell>
                    <TableCell>{p.buyer_company ?? p.tenant_id ?? p.id}</TableCell>
                    <TableCell>
                      {p.total_amount} {p.currency}
                    </TableCell>
                    <TableCell>
                      <OrderStatusCell p={p} />
                    </TableCell>
                    <TableCell className="text-right">
                      {p.slickpay_invoice_id && status?.slickpay.mode === "enabled" ? (
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
                <p className={l.days_left <= RENEWAL_WARNING_DAYS ? "font-medium text-attention-text" : "text-text-secondary"}>
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
          disabled={!sub?.slickpay_configured || !tenantId || (sub?.prices.length ?? 0) === 0}
          onClick={() => {
            setCheckoutUrl(null);
            setLink({ plan: sub?.prices.find((p) => p.plan === sub.edition)?.plan ?? sub?.prices[0]?.plan ?? "", extra_slots: "0", firstname: "", lastname: "", email: "", phone: "" });
            setLinkOpen(true);
          }}
        >
          {t("billing.link.button")}
        </Button>
        <Button type="button" variant="outline" asChild>
          <Link to="/vendor-console/entitlements">{t("billing.manualExtension")}</Link>
        </Button>
      </div>
      {sub?.slickpay_configured && sub.prices.length === 0 ? <p className="text-sm text-attention-text">{t("billing.link.noPrices")}</p> : null}
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
                    {p.slickpay_paid_amount !== null ? (
                      <p className="text-xs text-text-muted">{t("billing.paidAmount", { amount: p.slickpay_paid_amount, currency: p.currency })}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <OrderStatusCell p={p} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.slickpay_invoice_id ?? t("billing.noInvoice")}
                    {p.slickpay_transaction_ref ? <p className="font-mono text-text-muted">{p.slickpay_transaction_ref}</p> : null}
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

      {showBillingPage ? (
        <section className="space-y-2" data-testid="price-list">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">{t("billing.prices.title")}</h2>
              <p className="text-sm text-text-secondary">{t("billing.prices.body")}</p>
            </div>
            {can("billing.price_manage") ? (
              <Button type="button" variant="outline" onClick={() => setPriceForm({ ...EMPTY_PRICE })}>
                {t("billing.prices.add")}
              </Button>
            ) : null}
          </div>
          <div className="rounded-lg border border-surface-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("billing.prices.plan")}</TableHead>
                  <TableHead>{t("billing.prices.base")}</TableHead>
                  <TableHead>{t("billing.prices.included")}</TableHead>
                  <TableHead>{t("billing.prices.extra")}</TableHead>
                  <TableHead>{t("billing.prices.term")}</TableHead>
                  <TableHead>{t("billing.prices.state")}</TableHead>
                  <TableHead className="text-right">{t("billing.col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-attention-text">
                      {t("billing.prices.none")}
                    </TableCell>
                  </TableRow>
                ) : null}
                {prices.map((p) => (
                  <TableRow key={p.plan} data-testid={`price-${p.plan}`}>
                    <TableCell className="font-medium">{p.plan}</TableCell>
                    <TableCell>
                      {p.base_amount} {p.currency}
                    </TableCell>
                    <TableCell>{p.included_seats}</TableCell>
                    <TableCell>{t("billing.prices.extraValue", { amount: p.extra_seat_amount, currency: p.currency, max: p.max_extra_seats })}</TableCell>
                    <TableCell>{t("billing.prices.termValue", { count: p.term_months })}</TableCell>
                    <TableCell>{p.is_active ? t("billing.prices.active") : t("billing.prices.inactive")}</TableCell>
                    <TableCell className="text-right">
                      {can("billing.price_manage") ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setPriceForm({
                              plan: p.plan,
                              base_amount: String(p.base_amount),
                              included_seats: String(p.included_seats),
                              extra_seat_amount: String(p.extra_seat_amount),
                              max_extra_seats: String(p.max_extra_seats),
                              term_months: String(p.term_months),
                              is_active: p.is_active,
                            })
                          }
                        >
                          {t("billing.prices.edit")}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {status?.slickpay.mode === "enabled" ? (
            <p className="text-xs text-text-muted" data-testid="slickpay-setup">
              {t("billing.setup", {
                webhook: status.slickpay.webhook_url ?? "",
                returnUrl: status.slickpay.return_url ?? "",
                interval: status.slickpay.reconcile_interval_minutes ?? "",
                expiry: status.slickpay.order_expiry_hours ?? "",
                lastRun: status.reconciler ? new Date(status.reconciler.at_rfc3339).toLocaleString() : t("billing.never"),
              })}
            </p>
          ) : null}
        </section>
      ) : null}

      <OperatorActionDialog
        open={reconciling !== null}
        title={t("billing.reconcile.title")}
        description={t("billing.reconcile.body", { invoice: reconciling?.slickpay_invoice_id ?? "" })}
        confirmLabel={t("billing.reconcile.confirm")}
        onConfirm={runReconcile}
        onClose={() => setReconciling(null)}
      />

      <OperatorActionDialog
        open={priceForm !== null}
        title={t("billing.prices.dialogTitle")}
        description={t("billing.prices.dialogBody")}
        confirmLabel={t("billing.prices.save")}
        extraValid={priceForm !== null && priceFormValid(priceForm)}
        onConfirm={runPrice}
        onClose={() => setPriceForm(null)}
      >
        {priceForm ? (
          <div className="grid gap-3">
            {(
              [
                ["plan", "billing.prices.plan", "text"],
                ["base_amount", "billing.prices.base", "decimal"],
                ["included_seats", "billing.prices.included", "numeric"],
                ["extra_seat_amount", "billing.prices.extra", "decimal"],
                ["max_extra_seats", "billing.prices.maxExtra", "numeric"],
                ["term_months", "billing.prices.termMonths", "numeric"],
              ] as const
            ).map(([field, label, mode]) => (
              <div key={field} className="grid gap-1">
                <Label htmlFor={`price-${field}`}>{t(label)}</Label>
                <Input
                  id={`price-${field}`}
                  inputMode={mode}
                  value={priceForm[field]}
                  onChange={(e) => setPriceForm({ ...priceForm, [field]: e.target.value })}
                />
              </div>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={priceForm.is_active} onChange={(e) => setPriceForm({ ...priceForm, is_active: e.target.checked })} />
              {t("billing.prices.activeLabel")}
            </label>
          </div>
        ) : null}
      </OperatorActionDialog>

      <OperatorActionDialog
        open={linkOpen}
        title={t("billing.link.title")}
        description={t("billing.link.body")}
        confirmLabel={t("billing.link.confirm")}
        requireReason={false}
        extraValid={linkValid}
        onConfirm={async () => runLink()}
        onClose={() => setLinkOpen(false)}
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="link-plan">{t("billing.link.plan")}</Label>
            <select id="link-plan" className={selectClass} value={link.plan} onChange={(e) => setLink({ ...link, plan: e.target.value })}>
              {sub?.prices.map((p) => (
                <option key={p.plan} value={p.plan}>
                  {p.plan}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="link-slots">{t("billing.link.extraSlots")}</Label>
            <Input id="link-slots" inputMode="numeric" value={link.extra_slots} onChange={(e) => setLink({ ...link, extra_slots: e.target.value })} />
          </div>
          {(
            [
              ["firstname", "billing.link.firstname"],
              ["lastname", "billing.link.lastname"],
              ["email", "billing.link.email"],
              ["phone", "billing.link.phone"],
            ] as const
          ).map(([field, label]) => (
            <div key={field} className="grid gap-1">
              <Label htmlFor={`link-${field}`}>{t(label)}</Label>
              <Input id={`link-${field}`} value={link[field]} onChange={(e) => setLink({ ...link, [field]: e.target.value })} />
            </div>
          ))}
          {linkTotal !== null && linkPrice ? (
            <p className="text-sm font-medium" data-testid="link-total">
              {t("billing.link.total", { amount: linkTotal, currency: linkPrice.currency, months: linkPrice.term_months })}
            </p>
          ) : null}
        </div>
      </OperatorActionDialog>
    </div>
  );
}

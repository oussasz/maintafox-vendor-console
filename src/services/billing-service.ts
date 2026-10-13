/**
 * Billing (control API routes/billing.ts, deploy/BILLING.md): payment history exactly as stored,
 * licence term and slots, the server-side price list, reconciliation with SlickPay (asks SlickPay;
 * applies a payment only when SlickPay says it is paid), and payment links priced by the server.
 */
import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import { apiRequestError } from "@/lib/api-error";

export const PAYMENT_STATUSES = ["pending", "awaiting_payment", "paid", "failed", "expired", "needs_review"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const PaymentOrderSchema = z.object({
  id: z.string(),
  /** Null for a new customer's order until it is paid (the customer is created on payment). */
  tenant_id: z.string().nullable(),
  license_id: z.string().nullable(),
  plan: z.string(),
  amount: z.number(),
  extra_slots: z.number().int(),
  total_amount: z.number(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  slickpay_invoice_id: z.string().nullable(),
  paid_at: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_reconciled_at: z.string().nullable(),
  last_reconciled_status: z.string().nullable(),
  slickpay_paid_amount: z.number().nullable(),
  slickpay_transaction_ref: z.string().nullable(),
  last_check_error: z.string().nullable(),
  licence_delivery: z.enum(["pending", "sent", "failed", "disabled"]).nullable(),
  buyer_company: z.string().nullable(),
});
export type PaymentOrder = z.infer<typeof PaymentOrderSchema>;

const LicenceTermSchema = z.object({
  id: z.string(),
  max_machines: z.number().int(),
  active_machines: z.number().int(),
  expires_at: z.string().nullable(),
  days_left: z.number().int().nullable(),
  revoked_at: z.string().nullable(),
  update_channel: z.string(),
});
export type LicenceTerm = z.infer<typeof LicenceTermSchema>;

const PriceSchema = z.object({
  plan: z.string(),
  base_amount: z.number(),
  included_seats: z.number().int(),
  extra_seat_amount: z.number(),
  max_extra_seats: z.number().int(),
  term_months: z.number().int(),
  currency: z.string(),
  is_active: z.boolean(),
  updated_at: z.string(),
  updated_by: z.string(),
});
export type Price = z.infer<typeof PriceSchema>;
export type PriceInput = Pick<Price, "base_amount" | "included_seats" | "extra_seat_amount" | "max_extra_seats" | "term_months" | "is_active">;

const SubscriptionSchema = z.object({
  tenant_id: z.string(),
  edition: z.string(),
  licences: z.array(LicenceTermSchema),
  payments: z.array(PaymentOrderSchema),
  slickpay_configured: z.boolean(),
  /** Active prices (the plans a payment link can be made for). */
  prices: z.array(PriceSchema),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

const WorkerRunSchema = z.object({ at_rfc3339: z.string(), ok: z.boolean(), detail: z.record(z.unknown()) });
const BillingStatusSchema = z.object({
  slickpay: z.object({
    mode: z.enum(["disabled", "enabled"]),
    api_base_url: z.string().optional(),
    webhook_url: z.string().optional(),
    return_url: z.string().optional(),
    reconcile_interval_minutes: z.number().optional(),
    order_expiry_hours: z.number().optional(),
    ignored_settings: z.array(z.string()),
  }),
  email_delivery: z.enum(["disabled", "smtp"]),
  reconciler: WorkerRunSchema.nullable(),
  orders_by_status: z.record(z.number()),
});
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

const ReconcileResultSchema = z.object({
  payment_order_id: z.string(),
  stored_status: z.enum(PAYMENT_STATUSES),
  slickpay_status: z.string(),
  applied: z.boolean(),
  outcome: z.string(),
  order: PaymentOrderSchema,
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;

async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) throw await apiRequestError(res);
  return schema.parse(await res.json());
}

export async function getSubscription(tenantId: string): Promise<Subscription> {
  return json(await authFetch(`/api/v1/billing/tenants/${encodeURIComponent(tenantId)}/subscription`), SubscriptionSchema);
}

export async function listPayments(filter: { status?: PaymentStatus } = {}): Promise<PaymentOrder[]> {
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  return json(await authFetch(`/api/v1/billing/payments${q}`), z.array(PaymentOrderSchema));
}

/** SlickPay settings in effect (no key), the reconciliation worker's last run, orders per status. */
export async function getBillingStatus(): Promise<BillingStatus> {
  return json(await authFetch("/api/v1/billing/status"), BillingStatusSchema);
}

export async function listPrices(): Promise<Price[]> {
  return json(await authFetch("/api/v1/billing/prices"), z.array(PriceSchema));
}

/** Sets one plan's price (owner); audited with the reason. */
export async function setPrice(plan: string, input: PriceInput, reason: string): Promise<Price> {
  const res = await authFetch(`/api/v1/billing/prices/${encodeURIComponent(plan)}`, {
    method: "PUT",
    headers: { "X-Operator-Reason": reason },
    body: JSON.stringify(input),
  });
  return json(res, PriceSchema);
}

/** Asks SlickPay for the invoice's real status; a paid invoice not yet applied is applied now. */
export async function reconcilePayment(orderId: string, reason: string): Promise<ReconcileResult> {
  const res = await authFetch(`/api/v1/billing/payments/${encodeURIComponent(orderId)}/reconcile`, {
    method: "POST",
    headers: { "X-Operator-Reason": reason },
  });
  return json(res, ReconcileResultSchema);
}

export type PaymentLinkBuyer = { firstname: string; lastname: string; email: string; phone: string };

/** A SlickPay invoice for an existing customer, priced by the server; returns the link to send. */
export async function createPaymentLink(input: {
  tenant_id: string;
  plan: string;
  extra_slots: number;
  buyer: PaymentLinkBuyer;
}): Promise<{ checkout_url: string; payment_order_id: string; total_amount: number; currency: string }> {
  const res = await authFetch("/api/v1/billing/payment-links", { method: "POST", body: JSON.stringify(input) });
  return json(
    res,
    z.object({ checkout_url: z.string().url(), payment_order_id: z.string(), total_amount: z.number(), currency: z.string() }),
  );
}

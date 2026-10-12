/**
 * Billing and subscription (control API routes/billing.ts, master plan Phase 4.4): payment history
 * exactly as stored, licence term and slots, reconciliation with SlickPay (asks SlickPay; applies a
 * payment only when SlickPay says it is paid), payment links for renewals and extra slots.
 */
import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import { parseControlPlaneErrorResponse } from "@/services/license-control-service";

export const PAYMENT_STATUSES = ["pending", "awaiting_payment", "paid", "failed"] as const;

const PaymentOrderSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
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

const SubscriptionSchema = z.object({
  tenant_id: z.string(),
  licences: z.array(LicenceTermSchema),
  payments: z.array(PaymentOrderSchema),
  slickpay_configured: z.boolean(),
  extra_slot_price: z.number().nullable(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

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
  if (!res.ok) throw new Error(await parseControlPlaneErrorResponse(res));
  return schema.parse(await res.json());
}

export async function getSubscription(tenantId: string): Promise<Subscription> {
  return json(await authFetch(`/api/v1/billing/tenants/${encodeURIComponent(tenantId)}/subscription`), SubscriptionSchema);
}

export async function listPayments(filter: { status?: (typeof PAYMENT_STATUSES)[number] } = {}): Promise<PaymentOrder[]> {
  const q = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  return json(await authFetch(`/api/v1/billing/payments${q}`), z.array(PaymentOrderSchema));
}

/** Asks SlickPay for the invoice's real status; a paid invoice not yet applied is applied now. */
export async function reconcilePayment(orderId: string, reason: string): Promise<ReconcileResult> {
  const res = await authFetch(`/api/v1/billing/payments/${encodeURIComponent(orderId)}/reconcile`, {
    method: "POST",
    headers: { "X-Operator-Reason": reason },
  });
  return json(res, ReconcileResultSchema);
}

/** Creates a SlickPay invoice for an existing customer; returns the link to send them. */
export async function createPaymentLink(input: {
  tenant_id: string;
  plan: string;
  amount: number;
  extra_slots: number;
}): Promise<{ checkout_url: string; payment_order_id: string; total_amount: number; currency: string }> {
  const res = await authFetch("/api/v1/payments/slickpay/initiate", { method: "POST", body: JSON.stringify(input) });
  return json(
    res,
    z.object({ checkout_url: z.string().url(), payment_order_id: z.string(), total_amount: z.number(), currency: z.string() }),
  );
}

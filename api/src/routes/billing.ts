/**
 * Billing (deploy/BILLING.md): SlickPay checkout, the webhook, the customer's order status page,
 * the reconciliation worker, and the console's billing views.
 *
 * Rules:
 * - The server owns the price (billing_price_list, set by the owner). A caller's amount is only
 *   compared with it (409 price_changed), never charged.
 * - Nothing is granted on a webhook, a redirect or a query parameter alone: the invoice status is
 *   always read back from SlickPay server to server, with the invoice id stored on our order.
 * - One SlickPay invoice belongs to one order (unique index) and an order is fulfilled once, under a
 *   row lock: duplicate or concurrent confirmations change nothing the second time.
 * - A paid order that cannot be fulfilled automatically becomes needs_review (shown on the console),
 *   never failed: money taken is never silently dropped.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { EMAIL_CONFIG, PRIVILEGED_REASON_MIN_LENGTH, SLICKPAY_CONFIG } from "../app/config.js";
import {
  paymentWebhookRateLimiter,
  publicCheckoutRateLimiter,
  publicPaymentReadRateLimiter,
  resolveActorId,
  sendValidationError,
} from "../app/http.js";
import { workerState } from "../app/observability.js";
import { newId, randomLicenseKey, safeEqualUtf8, structuredLog } from "../app/runtime.js";
import { systemScopeMiddleware } from "../app/scope.js";
import {
  createSlickPayClient,
  interpretInvoice,
  newSecretToken,
  OBSOLETE_SLICKPAY_SETTINGS,
  readCreatedInvoice,
  readWebhookHint,
  roundAmount,
  sha256Hex,
  type InvoiceVerdict,
} from "../billing/slickpay.js";
import { editionExists } from "../edition-catalog-store.js";
import { createEmailSender } from "../notifications/email.js";

/** Customer details SlickPay needs on an invoice without a saved contact (Create Invoice docs). */
const BuyerSchema = z
  .object({
    firstname: z.string().trim().min(1).max(128),
    lastname: z.string().trim().min(1).max(128),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(6).max(32),
    company: z.string().trim().min(2).max(128).optional(),
    address: z.string().trim().min(2).max(256).optional(),
    tax_id: z.string().trim().max(64).optional(),
  })
  .strip();
type Buyer = z.infer<typeof BuyerSchema>;

const PublicInitiateBody = z
  .object({
    plan: z.string().trim().min(1).max(64),
    extra_slots: z.number().int().min(0).max(10_000).optional().default(0),
    tenant_id: z.string().trim().min(3).max(128).optional(),
    user_info: BuyerSchema,
    /** The total the customer was shown; refused (409) if it is no longer the server's price. */
    expected_total_amount: z.number().positive().optional(),
    /** Deprecated name of expected_total_amount (website before this version). */
    amount: z.number().positive().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.tenant_id && !body.user_info.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["user_info", "company"], message: "company is required for a new customer" });
    }
  });

const PaymentLinkBody = z
  .object({
    tenant_id: z.string().trim().min(3).max(128),
    plan: z.string().trim().min(1).max(64),
    extra_slots: z.number().int().min(0).max(10_000),
    buyer: BuyerSchema,
  })
  .strict();

const Money = z.number().positive().max(1_000_000_000).refine((v) => roundAmount(v) === v, "at most 2 decimals");
const PriceBody = z
  .object({
    base_amount: Money,
    included_seats: z.number().int().min(1).max(10_000),
    extra_seat_amount: z.number().min(0).max(1_000_000_000).refine((v) => roundAmount(v) === v, "at most 2 decimals"),
    max_extra_seats: z.number().int().min(0).max(10_000),
    term_months: z.number().int().min(1).max(36),
    is_active: z.boolean(),
  })
  .strict();

const ORDER_STATUSES = ["pending", "awaiting_payment", "paid", "failed", "expired", "needs_review"] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];
const PaymentsQuery = z
  .object({ status: z.enum(ORDER_STATUSES).optional(), tenant_id: z.string().min(3).optional() })
  .strict();

/** Order columns shown to operators (customer contact data stays server-side; company is shown). */
const PAYMENT_ORDER_COLUMNS = `id, tenant_id, license_id, plan, amount, extra_slots, total_amount, currency, status,
  slickpay_invoice_id, paid_at, error_message, created_at, updated_at, last_reconciled_at, last_reconciled_status,
  included_seats, extra_seat_amount, term_months, slickpay_paid_amount, slickpay_transaction_ref, next_check_at,
  check_attempts, last_check_error, licence_delivery, user_info_json`;

/**
 * The customer's status page reads SlickPay at most this often per order: enough to confirm a
 * payment within seconds of the return, without one page load per poll reaching SlickPay.
 */
const STATUS_PAGE_MIN_RECHECK_MS = 10_000;
/** Back-off of the automatic re-checks: interval x 2^attempts, the exponent capped here. */
const MAX_BACKOFF_EXPONENT = 10;
/** Orders the reconciliation worker checks per run (the rest wait for the next run). */
const RECONCILE_BATCH_SIZE = 50;

type OrderRow = {
  id: string;
  tenant_id: string | null;
  license_id: string | null;
  plan: string;
  amount: number;
  extra_slots: number;
  total_amount: number;
  currency: string;
  status: OrderStatus;
  slickpay_invoice_id: string | null;
  user_info_json: string | null;
  included_seats: number | null;
  term_months: number | null;
  created_at: string;
  check_attempts: number;
  last_reconciled_at: string | null;
  status_token_sha256: string | null;
  webhook_token_sha256: string | null;
  paid_at: string | null;
  licence_delivery: string | null;
};
const ORDER_ROW_COLUMNS = `id, tenant_id, license_id, plan, amount, extra_slots, total_amount, currency, status,
  slickpay_invoice_id, user_info_json, included_seats, term_months, created_at, check_attempts, last_reconciled_at,
  status_token_sha256, webhook_token_sha256, paid_at, licence_delivery`;

type PriceRow = {
  plan: string;
  base_amount: number;
  included_seats: number;
  extra_seat_amount: number;
  max_extra_seats: number;
  term_months: number;
  currency: string;
  is_active: boolean;
  updated_at: string;
  updated_by: string;
};

export type VerifyOutcome =
  | { kind: "applied"; licenseId: string; expiresAt: string; licenseIssued: boolean }
  | { kind: "already_paid" }
  | { kind: "not_paid"; expired: boolean }
  | { kind: "status_unrecognised"; needsReview: boolean }
  | { kind: "amount_mismatch" }
  | { kind: "needs_review"; reason: string }
  | { kind: "slickpay_unreachable" }
  | { kind: "slickpay_error"; httpStatus: number }
  | { kind: "no_invoice" }
  | { kind: "not_found" };

type Actor = { actor_id: string; reason_code: string; source: "webhook" | "status_page" | "reconciler" | "operator" };

function parseBuyer(json: string | null): Buyer | null {
  if (!json) return null;
  try {
    const parsed = BuyerSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function addMonths(fromIso: string, months: number): string {
  const d = new Date(fromIso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

/** Days from now to `expiresAt` (negative once expired); null for a licence without end. */
function daysLeft(expiresAt: string | null, nowMs = Date.now()): number | null {
  if (!expiresAt) return null;
  return Math.floor((Date.parse(expiresAt) - nowMs) / 86_400_000);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function slugifyTenantSlug(raw: string): string {
  const ascii = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const clipped = ascii.slice(0, 48).replace(/-+$/g, "");
  return clipped.length >= 2 ? clipped : "customer";
}

function priceFromRow(row: Record<string, unknown>): PriceRow {
  return {
    plan: String(row.plan),
    base_amount: Number(row.base_amount),
    included_seats: Number(row.included_seats),
    extra_seat_amount: Number(row.extra_seat_amount),
    max_extra_seats: Number(row.max_extra_seats),
    term_months: Number(row.term_months),
    currency: String(row.currency),
    is_active: row.is_active === true,
    updated_at: String(row.updated_at),
    updated_by: String(row.updated_by),
  };
}

function publicPrice(p: PriceRow) {
  return {
    plan: p.plan,
    base_amount: p.base_amount,
    included_seats: p.included_seats,
    extra_seat_amount: p.extra_seat_amount,
    max_extra_seats: p.max_extra_seats,
    term_months: p.term_months,
    currency: p.currency,
  };
}

/** What the customer's status page may show: no ids beyond the order's own, no contact data. */
function publicStatus(status: OrderStatus): "pending" | "paid" | "failed" | "expired" | "review" {
  if (status === "paid") return "paid";
  if (status === "failed") return "failed";
  if (status === "expired") return "expired";
  if (status === "needs_review") return "review";
  return "pending";
}

/** Plain-text licence e-mail (FR + EN): no HTML, nothing to sanitise or track. */
function renderLicenceEmail(input: {
  plan: string;
  licenceKey: string | null;
  expiresAt: string;
  maxMachines: number;
  orderId: string;
}): { subject: string; text: string } {
  const date = input.expiresAt.slice(0, 10);
  const lines = [
    "Bonjour,",
    "",
    `Votre paiement Maintafox (${input.plan}) est confirmé.`,
    input.licenceKey ? `Votre clé de licence : ${input.licenceKey}` : "Votre licence existante a été prolongée.",
    `Valable jusqu'au ${date} (UTC), ${input.maxMachines} poste(s).`,
    `Référence de commande : ${input.orderId}`,
    "",
    "---",
    "",
    "Hello,",
    "",
    `Your Maintafox payment (${input.plan}) is confirmed.`,
    input.licenceKey ? `Your licence key: ${input.licenceKey}` : "Your existing licence has been extended.",
    `Valid until ${date} (UTC), ${input.maxMachines} seat(s).`,
    `Order reference: ${input.orderId}`,
  ];
  return { subject: "Maintafox - paiement confirmé / payment confirmed", text: lines.join("\n") };
}

/** Fulfilment stopped for a person to look at; thrown to roll the fulfilment transaction back. */
class NeedsReview extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type BillingWorker = { reconcileDueOrders(): Promise<Record<string, number>> };

export function registerBillingRoutes(app: express.Express, ctx: ApiContext): BillingWorker {
  const { db, appendAuditRecord, insertTenantRow, pickActiveLicenseForTenant, authMiddleware, countActiveActivations } = ctx;
  const config = SLICKPAY_CONFIG;
  const slickpay = config.mode === "enabled" ? createSlickPayClient(config) : null;
  const emailSender = EMAIL_CONFIG.mode === "smtp" ? createEmailSender(EMAIL_CONFIG) : null;

  const ignoredSettings = OBSOLETE_SLICKPAY_SETTINGS.filter((name) => Boolean(process.env[name]?.trim()));
  if (ignoredSettings.length > 0) {
    structuredLog("slickpay_obsolete_settings_ignored", { settings: ignoredSettings });
  }
  structuredLog("slickpay_config", {
    mode: config.mode,
    ...(config.mode === "enabled"
      ? {
          api_base_url: config.apiBaseUrl,
          webhook_url: config.webhookUrl,
          return_url: config.returnUrl,
          http_timeout_ms: config.httpTimeoutMs,
          reconcile_interval_minutes: config.reconcileIntervalMinutes,
          order_expiry_hours: config.orderExpiryHours,
        }
      : {}),
  });

  async function loadOrder(orderId: string): Promise<OrderRow | undefined> {
    return db.get<OrderRow>(`SELECT ${ORDER_ROW_COLUMNS} FROM payment_orders WHERE id = ?`, orderId);
  }

  async function loadPrice(plan: string): Promise<PriceRow | undefined> {
    const row = await db.get<Record<string, unknown>>("SELECT * FROM billing_price_list WHERE plan = ?", plan);
    return row ? priceFromRow(row) : undefined;
  }

  function nextCheckAt(attempts: number): string {
    const minutes = (config.mode === "enabled" ? config.reconcileIntervalMinutes : 0) * 2 ** Math.min(attempts, MAX_BACKOFF_EXPONENT);
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }

  function orderExpired(order: OrderRow): boolean {
    if (config.mode !== "enabled") return false;
    return Date.now() - Date.parse(order.created_at) > config.orderExpiryHours * 3_600_000;
  }

  async function markNeedsReview(order: OrderRow, reason: string, actor: Actor, detail: Record<string, unknown> = {}): Promise<void> {
    await db.run(
      `UPDATE payment_orders SET status = 'needs_review', error_message = ?, next_check_at = NULL, updated_at = mfx_utc_now_text()
       WHERE id = ? AND status <> 'paid'`,
      reason.slice(0, 500),
      order.id,
    );
    await appendAuditRecord({
      actor_id: actor.actor_id,
      action_code: "payment_needs_review",
      action_category: "billing",
      correlation_id: order.id,
      ...(order.tenant_id ? { scope_tenant_id: order.tenant_id } : {}),
      reason_code: actor.reason_code,
      entity_refs: order.tenant_id ? { tenant_id: order.tenant_id } : {},
      payload: { payment_order_id: order.id, invoice_id: order.slickpay_invoice_id, reason, ...detail },
    });
    structuredLog("slickpay_order_needs_review", { payment_order_id: order.id, reason, source: actor.source, ...detail });
  }

  type ApplyResult =
    | { kind: "applied"; licenseId: string; expiresAt: string; licenseIssued: boolean; licenceKey: string | null; maxMachines: number }
    | { kind: "already_paid" }
    | { kind: "needs_review"; reason: string };

  /**
   * Fulfils an order SlickPay reports as paid, once: creates the tenant of a new customer, sets the
   * edition to the plan paid for, issues or renews the licence (term from the later of now and the
   * current end; seats = included + extra paid for, never below the machines active now), bumps the
   * entitlement lineage, marks the order paid with SlickPay's figures, and audits it. The order row
   * lock makes concurrent confirmations wait and then see 'paid'.
   */
  async function applyPaidOrder(orderId: string, verdict: InvoiceVerdict, actor: Actor): Promise<ApplyResult> {
    type LicenceRow = { id: string; tenant_id: string; max_machines: number; expires_at: string | null; revoked_at: string | null };
    try {
      return await db.tx(async (): Promise<ApplyResult> => {
        const order = await db.get<OrderRow>(`SELECT ${ORDER_ROW_COLUMNS} FROM payment_orders WHERE id = ? FOR UPDATE`, orderId);
        if (!order) throw new NeedsReview("order_vanished");
        if (order.status === "paid") return { kind: "already_paid" };
        if (order.included_seats === null || order.term_months === null) {
          // Created before the price list existed: what was bought is not recorded precisely enough.
          throw new NeedsReview("legacy_order_without_price_snapshot");
        }
        const buyer = parseBuyer(order.user_info_json);
        let tenantId = order.tenant_id;
        let tenantCreated = false;
        if (!tenantId) {
          if (!buyer?.company) throw new NeedsReview("new_customer_without_company");
          if (!(await editionExists(db, order.plan))) throw new NeedsReview("plan_edition_missing");
          tenantId = newId("tenant");
          const preferred = slugifyTenantSlug(buyer.company);
          let slug = preferred;
          for (let i = 0; await db.get("SELECT id FROM tenants WHERE slug = ?", slug); i += 1) {
            slug = `${preferred.slice(0, 48)}-${order.id.slice(-6)}${i > 0 ? `-${i}` : ""}`;
          }
          await insertTenantRow({ id: tenantId, slug, display_name: buyer.company, update_channel: "stable", rollout_cohort: "stable-main", edition: order.plan });
          tenantCreated = true;
          await appendAuditRecord({
            actor_id: actor.actor_id,
            action_code: "tenant_create",
            action_category: "billing",
            correlation_id: tenantId,
            scope_tenant_id: tenantId,
            reason_code: "slickpay_new_customer",
            entity_refs: { tenant_id: tenantId },
            payload: { slug, display_name: buyer.company, edition: order.plan, payment_order_id: order.id },
          });
        }
        await db.lockXact("licence-renewal", tenantId);
        const tenant = await db.get<{ id: string; edition: string; is_active: number; update_channel: string }>(
          "SELECT id, edition, is_active, update_channel FROM tenants WHERE id = ? FOR UPDATE",
          tenantId,
        );
        if (!tenant) throw new NeedsReview("tenant_not_found");
        if (tenant.is_active !== 1) throw new NeedsReview("tenant_inactive");
        let editionChanged: { from: string; to: string } | null = null;
        if (tenant.edition !== order.plan) {
          if (!(await editionExists(db, order.plan))) throw new NeedsReview("plan_edition_missing");
          await db.run("UPDATE tenants SET edition = ? WHERE id = ?", order.plan, tenantId);
          editionChanged = { from: tenant.edition, to: order.plan };
        }
        let licence: LicenceRow | undefined = order.license_id
          ? await db.get<LicenceRow>("SELECT id, tenant_id, max_machines, expires_at, revoked_at FROM license_keys WHERE id = ? FOR UPDATE", order.license_id)
          : undefined;
        if (!licence || licence.tenant_id !== tenantId) licence = await pickActiveLicenseForTenant(tenantId);
        if (licence?.revoked_at) throw new NeedsReview("license_revoked");

        const nowIso = new Date().toISOString();
        const from = licence?.expires_at && Date.parse(licence.expires_at) > Date.now() ? licence.expires_at : nowIso;
        const expiresAt = addMonths(from, order.term_months);
        const paidSeats = order.included_seats + order.extra_slots;
        const active = licence ? await countActiveActivations(licence.id) : 0;
        const maxMachines = Math.max(paidSeats, active);
        let licenseId: string;
        let licenceKey: string | null = null;
        if (licence) {
          await db.run("UPDATE license_keys SET expires_at = ?, max_machines = ? WHERE id = ?", expiresAt, maxMachines, licence.id);
          licenseId = licence.id;
        } else {
          licenseId = newId("lic");
          licenceKey = randomLicenseKey();
          await db.run(
            `INSERT INTO license_keys (id, tenant_id, license_key, max_machines, update_channel, issued_by_user_id, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            licenseId,
            tenantId,
            licenceKey,
            maxMachines,
            tenant.update_channel,
            null,
            expiresAt,
          );
        }
        await db.run("UPDATE tenants SET entitlement_lineage = entitlement_lineage + 1 WHERE id = ?", tenantId);
        await db.run(
          `UPDATE payment_orders
           SET status = 'paid', paid_at = ?, tenant_id = ?, license_id = ?, slickpay_paid_amount = ?, slickpay_transaction_ref = ?,
               error_message = NULL, next_check_at = NULL, licence_delivery = ?, updated_at = mfx_utc_now_text()
           WHERE id = ?`,
          nowIso,
          tenantId,
          licenseId,
          verdict.paidAmount ?? verdict.invoiceAmount,
          verdict.transactionRef,
          emailSender && buyer ? "pending" : "disabled",
          order.id,
        );
        await appendAuditRecord({
          actor_id: actor.actor_id,
          action_code: licenceKey ? "license_issue" : "license_renew",
          action_category: "billing",
          correlation_id: order.id,
          scope_tenant_id: tenantId,
          reason_code: actor.reason_code,
          entity_refs: { tenant_id: tenantId, entitlement_id: licenseId },
          payload: {
            payment_order_id: order.id,
            invoice_id: order.slickpay_invoice_id,
            source: actor.source,
            plan: order.plan,
            total_amount: order.total_amount,
            slickpay_invoice_amount: verdict.invoiceAmount,
            slickpay_paid_amount: verdict.paidAmount,
            slickpay_transaction_ref: verdict.transactionRef,
            slickpay_signals: verdict.signals,
            previous_expires_at: licence?.expires_at ?? null,
            expires_at: expiresAt,
            previous_max_machines: licence?.max_machines ?? null,
            max_machines: maxMachines,
            seats_paid: paidSeats,
            license_issued: licenceKey !== null,
            tenant_created: tenantCreated,
            edition_changed: editionChanged,
          },
        });
        return { kind: "applied", licenseId, expiresAt, licenseIssued: licenceKey !== null, licenceKey, maxMachines };
      });
    } catch (err) {
      // Thrown inside the transaction so that nothing it wrote (tenant, edition) is kept.
      if (err instanceof NeedsReview) return { kind: "needs_review", reason: err.reason };
      throw err;
    }
  }

  /** Licence e-mail after fulfilment; the outcome is recorded on the order (console shows it). */
  async function deliverLicence(orderId: string, applied: Extract<ApplyResult, { kind: "applied" }>): Promise<void> {
    const order = await loadOrder(orderId);
    const buyer = parseBuyer(order?.user_info_json ?? null);
    if (!order || !buyer || !emailSender) return;
    const mail = renderLicenceEmail({
      plan: order.plan,
      licenceKey: applied.licenceKey,
      expiresAt: applied.expiresAt,
      maxMachines: applied.maxMachines,
      orderId: order.id,
    });
    try {
      await emailSender.send({ to: buyer.email, subject: mail.subject, text: mail.text });
      await db.run("UPDATE payment_orders SET licence_delivery = 'sent' WHERE id = ?", order.id);
      structuredLog("slickpay_licence_email_sent", { payment_order_id: order.id });
    } catch (err) {
      await db.run("UPDATE payment_orders SET licence_delivery = 'failed' WHERE id = ?", order.id);
      structuredLog("slickpay_licence_email_failed", { payment_order_id: order.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Reads the order's invoice at SlickPay (with our stored invoice id) and acts on the answer: a
   * paid invoice is fulfilled (after the amount check), an unpaid one is re-scheduled or expired.
   * Shared by the webhook, the status page, the reconciliation worker and the operator's check.
   */
  async function verifyAndApply(orderId: string, actor: Actor): Promise<VerifyOutcome> {
    const order = await loadOrder(orderId);
    if (!order) return { kind: "not_found" };
    if (order.status === "paid") return { kind: "already_paid" };
    if (!order.slickpay_invoice_id) return { kind: "no_invoice" };
    if (!slickpay) return { kind: "slickpay_unreachable" };

    const nowIso = new Date().toISOString();
    const attempts = order.check_attempts + 1;
    const call = await slickpay.getInvoice(order.slickpay_invoice_id);
    if (call.kind !== "ok") {
      const error = call.kind === "http_error" ? `http_${call.status}` : call.kind;
      await db.run(
        `UPDATE payment_orders SET check_attempts = ?, last_check_error = ?, last_reconciled_at = ?, next_check_at = ?
         WHERE id = ? AND status <> 'paid'`,
        attempts,
        error,
        nowIso,
        order.status === "awaiting_payment" ? nextCheckAt(attempts) : null,
        order.id,
      );
      structuredLog("slickpay_status_read_failed", { payment_order_id: order.id, source: actor.source, error });
      return call.kind === "http_error" ? { kind: "slickpay_error", httpStatus: call.status } : { kind: "slickpay_unreachable" };
    }

    const verdict = interpretInvoice(call.json);
    await db.run(
      `UPDATE payment_orders SET check_attempts = ?, last_check_error = NULL, last_reconciled_at = ?, last_reconciled_status = ?
       WHERE id = ?`,
      attempts,
      nowIso,
      `${verdict.state} (${verdict.signals.join(", ") || "no status field"})`.slice(0, 200),
      order.id,
    );
    structuredLog("slickpay_status_read", {
      payment_order_id: order.id,
      source: actor.source,
      state: verdict.state,
      signals: verdict.signals,
      invoice_amount: verdict.invoiceAmount,
      paid_amount: verdict.paidAmount,
    });

    if (verdict.state === "paid") {
      // The invoice was created by us for order.total_amount; SlickPay reporting a different invoice
      // amount, or a card payment below it, is not fulfilled automatically.
      const expected = order.total_amount;
      const invoiceMismatch = verdict.invoiceAmount !== null && Math.abs(verdict.invoiceAmount - expected) > 0.009;
      const underpaid = verdict.paidAmount !== null && verdict.paidAmount + 0.009 < expected;
      if (invoiceMismatch || underpaid) {
        await markNeedsReview(order, "amount_mismatch", actor, {
          expected_amount: expected,
          slickpay_invoice_amount: verdict.invoiceAmount,
          slickpay_paid_amount: verdict.paidAmount,
        });
        return { kind: "amount_mismatch" };
      }
      const result = await applyPaidOrder(order.id, verdict, actor);
      if (result.kind === "already_paid") return result;
      if (result.kind === "needs_review") {
        await markNeedsReview(order, result.reason, actor);
        return { kind: "needs_review", reason: result.reason };
      }
      structuredLog("slickpay_order_fulfilled", {
        payment_order_id: order.id,
        source: actor.source,
        license_id: result.licenseId,
        license_issued: result.licenseIssued,
        expires_at: result.expiresAt,
        amount_verified: verdict.invoiceAmount !== null || verdict.paidAmount !== null,
      });
      await deliverLicence(order.id, result);
      return { kind: "applied", licenseId: result.licenseId, expiresAt: result.expiresAt, licenseIssued: result.licenseIssued };
    }

    const expired = orderExpired(order);
    if (verdict.state === "unknown") {
      if (expired) {
        await markNeedsReview(order, "slickpay_status_unrecognised", actor, { signals: verdict.signals });
        return { kind: "status_unrecognised", needsReview: true };
      }
      structuredLog("slickpay_status_unrecognised", { payment_order_id: order.id, signals: verdict.signals, keys: Object.keys(call.json).slice(0, 20) });
    }
    if (expired && verdict.state === "unpaid" && order.status === "awaiting_payment") {
      await db.run(
        `UPDATE payment_orders SET status = 'expired', next_check_at = NULL, updated_at = mfx_utc_now_text() WHERE id = ? AND status = 'awaiting_payment'`,
        order.id,
      );
      structuredLog("slickpay_order_expired", { payment_order_id: order.id });
      return { kind: "not_paid", expired: true };
    }
    if (order.status === "awaiting_payment") {
      await db.run("UPDATE payment_orders SET next_check_at = ? WHERE id = ? AND status = 'awaiting_payment'", nextCheckAt(attempts), order.id);
    }
    return verdict.state === "unknown" ? { kind: "status_unrecognised", needsReview: false } : { kind: "not_paid", expired: false };
  }

  type CreateOrderInput = {
    plan: string;
    extraSeats: number;
    tenantId: string | null;
    buyer: Buyer;
    expectedTotal: number | null;
    actorId: string;
    /** Console payment link: may use a plan priced but not sold on the website (is_active false). */
    operatorLink: boolean;
  };
  type CreateOrderResult =
    | { ok: true; status: 201; body: Record<string, unknown> }
    | { ok: false; status: number; body: Record<string, unknown> };

  /** Prices the order from the price list, records it, and creates its SlickPay invoice. */
  async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (!slickpay || config.mode !== "enabled") {
      return { ok: false, status: 503, body: { error: "slickpay_not_configured" } };
    }
    const price = await loadPrice(input.plan);
    if (!price || (!price.is_active && !input.operatorLink)) {
      return { ok: false, status: 400, body: { error: "plan_not_for_sale", message: "This plan cannot be bought online." } };
    }
    if (input.extraSeats > price.max_extra_seats) {
      return { ok: false, status: 400, body: { error: "too_many_extra_seats", max_extra_seats: price.max_extra_seats } };
    }
    const total = roundAmount(price.base_amount + input.extraSeats * price.extra_seat_amount);
    const quote = { plan: price.plan, extra_slots: input.extraSeats, total_amount: total, currency: price.currency };
    if (input.expectedTotal !== null && Math.abs(input.expectedTotal - total) > 0.009) {
      return { ok: false, status: 409, body: { error: "price_changed", message: "The price has changed; review it before paying.", quote, price: publicPrice(price) } };
    }

    let licenseId: string | null = null;
    if (input.tenantId) {
      const tenant = await db.get<{ id: string; is_active: number }>("SELECT id, is_active FROM tenants WHERE id = ?", input.tenantId);
      if (!tenant) return { ok: false, status: 404, body: { error: "tenant_not_found" } };
      if (tenant.is_active !== 1) return { ok: false, status: 409, body: { error: "tenant_inactive" } };
      const licence = await pickActiveLicenseForTenant(tenant.id);
      licenseId = licence?.id ?? null;
    }

    const orderId = newId("pay");
    const statusToken = newSecretToken();
    const webhookToken = newSecretToken();
    await db.run(
      `INSERT INTO payment_orders
         (id, tenant_id, license_id, plan, amount, extra_slots, total_amount, currency, status, user_info_json, meta_json,
          included_seats, extra_seat_amount, term_months, status_token_sha256, webhook_token_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      orderId,
      input.tenantId,
      licenseId,
      price.plan,
      price.base_amount,
      input.extraSeats,
      total,
      price.currency,
      JSON.stringify(input.buyer),
      JSON.stringify({ created_by: input.actorId }),
      price.included_seats,
      price.extra_seat_amount,
      price.term_months,
      sha256Hex(statusToken),
      sha256Hex(webhookToken),
    );

    const returnUrl = new URL(config.returnUrl);
    returnUrl.searchParams.set("order", orderId);
    returnUrl.searchParams.set("token", statusToken);
    const items: Array<{ name: string; price: number; quantity: number }> = [
      { name: `Maintafox ${price.plan} - ${price.term_months} mois/months (${price.included_seats} poste(s)/seat(s))`, price: price.base_amount, quantity: 1 },
    ];
    if (input.extraSeats > 0) {
      items.push({ name: "Poste supplementaire / extra seat", price: price.extra_seat_amount, quantity: input.extraSeats });
    }
    const invoiceBody = {
      amount: total,
      url: returnUrl.toString(),
      firstname: input.buyer.firstname,
      lastname: input.buyer.lastname,
      phone: input.buyer.phone,
      email: input.buyer.email,
      // SlickPay requires an address when no saved contact is given; the website does not ask for a
      // postal address, so the company name stands in, as before.
      address: input.buyer.address ?? input.buyer.company ?? `${input.buyer.firstname} ${input.buyer.lastname}`,
      items,
      webhook_url: config.webhookUrl,
      webhook_signature: webhookToken,
      webhook_meta_data: { payment_order_id: orderId, mfx_token: webhookToken },
      note: `Maintafox ${orderId}`,
    };

    const fail = async (status: number, body: Record<string, unknown>, error: string): Promise<CreateOrderResult> => {
      await db.run(
        `UPDATE payment_orders SET status = 'failed', error_message = ?, updated_at = mfx_utc_now_text() WHERE id = ?`,
        error.slice(0, 500),
        orderId,
      );
      structuredLog("slickpay_invoice_create_failed", { payment_order_id: orderId, error });
      return { ok: false, status, body: { ...body, payment_order_id: orderId } };
    };

    const created = await slickpay.createInvoice(invoiceBody);
    if (created.kind === "timeout" || created.kind === "network") {
      // The invoice may or may not exist at SlickPay; the customer never got a link, so it cannot be paid.
      return fail(503, { error: "slickpay_unreachable", message: "The payment service did not answer. Please try again in a few minutes." }, created.kind);
    }
    if (created.kind === "http_error") {
      const fields =
        created.json.errors && typeof created.json.errors === "object" ? Object.keys(created.json.errors as object).slice(0, 10) : [];
      return fail(
        created.status === 422 ? 422 : 502,
        { error: "slickpay_rejected", fields, message: "The payment service refused the order details." },
        `http_${created.status}${fields.length ? ` fields=${fields.join(",")}` : ""}`,
      );
    }
    const invoice = readCreatedInvoice(created.json);
    if (!invoice) {
      return fail(502, { error: "slickpay_invalid_response", message: "The payment service gave no payment page." }, "missing_invoice_id_or_url");
    }
    try {
      await db.run(
        `UPDATE payment_orders
         SET slickpay_invoice_id = ?, slickpay_payment_url = ?, status = 'awaiting_payment', next_check_at = ?, updated_at = mfx_utc_now_text()
         WHERE id = ?`,
        invoice.invoiceId,
        invoice.paymentUrl,
        nextCheckAt(0),
        orderId,
      );
    } catch (err) {
      // Unique index: SlickPay returned an invoice id that another order already has. Never link two
      // orders to one invoice (the fulfilment key); the customer gets no link for this one.
      return fail(502, { error: "slickpay_duplicate_invoice" }, `invoice_id_conflict: ${err instanceof Error ? err.message : String(err)}`);
    }
    await appendAuditRecord({
      actor_id: input.actorId,
      action_code: "payment_initiate",
      action_category: "billing",
      correlation_id: orderId,
      ...(input.tenantId ? { scope_tenant_id: input.tenantId } : {}),
      entity_refs: input.tenantId ? { tenant_id: input.tenantId, ...(licenseId ? { entitlement_id: licenseId } : {}) } : {},
      payload: {
        payment_order_id: orderId,
        plan: price.plan,
        extra_slots: input.extraSeats,
        total_amount: total,
        currency: price.currency,
        invoice_id: invoice.invoiceId,
        new_customer: input.tenantId === null,
      },
    });
    structuredLog("slickpay_invoice_created", { payment_order_id: orderId, invoice_id: invoice.invoiceId, total_amount: total, new_customer: input.tenantId === null });
    return {
      ok: true,
      status: 201,
      body: { checkout_url: invoice.paymentUrl, payment_order_id: orderId, ...quote },
    };
  }

  // ── Public (website) ─────────────────────────────────────────────────────────────────────────

  /** Plans that can be bought online, with their server-side price. */
  app.get("/api/v1/payments/slickpay/prices", publicPaymentReadRateLimiter, systemScopeMiddleware(db, "slickpay-prices"), async (_req, res) => {
    const rows = await db.all<Record<string, unknown>>("SELECT * FROM billing_price_list WHERE is_active ORDER BY base_amount, plan");
    res.json({ online_payment_available: config.mode === "enabled", prices: rows.map(priceFromRow).map(publicPrice) });
  });

  /** Checkout: prices the order on the server and returns SlickPay's payment page. */
  app.post("/api/v1/payments/slickpay/initiate", publicCheckoutRateLimiter, systemScopeMiddleware(db, "slickpay-checkout"), async (req, res) => {
    const parsed = PublicInitiateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;
    const result = await createOrder({
      plan: input.plan,
      extraSeats: input.extra_slots,
      tenantId: input.tenant_id ?? null,
      buyer: input.user_info,
      expectedTotal: input.expected_total_amount ?? input.amount ?? null,
      actorId: "payment_proxy",
      operatorLink: false,
    });
    res.status(result.status).json(result.body);
  });

  /**
   * The customer's order status (the page SlickPay returns them to). Requires the order's token
   * from the return URL. While the order is unpaid the server asks SlickPay itself (at most every
   * STATUS_PAGE_MIN_RECHECK_MS), so a payment is confirmed even if the webhook never comes.
   */
  app.get(
    "/api/v1/payments/slickpay/orders/:orderId/status",
    publicPaymentReadRateLimiter,
    systemScopeMiddleware(db, "slickpay-order-status"),
    async (req, res) => {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      let order = await loadOrder(String(req.params.orderId));
      if (!order || !token || !order.status_token_sha256 || !safeEqualUtf8(sha256Hex(token), order.status_token_sha256)) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }
      const lastCheck = order.last_reconciled_at ? Date.parse(order.last_reconciled_at) : 0;
      if (order.status === "awaiting_payment" && Date.now() - lastCheck >= STATUS_PAGE_MIN_RECHECK_MS) {
        await verifyAndApply(order.id, { actor_id: "system_slickpay_status_page", reason_code: "slickpay_paid", source: "status_page" });
        order = (await loadOrder(order.id)) ?? order;
      }
      const buyer = parseBuyer(order.user_info_json);
      res.json({
        payment_order_id: order.id,
        status: publicStatus(order.status),
        plan: order.plan,
        extra_slots: order.extra_slots,
        total_amount: order.total_amount,
        currency: order.currency,
        paid_at: order.paid_at,
        licence_delivery: order.licence_delivery,
        email_hint: buyer ? maskEmail(buyer.email) : null,
      });
    },
  );

  /**
   * SlickPay webhook. A hint only: the order is found by the invoice id we stored, a token we
   * attached to the invoice is checked when SlickPay sends it back, and the status is read from
   * SlickPay before anything is granted. 200 for anything handled (also ignored calls), 503 when
   * SlickPay could not be read (a retrying sender retries; the worker re-checks anyway).
   */
  app.post("/api/v1/webhooks/slickpay", paymentWebhookRateLimiter, systemScopeMiddleware(db, "slickpay-webhook"), async (req, res) => {
    if (config.mode !== "enabled") {
      res.status(503).json({ error: "slickpay_not_configured" });
      return;
    }
    const headerSignature =
      req.header("x-slickpay-signature") ?? req.header("x-webhook-signature") ?? req.header("webhook-signature") ?? null;
    const hint = readWebhookHint(req.body, headerSignature);
    let order = hint.invoiceId
      ? await db.get<OrderRow>(`SELECT ${ORDER_ROW_COLUMNS} FROM payment_orders WHERE slickpay_invoice_id = ?`, hint.invoiceId)
      : undefined;
    if (!order && hint.orderId) {
      const byMeta = await loadOrder(hint.orderId);
      if (byMeta && byMeta.slickpay_invoice_id && (!hint.invoiceId || hint.invoiceId === byMeta.slickpay_invoice_id)) order = byMeta;
    }
    if (!order) {
      structuredLog("slickpay_webhook_unknown_invoice", { has_invoice_id: Boolean(hint.invoiceId), has_order_id: Boolean(hint.orderId) });
      res.status(200).json({ ok: true, ignored: "unknown_invoice" });
      return;
    }
    const tokenCheck = !hint.token ? "absent" : order.webhook_token_sha256 && safeEqualUtf8(sha256Hex(hint.token), order.webhook_token_sha256) ? "valid" : "invalid";
    if (tokenCheck === "invalid") {
      structuredLog("slickpay_webhook_rejected", { payment_order_id: order.id, reason: "token_mismatch" });
      res.status(401).json({ error: "invalid_webhook_signature" });
      return;
    }
    const outcome = await verifyAndApply(order.id, { actor_id: "system_slickpay_webhook", reason_code: "slickpay_paid", source: "webhook" });
    structuredLog("slickpay_webhook_handled", { payment_order_id: order.id, token: tokenCheck, outcome: outcome.kind });
    if (outcome.kind === "slickpay_unreachable" || outcome.kind === "slickpay_error") {
      res.status(503).json({ error: "slickpay_status_unavailable" });
      return;
    }
    res.status(200).json({ ok: true, payment_order_id: order.id, outcome: outcome.kind });
  });

  // ── Console ──────────────────────────────────────────────────────────────────────────────────

  /** SlickPay settings in effect (names only, no key), the worker's last run, orders per status. */
  app.get("/api/v1/billing/status", authMiddleware, async (_req, res) => {
    const counts = await db.all<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM payment_orders GROUP BY status");
    res.json({
      slickpay: {
        mode: config.mode,
        ...(config.mode === "enabled"
          ? {
              api_base_url: config.apiBaseUrl,
              webhook_url: config.webhookUrl,
              return_url: config.returnUrl,
              reconcile_interval_minutes: config.reconcileIntervalMinutes,
              order_expiry_hours: config.orderExpiryHours,
            }
          : {}),
        ignored_settings: ignoredSettings,
      },
      email_delivery: EMAIL_CONFIG.mode,
      reconciler: workerState.last_slickpay_reconcile,
      orders_by_status: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    });
  });

  app.get("/api/v1/billing/prices", authMiddleware, async (_req, res) => {
    const rows = await db.all<Record<string, unknown>>("SELECT * FROM billing_price_list ORDER BY plan");
    res.json(rows.map(priceFromRow));
  });

  /** Sets one plan's price (owner); reason required; audited with the previous values. */
  app.put("/api/v1/billing/prices/:plan", authMiddleware, async (req, res) => {
    const reason = req.header("X-Operator-Reason")?.trim() ?? "";
    if (reason.length < PRIVILEGED_REASON_MIN_LENGTH) {
      res.status(400).json({ error: "missing_reason_code" });
      return;
    }
    const plan = String(req.params.plan);
    if (!(await editionExists(db, plan))) {
      res.status(404).json({ error: "edition_not_found", message: "The plan must be an edition of the catalog." });
      return;
    }
    const parsed = PriceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const p = parsed.data;
    const actorId = resolveActorId(req);
    const before = await loadPrice(plan);
    await db.run(
      `INSERT INTO billing_price_list (plan, base_amount, included_seats, extra_seat_amount, max_extra_seats, term_months, currency, is_active, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'DZD', ?, mfx_utc_now_text(), ?)
       ON CONFLICT (plan) DO UPDATE SET base_amount = EXCLUDED.base_amount, included_seats = EXCLUDED.included_seats,
         extra_seat_amount = EXCLUDED.extra_seat_amount, max_extra_seats = EXCLUDED.max_extra_seats,
         term_months = EXCLUDED.term_months, is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      plan,
      p.base_amount,
      p.included_seats,
      p.extra_seat_amount,
      p.max_extra_seats,
      p.term_months,
      p.is_active,
      actorId,
    );
    const after = await loadPrice(plan);
    await appendAuditRecord({
      actor_id: actorId,
      action_code: "price_update",
      action_category: "billing",
      correlation_id: plan,
      reason_code: reason,
      entity_refs: {},
      payload: { plan, before: before ?? null, after },
    });
    res.json(after);
  });

  /**
   * A payment link for an existing customer (renewal, extra seats), priced from the list. Unlike the
   * website it may use a plan whose price is not sold online (e.g. a negotiated or test price).
   */
  app.post("/api/v1/billing/payment-links", authMiddleware, async (req, res) => {
    const parsed = PaymentLinkBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const result = await createOrder({
      plan: parsed.data.plan,
      extraSeats: parsed.data.extra_slots,
      tenantId: parsed.data.tenant_id,
      buyer: parsed.data.buyer,
      expectedTotal: null,
      actorId: resolveActorId(req),
      operatorLink: true,
    });
    res.status(result.status).json(result.body);
  });

  function operatorOrderView(row: Record<string, unknown>) {
    const { user_info_json, ...rest } = row;
    const buyer = parseBuyer(typeof user_info_json === "string" ? user_info_json : null);
    return { ...rest, buyer_company: buyer?.company ?? null };
  }

  /**
   * A customer's subscription: each licence's term and slots, every payment order exactly as
   * stored, whether SlickPay is configured, and every priced plan (for payment links).
   */
  app.get("/api/v1/billing/tenants/:tenantId/subscription", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const tenant = await db.get<{ id: string; edition: string }>("SELECT id, edition FROM tenants WHERE id = ?", tenantId);
    if (!tenant) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    const licences = await db.all<{
      id: string;
      max_machines: number;
      expires_at: string | null;
      revoked_at: string | null;
      update_channel: string;
    }>(
      `SELECT id, max_machines, expires_at, revoked_at, update_channel FROM license_keys
       WHERE tenant_id = ? ORDER BY created_at DESC, id DESC`,
      tenantId,
    );
    const payments = await db.all<Record<string, unknown>>(
      `SELECT ${PAYMENT_ORDER_COLUMNS} FROM payment_orders WHERE tenant_id = ? ORDER BY created_at DESC, id DESC`,
      tenantId,
    );
    // Every priced plan: a payment link may also use one not sold on the website.
    const prices = await db.all<Record<string, unknown>>("SELECT * FROM billing_price_list ORDER BY plan");
    res.json({
      tenant_id: tenantId,
      edition: tenant.edition,
      licences: await Promise.all(
        licences.map(async (l) => ({
          ...l,
          active_machines: await countActiveActivations(l.id),
          days_left: l.revoked_at ? null : daysLeft(l.expires_at),
        })),
      ),
      payments: payments.map(operatorOrderView),
      slickpay_configured: config.mode === "enabled",
      prices: prices.map(priceFromRow),
    });
  });

  /** Payment orders of every customer (filters: status, tenant_id), newest first. */
  app.get("/api/v1/billing/payments", authMiddleware, async (req, res) => {
    const parsed = PaymentsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed, "query");
      return;
    }
    const where: string[] = [];
    const params: string[] = [];
    if (parsed.data.status) {
      where.push("status = ?");
      params.push(parsed.data.status);
    }
    if (parsed.data.tenant_id) {
      where.push("tenant_id = ?");
      params.push(parsed.data.tenant_id);
    }
    const rows = await db.all<Record<string, unknown>>(
      `SELECT ${PAYMENT_ORDER_COLUMNS} FROM payment_orders
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT 500`,
      ...params,
    );
    res.json(rows.map(operatorOrderView));
  });

  /**
   * "Check with SlickPay": reads the invoice's real status and applies it exactly as the webhook
   * would (also for an expired or needs-review order, e.g. after the operator re-activated the
   * customer). A paid order SlickPay no longer reports as paid (refund) is never undone: it is
   * reported as a mismatch for a person to handle. Audited.
   */
  app.post("/api/v1/billing/payments/:orderId/reconcile", authMiddleware, async (req, res) => {
    const reason = req.header("X-Operator-Reason")?.trim() ?? "";
    if (reason.length < PRIVILEGED_REASON_MIN_LENGTH) {
      res.status(400).json({ error: "missing_reason_code" });
      return;
    }
    if (!slickpay) {
      res.status(503).json({ error: "slickpay_not_configured" });
      return;
    }
    const before = await loadOrder(String(req.params.orderId));
    if (!before) {
      res.status(404).json({ error: "payment_order_not_found" });
      return;
    }
    if (!before.slickpay_invoice_id) {
      res.status(409).json({ error: "no_invoice", message: "This order never reached SlickPay (no invoice)." });
      return;
    }
    const actor: Actor = { actor_id: resolveActorId(req), reason_code: "slickpay_reconciled", source: "operator" };
    let outcome: string;
    let slickpayStatus: string;
    if (before.status === "paid") {
      // Already fulfilled: only compare with SlickPay, never re-apply or undo.
      const call = await slickpay.getInvoice(before.slickpay_invoice_id);
      if (call.kind !== "ok") {
        res.status(502).json({ error: "slickpay_verify_failed", detail: call.kind === "http_error" ? `http_${call.status}` : call.kind });
        return;
      }
      const verdict = interpretInvoice(call.json);
      slickpayStatus = verdict.state;
      outcome = verdict.state === "paid" ? "unchanged" : "mismatch_paid_here_not_at_slickpay";
      await db.run(
        "UPDATE payment_orders SET last_reconciled_at = ?, last_reconciled_status = ? WHERE id = ?",
        new Date().toISOString(),
        `${verdict.state} (${verdict.signals.join(", ") || "no status field"})`.slice(0, 200),
        before.id,
      );
    } else {
      const result = await verifyAndApply(before.id, actor);
      if (result.kind === "slickpay_unreachable" || result.kind === "slickpay_error") {
        res.status(502).json({ error: "slickpay_verify_failed", detail: result.kind });
        return;
      }
      outcome = result.kind === "not_paid" ? (result.expired ? "expired" : "unchanged") : result.kind;
      slickpayStatus = result.kind === "applied" || result.kind === "amount_mismatch" || result.kind === "needs_review" ? "paid" : result.kind === "status_unrecognised" ? "unknown" : "unpaid";
    }
    await appendAuditRecord({
      actor_id: actor.actor_id,
      action_code: "payment_reconciled",
      action_category: "billing",
      correlation_id: before.id,
      ...(before.tenant_id ? { scope_tenant_id: before.tenant_id } : {}),
      reason_code: reason,
      entity_refs: before.tenant_id ? { tenant_id: before.tenant_id, ...(before.license_id ? { entitlement_id: before.license_id } : {}) } : {},
      payload: { payment_order_id: before.id, invoice_id: before.slickpay_invoice_id, stored_status: before.status, slickpay_status: slickpayStatus, outcome },
    });
    const order = await db.get<Record<string, unknown>>(`SELECT ${PAYMENT_ORDER_COLUMNS} FROM payment_orders WHERE id = ?`, before.id);
    res.json({
      payment_order_id: before.id,
      stored_status: before.status,
      slickpay_status: slickpayStatus,
      applied: outcome === "applied",
      outcome,
      order: order ? operatorOrderView(order) : null,
    });
  });

  return {
    /**
     * One run of the reconciliation worker: re-checks unpaid orders that are due, and closes orders
     * whose invoice was never created. Returns counts per outcome (logged by the caller).
     */
    async reconcileDueOrders() {
      const counts: Record<string, number> = {};
      if (config.mode !== "enabled") return counts;
      const nowIso = new Date().toISOString();
      const staleBefore = new Date(Date.now() - config.orderExpiryHours * 3_600_000).toISOString();
      const stale = await db.all<{ id: string }>(
        "SELECT id FROM payment_orders WHERE status = 'pending' AND slickpay_invoice_id IS NULL AND created_at < ?",
        staleBefore,
      );
      for (const row of stale) {
        await db.run(
          "UPDATE payment_orders SET status = 'failed', error_message = 'invoice_never_created', updated_at = mfx_utc_now_text() WHERE id = ? AND status = 'pending'",
          row.id,
        );
        counts.invoice_never_created = (counts.invoice_never_created ?? 0) + 1;
      }
      const due = await db.all<{ id: string }>(
        `SELECT id FROM payment_orders
         WHERE status = 'awaiting_payment' AND slickpay_invoice_id IS NOT NULL AND (next_check_at IS NULL OR next_check_at <= ?)
         ORDER BY next_check_at NULLS FIRST, created_at LIMIT ${RECONCILE_BATCH_SIZE}`,
        nowIso,
      );
      for (const row of due) {
        const outcome = await verifyAndApply(row.id, { actor_id: "system_slickpay_reconciler", reason_code: "slickpay_reconciled", source: "reconciler" });
        const key = outcome.kind === "not_paid" && outcome.expired ? "expired" : outcome.kind;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return counts;
    },
  };
}

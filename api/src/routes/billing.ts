/**
 * Billing: SlickPay checkout (public, may create the tenant) and the payment webhook that renews
 * or issues the licence.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { publicCheckoutRateLimiter, sendValidationError } from "../app/http.js";
import { newId, randomLicenseKey } from "../app/runtime.js";
import { systemScopeMiddleware } from "../app/scope.js";
import { editionExists } from "../edition-catalog-store.js";

const SlickPayUserInfoSchema = z
  .object({
    firstname: z.string().min(1).max(128).optional(),
    lastname: z.string().min(1).max(128).optional(),
    phone: z.string().min(6).max(32).optional(),
    email: z.string().email().optional(),
    address: z.string().min(1).max(256).optional(),
    contact_id: z.string().uuid().optional(),
    /** Company / organization aliases accepted from the public website. */
    company: z.string().min(2).max(128).optional(),
    company_name: z.string().min(2).max(128).optional(),
    entreprise: z.string().min(2).max(128).optional(),
    organization: z.string().min(2).max(128).optional(),
    business_name: z.string().min(2).max(128).optional(),
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  })
  .passthrough();

const SlickPayInitiateBody = z
  .object({
    plan: z.string().trim().min(1).max(64),
    amount: z.number().nonnegative(),
    tenant_id: z.string().min(3).optional(),
    extra_slots: z.number().int().min(0).max(1000).optional().default(0),
    user_info: SlickPayUserInfoSchema.optional(),
    return_url: z.string().url().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.tenant_id && !body.user_info) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["user_info"],
        message: "user_info is required when tenant_id is omitted (new customer checkout)",
      });
    }
  });

const SLICKPAY_PUBLIC_KEY = (process.env.SLICKPAY_PUBLIC_KEY ?? "").trim();
const SLICKPAY_SECRET_KEY = (process.env.SLICKPAY_SECRET_KEY ?? "").trim();
const SLICKPAY_WEBHOOK_SECRET = (process.env.SLICKPAY_WEBHOOK_SECRET ?? SLICKPAY_SECRET_KEY).trim();
const SLICKPAY_API_BASE_URL = (process.env.SLICKPAY_API_BASE_URL ?? "https://prodapi.slick-pay.com").replace(/\/$/, "");
const SLICKPAY_WEBHOOK_URL = (process.env.SLICKPAY_WEBHOOK_URL ?? "https://api.maintafox.systems/api/v1/webhooks/slickpay").trim();
const SLICKPAY_DEFAULT_RETURN_URL = (
  process.env.SLICKPAY_DEFAULT_RETURN_URL ?? "https://console.maintafox.systems/vendor-console/entitlements"
).trim();
const SLICKPAY_EXTRA_SLOT_PRICE = Number.parseFloat(process.env.SLICKPAY_EXTRA_SLOT_PRICE ?? "0");

function slickPayConfigured(): boolean {
  return SLICKPAY_PUBLIC_KEY.length > 0 && SLICKPAY_SECRET_KEY.length > 0;
}

function safeEqualUtf8(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function computeLicenseExpiresPlusOneYear(currentExpiresAt: string | null, now = new Date()): string {
  const base =
    currentExpiresAt && !Number.isNaN(Date.parse(currentExpiresAt)) && new Date(currentExpiresAt) > now
      ? new Date(currentExpiresAt)
      : now;
  const next = new Date(base.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

type SlickPayUserInfo = z.infer<typeof SlickPayUserInfoSchema>;

function pickCompanyNameFromUserInfo(ui: SlickPayUserInfo): string | null {
  const candidates = [ui.company, ui.company_name, ui.entreprise, ui.organization, ui.business_name];
  for (const raw of candidates) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v.length >= 2) return v.slice(0, 128);
  }
  return null;
}

function resolveTenantDisplayNameFromUserInfo(ui: SlickPayUserInfo): string | null {
  const company = pickCompanyNameFromUserInfo(ui);
  if (company) return company;
  const person = [ui.firstname, ui.lastname]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (person.length >= 2) return person.slice(0, 128);
  if (ui.email && ui.email.trim().length >= 3) return ui.email.trim().slice(0, 128);
  return null;
}

function slugifyTenantSlug(raw: string): string {
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const clipped = ascii.slice(0, 48).replace(/-+$/g, "");
  return clipped.length >= 2 ? clipped : "customer";
}

export function registerBillingRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, appendAuditRecord, insertTenantRow, tenantWriteFailure, pickActiveLicenseForTenant } = ctx;

  async function slickPayApi(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${SLICKPAY_API_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLICKPAY_PUBLIC_KEY}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { ok: res.ok, status: res.status, json };
  }

  async function allocateUniqueTenantSlug(preferred: string): Promise<string> {
    const base = slugifyTenantSlug(preferred);
    const exists = async (slug: string) =>
      Boolean(await db.get("SELECT id FROM tenants WHERE slug = ?", slug));
    if (!(await exists(base))) return base;
    for (let i = 0; i < 12; i += 1) {
      const candidate = `${base.slice(0, 52)}-${randomBytes(2).toString("hex")}`;
      if (!(await exists(candidate))) return candidate;
    }
    return `${base.slice(0, 40)}-${randomBytes(4).toString("hex")}`;
  }

  async function resolveEditionFromPlan(plan: string): Promise<string> {
    const normalized = plan.trim().toLowerCase().replace(/\s+/g, "-");
    if (await editionExists(db, normalized)) return normalized;
    if (await editionExists(db, plan.trim())) return plan.trim();
    return "core";
  }

  async function createTenantFromSlickPayUserInfo(
    ui: SlickPayUserInfo,
    plan: string,
  ): Promise<{ id: string; slug: string; display_name: string; edition: string }> {
    const displayName = resolveTenantDisplayNameFromUserInfo(ui);
    if (!displayName) {
      const err = new Error("insufficient_user_info");
      (err as Error & { code?: string }).code = "insufficient_user_info";
      throw err;
    }
    const slug = await allocateUniqueTenantSlug(ui.slug?.trim() || displayName);
    const id = newId("tenant");
    const edition = await resolveEditionFromPlan(plan);
    await insertTenantRow({
      id,
      slug,
      display_name: displayName,
      update_channel: "stable",
      rollout_cohort: "stable-main",
      edition,
    });
    await appendAuditRecord({
      actor_id: "payment_proxy",
      action_code: "tenant_create",
      action_category: "billing",
      correlation_id: id,
      scope_tenant_id: id,
      reason_code: "slickpay_new_customer",
      entity_refs: { tenant_id: id },
      payload: {
        slug,
        display_name: displayName,
        edition,
        email: ui.email ?? null,
        company: pickCompanyNameFromUserInfo(ui),
      },
    });
    return { id, slug, display_name: displayName, edition };
  }

  async function issueLicenseForPaidOrder(input: {
    tenantId: string;
    maxMachines: number;
    expiresAt: string;
    updateChannel?: string;
  }): Promise<{ id: string; license_key: string; max_machines: number; expires_at: string }> {
    const tenant = await db.get(`SELECT id, update_channel, is_active FROM tenants WHERE id = ?`, input.tenantId) as { id: string; update_channel: string; is_active: number } | undefined;
    if (!tenant || tenant.is_active !== 1) {
      throw new Error("tenant_not_found_or_inactive");
    }
    const id = newId("lic");
    const key = randomLicenseKey();
    await db.run(`INSERT INTO license_keys
        (id, tenant_id, license_key, max_machines, update_channel, issued_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id,
      input.tenantId,
      key,
      input.maxMachines,
      input.updateChannel ?? tenant.update_channel,
      null,
      input.expiresAt);
    return {
      id,
      license_key: key,
      max_machines: input.maxMachines,
      expires_at: input.expiresAt,
    };
  }

  /** Public payment proxy: create SlickPay invoice and return checkout_url. */
  app.post("/api/v1/payments/slickpay/initiate", publicCheckoutRateLimiter, systemScopeMiddleware(db, "slickpay-checkout"), async (req, res) => {
    if (!slickPayConfigured()) {
      res.status(503).json({
        error: "slickpay_not_configured",
        message: "Set SLICKPAY_PUBLIC_KEY and SLICKPAY_SECRET_KEY.",
      });
      return;
    }
    const parsed = SlickPayInitiateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;
    const extraSlots = input.extra_slots ?? 0;
    const slotUnit = Number.isFinite(SLICKPAY_EXTRA_SLOT_PRICE) ? Math.max(0, SLICKPAY_EXTRA_SLOT_PRICE) : 0;
    const totalAmount = input.amount + extraSlots * slotUnit;

    let tenant: { id: string; display_name: string; is_active: number };
    let tenantCreated = false;
    if (input.tenant_id) {
      const existing = await db.get(`SELECT id, display_name, is_active FROM tenants WHERE id = ?`, input.tenant_id) as { id: string; display_name: string; is_active: number } | undefined;
      if (!existing) {
        res.status(404).json({ error: "tenant_not_found" });
        return;
      }
      if (existing.is_active === 0) {
        res.status(409).json({ error: "tenant_inactive" });
        return;
      }
      tenant = existing;
    } else {
      try {
        const createdTenant = await createTenantFromSlickPayUserInfo(input.user_info!, input.plan);
        tenant = { id: createdTenant.id, display_name: createdTenant.display_name, is_active: 1 };
        tenantCreated = true;
      } catch (err) {
        if (err instanceof Error && (err as Error & { code?: string }).code === "insufficient_user_info") {
          res.status(400).json({
            error: "user_info_required",
            message:
              "Provide user_info.company (or company_name/entreprise) or firstname+lastname or email when tenant_id is omitted.",
          });
          return;
        }
        const failure = tenantWriteFailure(err);
        res.status(failure.status).json(failure.body);
        return;
      }
    }

    const license = await pickActiveLicenseForTenant(tenant.id);
    const orderId = newId("pay");
    const returnUrl = input.return_url ?? SLICKPAY_DEFAULT_RETURN_URL;
    const meta = {
      payment_order_id: orderId,
      tenant_id: tenant.id,
      license_id: license?.id ?? null,
      plan: input.plan,
      extra_slots: extraSlots,
      tenant_created: tenantCreated,
    };
    // SlickPay docs type webhook_meta_data as array; wrap our object for compatibility.
    const webhookMetaData = [meta];

    await db.run(`INSERT INTO payment_orders
        (id, tenant_id, license_id, plan, amount, extra_slots, total_amount, status, user_info_json, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, orderId,
      tenant.id,
      license?.id ?? null,
      input.plan,
      input.amount,
      extraSlots,
      totalAmount,
      input.user_info ? JSON.stringify(input.user_info) : null,
      JSON.stringify(meta));

    const invoiceBody: Record<string, unknown> = {
      amount: totalAmount,
      url: returnUrl,
      webhook_url: SLICKPAY_WEBHOOK_URL,
      webhook_signature: SLICKPAY_WEBHOOK_SECRET || SLICKPAY_SECRET_KEY,
      webhook_meta_data: webhookMetaData,
      note: `Maintafox ${input.plan} — tenant ${tenant.id}`,
      items: [
        {
          name: `Maintafox ${input.plan}`,
          price: totalAmount,
          quantity: 1,
        },
      ],
    };
    const ui = input.user_info ?? {};
    if (ui.contact_id) {
      invoiceBody.contact = ui.contact_id;
    } else {
      if (ui.firstname) invoiceBody.firstname = ui.firstname;
      if (ui.lastname) invoiceBody.lastname = ui.lastname;
      if (ui.phone) invoiceBody.phone = ui.phone;
      if (ui.email) invoiceBody.email = ui.email;
      const address =
        (typeof ui.address === "string" && ui.address.trim()) ||
        pickCompanyNameFromUserInfo(ui) ||
        tenant.display_name ||
        "Maintafox customer";
      invoiceBody.address = address;
    }

    const failInitiate = async (status: number, body: Record<string, unknown>, errorMessage: string) => {
      await db.run(`UPDATE payment_orders SET status = 'failed', error_message = ?, updated_at = mfx_utc_now_text() WHERE id = ?`, errorMessage.slice(0, 500), orderId);
      if (tenantCreated) {
        // Avoid orphan tenants when SlickPay rejects the first checkout for a new customer.
        const hasLicense = Boolean(await pickActiveLicenseForTenant(tenant.id));
        if (!hasLicense) {
          await db.run(`DELETE FROM payment_orders WHERE id = ?`, orderId);
          await db.run(`DELETE FROM tenants WHERE id = ?`, tenant.id);
        }
      }
      res.status(status).json(body);
    };

    try {
      const created = await slickPayApi("POST", "/api/v2/users/invoices", invoiceBody);
      if (!created.ok) {
        await failInitiate(
          502,
          { error: "slickpay_create_failed", status: created.status, details: created.json },
          `http_${created.status}:${JSON.stringify(created.json).slice(0, 400)}`,
        );
        return;
      }
      const data =
        created.json.data && typeof created.json.data === "object"
          ? (created.json.data as Record<string, unknown>)
          : created.json;
      const invoiceId =
        created.json.id !== undefined && created.json.id !== null
          ? String(created.json.id)
          : data.id !== undefined && data.id !== null
            ? String(data.id)
            : null;
      const checkoutUrl =
        (typeof created.json.url === "string" && created.json.url) ||
        (typeof data.url === "string" && data.url) ||
        null;
      if (!invoiceId || !checkoutUrl) {
        await failInitiate(
          502,
          { error: "slickpay_invalid_response", details: created.json },
          "missing_invoice_id_or_url",
        );
        return;
      }

      await db.run(`UPDATE payment_orders
         SET slickpay_invoice_id = ?, slickpay_payment_url = ?, status = 'awaiting_payment', updated_at = mfx_utc_now_text()
         WHERE id = ?`, invoiceId, checkoutUrl, orderId);

      await appendAuditRecord({
        actor_id: "payment_proxy",
        action_code: "payment_initiate",
        action_category: "billing",
        correlation_id: orderId,
        scope_tenant_id: tenant.id,
        entity_refs: { tenant_id: tenant.id, entitlement_id: license?.id },
        payload: {
          payment_order_id: orderId,
          plan: input.plan,
          total_amount: totalAmount,
          invoice_id: invoiceId,
          tenant_created: tenantCreated,
        },
      });

      res.status(201).json({
        checkout_url: checkoutUrl,
        payment_order_id: orderId,
        invoice_id: invoiceId,
        total_amount: totalAmount,
        currency: "DZD",
        plan: input.plan,
        tenant_id: tenant.id,
        tenant_created: tenantCreated,
        license_id: license?.id ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failInitiate(502, { error: "slickpay_network_error", message }, message);
    }
  });

  /** SlickPay webhook: verify signature, extend license +1 year, bump entitlement lineage. */
  app.post("/api/v1/webhooks/slickpay", systemScopeMiddleware(db, "slickpay-webhook"), async (req, res) => {
    if (!slickPayConfigured() || !SLICKPAY_WEBHOOK_SECRET) {
      res.status(503).json({ error: "slickpay_not_configured" });
      return;
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const headerSig =
      req.header("x-slickpay-signature") ??
      req.header("x-webhook-signature") ??
      req.header("webhook-signature") ??
      (typeof payload.webhook_signature === "string" ? payload.webhook_signature : null) ??
      (typeof payload.signature === "string" ? payload.signature : null);
    if (!headerSig || !safeEqualUtf8(String(headerSig), SLICKPAY_WEBHOOK_SECRET)) {
      res.status(401).json({ error: "invalid_webhook_signature" });
      return;
    }

    const invoiceIdRaw =
      payload.id ??
      payload.invoice_id ??
      (payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>).id ?? (payload.data as Record<string, unknown>).invoice_id
        : null);
    const invoiceId = invoiceIdRaw !== null && invoiceIdRaw !== undefined ? String(invoiceIdRaw) : null;
    if (!invoiceId) {
      res.status(400).json({ error: "missing_invoice_id" });
      return;
    }

    let paymentStatus = "";
    try {
      const details = await slickPayApi("GET", `/api/v2/users/invoices/${encodeURIComponent(invoiceId)}`);
      if (!details.ok) {
        res.status(502).json({ error: "slickpay_verify_failed", status: details.status });
        return;
      }
      const data =
        details.json.data && typeof details.json.data === "object"
          ? (details.json.data as Record<string, unknown>)
          : details.json;
      paymentStatus = String(data.payment_status ?? data.status ?? "").toLowerCase();
    } catch (err) {
      res.status(502).json({
        error: "slickpay_verify_network_error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (paymentStatus !== "paid") {
      res.status(200).json({ ok: true, ignored: true, payment_status: paymentStatus });
      return;
    }

    let order = await db.get(`SELECT id, tenant_id, license_id, plan, extra_slots, status
         FROM payment_orders WHERE slickpay_invoice_id = ? ORDER BY created_at DESC LIMIT 1`, invoiceId) as
      | {
          id: string;
          tenant_id: string;
          license_id: string | null;
          plan: string;
          extra_slots: number;
          status: string;
        }
      | undefined;

    if (!order) {
      const metaRaw = payload.webhook_meta_data ?? payload.meta_data ?? payload.metadata;
      const metaCandidate = Array.isArray(metaRaw)
        ? metaRaw.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        : metaRaw;
      const meta =
        metaCandidate && typeof metaCandidate === "object" && !Array.isArray(metaCandidate)
          ? (metaCandidate as Record<string, unknown>)
          : null;
      const orderId = meta?.payment_order_id ? String(meta.payment_order_id) : null;
      if (orderId) {
        order = await db.get(`SELECT id, tenant_id, license_id, plan, extra_slots, status FROM payment_orders WHERE id = ?`, orderId) as typeof order;
      }
    }

    if (!order) {
      res.status(404).json({ error: "payment_order_not_found", invoice_id: invoiceId });
      return;
    }
    if (order.status === "paid") {
      res.status(200).json({ ok: true, already_processed: true, payment_order_id: order.id });
      return;
    }

    type RenewLicenceRow = {
      id: string;
      tenant_id: string;
      max_machines: number;
      expires_at: string | null;
      revoked_at: string | null;
    };
    const extraSlots = Math.max(0, order.extra_slots ?? 0);
    const nowIso = new Date().toISOString();
    let issuedNewLicense = false;
    let previousExpires: string | null = null;
    let nextExpires = "";
    let nextMaxMachines = 0;
    let finalLicense: RenewLicenceRow | undefined;
    let licenceRevoked = false;
    try {
      let raceAlreadyPaid = false;
      await db.tx(async () => {
        // Two deliveries of the same webhook must not both extend the licence, and two different
        // paid orders of one tenant must extend it one after the other (each from the latest
        // expiry): lock the tenant's renewals and the order, then read the licence under the lock.
        await db.lockXact("licence-renewal", order.tenant_id);
        const locked = await db.get<{ status: string }>(
          `SELECT status FROM payment_orders WHERE id = ? FOR UPDATE`,
          order.id,
        );
        if (locked?.status === "paid") {
          raceAlreadyPaid = true;
          return;
        }
        let license = order.license_id
          ? await db.get<RenewLicenceRow>(
              `SELECT id, tenant_id, max_machines, expires_at, revoked_at FROM license_keys WHERE id = ? FOR UPDATE`,
              order.license_id,
            )
          : undefined;
        if (!license) {
          license = await pickActiveLicenseForTenant(order.tenant_id);
        }
        if (license?.revoked_at) {
          licenceRevoked = true;
          await db.run(
            `UPDATE payment_orders SET status = 'failed', error_message = 'license_revoked', updated_at = mfx_utc_now_text() WHERE id = ?`,
            order.id,
          );
          return;
        }
        previousExpires = license?.expires_at ?? null;
        nextExpires = computeLicenseExpiresPlusOneYear(license?.expires_at ?? null);
        nextMaxMachines = license ? license.max_machines + extraSlots : 1 + extraSlots;
        finalLicense = license;
        if (!finalLicense) {
          const issued = await issueLicenseForPaidOrder({
            tenantId: order.tenant_id,
            maxMachines: nextMaxMachines,
            expiresAt: nextExpires,
          });
          finalLicense = {
            id: issued.id,
            tenant_id: order.tenant_id,
            max_machines: issued.max_machines,
            expires_at: issued.expires_at,
            revoked_at: null,
          };
          issuedNewLicense = true;
        } else {
          await db.run(
            `UPDATE license_keys SET expires_at = ?, max_machines = ? WHERE id = ?`,
            nextExpires,
            nextMaxMachines,
            finalLicense.id,
          );
        }
        await db.run(`UPDATE tenants SET entitlement_lineage = entitlement_lineage + 1 WHERE id = ?`, finalLicense.tenant_id);
        await db.run(
          `UPDATE payment_orders
           SET status = 'paid', paid_at = ?, license_id = ?, slickpay_invoice_id = COALESCE(slickpay_invoice_id, ?),
               updated_at = mfx_utc_now_text()
           WHERE id = ?`,
          nowIso,
          finalLicense.id,
          invoiceId,
          order.id,
        );
      });
      if (licenceRevoked) {
        res.status(409).json({ error: "license_revoked" });
        return;
      }
      if (raceAlreadyPaid) {
        res.status(200).json({ ok: true, already_processed: true, payment_order_id: order.id });
        return;
      }
    } catch (err) {
      res.status(404).json({
        error: "license_issue_failed",
        tenant_id: order.tenant_id,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!finalLicense) {
      res.status(500).json({ error: "license_missing_after_payment" });
      return;
    }

    await appendAuditRecord({
      actor_id: "system_slickpay_webhook",
      action_code: issuedNewLicense ? "license_issue" : "license_renew",
      action_category: "billing",
      correlation_id: order.id,
      scope_tenant_id: finalLicense.tenant_id,
      reason_code: "slickpay_paid",
      entity_refs: { tenant_id: finalLicense.tenant_id, entitlement_id: finalLicense.id },
      payload: {
        payment_order_id: order.id,
        invoice_id: invoiceId,
        plan: order.plan,
        previous_expires_at: previousExpires,
        expires_at: nextExpires,
        max_machines: nextMaxMachines,
        license_issued: issuedNewLicense,
        entitlement_lineage_bumped: true,
      },
    });

    res.status(200).json({
      ok: true,
      payment_order_id: order.id,
      tenant_id: finalLicense.tenant_id,
      license_id: finalLicense.id,
      expires_at: nextExpires,
      previous_expires_at: previousExpires,
      max_machines: nextMaxMachines,
      license_issued: issuedNewLicense,
    });
  });
}

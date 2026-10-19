/**
 * SlickPay (Algerian CIB / EDAHABIA gateway) as documented by SlickPay itself:
 *   https://developers.slick-pay.com (Authentication, Quick Integration, Invoices) and the official
 *   SDKs in https://github.com/Slick-Pay-Algeria (slickpay-npm, slickpay-wp, whmcs).
 *
 * - Base URL: live https://prodapi.slick-pay.com/api/v2, sandbox https://devapi.slick-pay.com/api/v2.
 * - Every call: `Authorization: Bearer <public key>`. No documented call uses a secret key.
 * - POST /users/invoices creates an invoice (amount in DZD) and answers {success, message, id, url};
 *   the customer pays on `url` (SATIM) and comes back to the invoice's `url` parameter.
 * - GET /users/invoices/:id is the payment status. The docs disagree on its shape: the Invoice
 *   Details page shows a `completed` flag (0/1), the WordPress plugin reads `data.completed`, the
 *   Quick Integration page reads `data.payment_status` ('paid' | 'unpaid'). `interpretInvoice`
 *   accepts each of them and calls an invoice paid only when no signal contradicts another.
 * - The webhook payload and how `webhook_signature` comes back are not documented. The WHMCS module
 *   reads a form POST with `id`, `success`, `amount` and `meta_data[...]` (the invoice's
 *   webhook_meta_data). A webhook is therefore only a hint: nothing is granted before the invoice
 *   status is read back from SlickPay with our own stored invoice id.
 */
import { createHash, randomBytes } from "node:crypto";

export type SlickPayConfig =
  | { mode: "disabled" }
  | {
      mode: "enabled";
      apiBaseUrl: string;
      publicKey: string;
      webhookUrl: string;
      returnUrl: string;
      httpTimeoutMs: number;
      reconcileIntervalMinutes: number;
      orderExpiryHours: number;
    };

/** Former settings this version no longer reads; still present in an .env they are reported once. */
export const OBSOLETE_SLICKPAY_SETTINGS = [
  "SLICKPAY_SECRET_KEY",
  "SLICKPAY_WEBHOOK_SECRET",
  "SLICKPAY_DEFAULT_RETURN_URL",
  "SLICKPAY_EXTRA_SLOT_PRICE",
] as const;

/**
 *   SLICKPAY_MODE = disabled | enabled                                  (required)
 *   with enabled, all required:
 *   SLICKPAY_PUBLIC_KEY                 public key from the SlickPay dashboard
 *   SLICKPAY_API_BASE_URL               https://prodapi.slick-pay.com/api/v2 (live) or the sandbox
 *   SLICKPAY_WEBHOOK_URL                public URL of POST /api/v1/webhooks/slickpay
 *   SLICKPAY_RETURN_URL                 page the customer returns to (the website's order status page)
 *   SLICKPAY_HTTP_TIMEOUT_MS            per call to SlickPay
 *   SLICKPAY_RECONCILE_INTERVAL_MINUTES first re-check of an unpaid order, doubled after each check
 *   SLICKPAY_ORDER_EXPIRY_HOURS         an order still unpaid after this is marked expired
 */
export function loadSlickPayConfig(env: NodeJS.ProcessEnv = process.env): SlickPayConfig {
  const mode = env["SLICKPAY_MODE"]?.trim();
  if (mode === "disabled") return { mode };
  if (mode !== "enabled") {
    throw new Error("SLICKPAY_MODE is required: 'disabled' or 'enabled' (see .env.example).");
  }
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is required when SLICKPAY_MODE=enabled.`);
    return v;
  };
  const url = (name: string): string => {
    const raw = need(name);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${name} must be an absolute URL, got '${raw}'.`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
      throw new Error(`${name} must use https (plain http is accepted only for a loopback test server).`);
    }
    return raw.replace(/\/+$/, "");
  };
  const positive = (name: string, max: number): number => {
    const raw = need(name);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${name} must be a number in (0, ${max}], got '${raw}'.`);
    return n;
  };
  const apiBaseUrl = url("SLICKPAY_API_BASE_URL");
  if (!apiBaseUrl.endsWith("/api/v2")) {
    throw new Error("SLICKPAY_API_BASE_URL must end with /api/v2 (live: https://prodapi.slick-pay.com/api/v2).");
  }
  return {
    mode,
    apiBaseUrl,
    publicKey: need("SLICKPAY_PUBLIC_KEY"),
    webhookUrl: url("SLICKPAY_WEBHOOK_URL"),
    returnUrl: url("SLICKPAY_RETURN_URL"),
    httpTimeoutMs: Math.round(positive("SLICKPAY_HTTP_TIMEOUT_MS", 120_000)),
    reconcileIntervalMinutes: positive("SLICKPAY_RECONCILE_INTERVAL_MINUTES", 24 * 60),
    orderExpiryHours: positive("SLICKPAY_ORDER_EXPIRY_HOURS", 30 * 24),
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export type SlickPayCall =
  | { kind: "ok"; status: number; json: Record<string, unknown> }
  | { kind: "http_error"; status: number; json: Record<string, unknown> }
  | { kind: "timeout" }
  | { kind: "network"; message: string };

export function createSlickPayClient(config: Extract<SlickPayConfig, { mode: "enabled" }>) {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<SlickPayCall> {
    let res: Response;
    try {
      res = await fetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.publicKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
      return { kind: "network", message: err instanceof Error ? err.message : String(err) };
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch (err) {
      // Not JSON (an HTML error page, an empty body) or the body timed out: judged by the status code.
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
    }
    return res.ok ? { kind: "ok", status: res.status, json } : { kind: "http_error", status: res.status, json };
  }

  return {
    createInvoice: (body: Record<string, unknown>) => call("POST", "/users/invoices", body),
    getInvoice: (invoiceId: string) => call("GET", `/users/invoices/${encodeURIComponent(invoiceId)}`),
  };
}

export type SlickPayClient = ReturnType<typeof createSlickPayClient>;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Invoice id and payment page of a create-invoice answer ({id, url} at the top, or under data). */
export function readCreatedInvoice(json: Record<string, unknown>): { invoiceId: string; paymentUrl: string } | null {
  const data = asObject(json.data);
  const invoiceId = asText(json.id) ?? asText(data?.id);
  const rawUrl = asText(json.url) ?? asText(data?.url);
  if (!invoiceId || !rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { invoiceId, paymentUrl: rawUrl };
}

export type InvoiceVerdict = {
  state: "paid" | "unpaid" | "unknown";
  /** The invoice amount SlickPay reports (what we asked for), when it reports one. */
  invoiceAmount: number | null;
  /** What the customer's card paid (may include SlickPay's commission), when reported. */
  paidAmount: number | null;
  /** SlickPay serial / transaction reference, when reported. */
  transactionRef: string | null;
  /** The status fields seen, e.g. ["completed=1", "data.payment_status=paid"] (no customer data). */
  signals: string[];
};

/** Reads a GET /users/invoices/:id answer; see the module comment for the shapes accepted. */
export function interpretInvoice(json: Record<string, unknown>): InvoiceVerdict {
  const data = asObject(json.data);
  const signals: string[] = [];
  let positive = 0;
  let negative = 0;
  for (const [prefix, obj] of [["", json], ["data.", data]] as const) {
    if (!obj) continue;
    const completed = obj.completed;
    if (completed === 1 || completed === true || completed === "1") {
      positive += 1;
      signals.push(`${prefix}completed=1`);
    } else if (completed === 0 || completed === false || completed === "0") {
      negative += 1;
      signals.push(`${prefix}completed=0`);
    }
    if (typeof obj.payment_status === "string") {
      const status = obj.payment_status.trim().toLowerCase();
      signals.push(`${prefix}payment_status=${status.slice(0, 32)}`);
      if (status === "paid") positive += 1;
      else if (status === "unpaid") negative += 1;
    }
  }
  const transaction = asObject(data?.transaction);
  return {
    state: positive > 0 && negative === 0 ? "paid" : negative > 0 && positive === 0 ? "unpaid" : "unknown",
    invoiceAmount: asAmount(data?.amount) ?? asAmount(json.amount),
    paidAmount: asAmount(transaction?.amount),
    transactionRef: asText(data?.serial) ?? asText(transaction?.serial) ?? null,
    signals,
  };
}

export type WebhookHint = {
  invoiceId: string | null;
  /** Our order id, from the meta data we attached to the invoice. */
  orderId: string | null;
  /** Our per-order token, from the meta data or a signature field, if SlickPay sent one back. */
  token: string | null;
};

/** Pulls the invoice id and our meta data out of a webhook body (JSON or form-encoded). */
export function readWebhookHint(body: unknown, headerSignature: string | null): WebhookHint {
  const root = asObject(body) ?? {};
  const data = asObject(root.data);
  const metaRaw = root.meta_data ?? root.webhook_meta_data ?? root.metadata ?? data?.meta_data ?? data?.webhook_meta_data;
  const meta = Array.isArray(metaRaw) ? (metaRaw.map(asObject).find(Boolean) ?? null) : asObject(metaRaw);
  return {
    invoiceId: asText(root.id) ?? asText(root.invoice_id) ?? asText(data?.id) ?? null,
    orderId: asText(meta?.payment_order_id) ?? null,
    token: asText(meta?.mfx_token) ?? headerSignature ?? asText(root.webhook_signature) ?? asText(root.signature) ?? null,
  };
}

export function newSecretToken(): string {
  return randomBytes(32).toString("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** DZD amounts are kept to the centime. */
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

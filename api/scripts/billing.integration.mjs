/**
 * Billing and subscription (master plan Phase 4.4) against a real Postgres and the real API. SlickPay
 * itself is an external payment provider: the test runs a local HTTP server that answers its two
 * endpoints the API calls (create invoice, read invoice) with statuses the test sets, so every path
 * is exercised without real money. Checks: payment history as stored, licence term and slots,
 * reconciliation applies a payment only when SlickPay reports it paid (lost webhook), never undoes
 * one, never applies twice (webhook after reconciliation), and licence changes are audited.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const SLICKPAY_PORT = 33232;
const WEBHOOK_SECRET = "test-only-slickpay-webhook-secret";
const invoices = new Map(); // invoice id -> { status, body }
let nextInvoice = 1000;

const slickpay = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  res.setHeader("Content-Type", "application/json");
  if (req.method === "POST" && req.url === "/api/v2/users/invoices") {
    nextInvoice += 1;
    const id = String(nextInvoice);
    invoices.set(id, { status: "pending", body: JSON.parse(raw) });
    res.end(JSON.stringify({ success: 1, id, url: `https://pay.example.test/invoice/${id}` }));
    return;
  }
  const m = /^\/api\/v2\/users\/invoices\/(\d+)$/.exec(req.url ?? "");
  if (req.method === "GET" && m && invoices.has(m[1])) {
    res.end(JSON.stringify({ data: { id: m[1], payment_status: invoices.get(m[1]).status } }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});
slickpay.listen(SLICKPAY_PORT, "127.0.0.1");
await once(slickpay, "listening");

const api = await startControlApi({
  port: 33231,
  extraEnv: {
    SLICKPAY_PUBLIC_KEY: "test-public-key",
    SLICKPAY_SECRET_KEY: "test-secret-key",
    SLICKPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SLICKPAY_API_BASE_URL: `http://127.0.0.1:${SLICKPAY_PORT}`,
    SLICKPAY_WEBHOOK_URL: "http://127.0.0.1:33231/api/v1/webhooks/slickpay",
    SLICKPAY_DEFAULT_RETURN_URL: "http://localhost:5174/vendor-console/billing",
    SLICKPAY_EXTRA_SLOT_PRICE: "1000",
  },
});

try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const token = owner.accessToken;
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;
  const tenant = (await api.call("POST", "/api/v1/tenants", token, { slug: "billing-co", display_name: "Billing Co" })).json;
  const licence = (await api.call("POST", "/api/v1/licenses", token, { tenant_id: tenant.id, max_machines: 1, expires_at: "2027-01-01T00:00:00.000Z" })).json;

  // ── Licence changes are audited (term / slots / channel) ─────────────────────────────────
  const patched = await api.call(
    "PATCH",
    `/api/v1/licenses/${licence.id}`,
    token,
    { max_machines: 1, operator_rationale: "contract amendment" },
    { "X-Operator-Reason": "amendment" },
  );
  assert.equal(patched.status, 200, patched.text);
  assert.equal(await audited("license_update"), 1);

  // ── Payment link (renewal + 2 extra slots) ────────────────────────────────────────────────
  const link = await api.call("POST", "/api/v1/payments/slickpay/initiate", token, { tenant_id: tenant.id, plan: "standard", amount: 50000, extra_slots: 2 });
  assert.equal(link.status, 201, link.text);
  assert.equal(link.json.total_amount, 52000, "extra slots priced from SLICKPAY_EXTRA_SLOT_PRICE");
  const orderId = link.json.payment_order_id;
  const invoiceId = link.json.invoice_id;

  const sub = await api.call("GET", `/api/v1/billing/tenants/${tenant.id}/subscription`, token);
  assert.equal(sub.status, 200, sub.text);
  assert.equal(sub.json.slickpay_configured, true);
  assert.equal(sub.json.extra_slot_price, 1000);
  assert.equal(sub.json.licences[0].max_machines, 1);
  assert.equal(sub.json.licences[0].active_machines, 0);
  assert.ok(Number.isInteger(sub.json.licences[0].days_left));
  assert.equal(sub.json.payments[0].status, "awaiting_payment", "the stored status, as is");
  assert.equal(sub.json.payments[0].user_info_json, undefined, "customer contact data is not exposed");

  // ── Reconciliation: SlickPay says pending → nothing changes ───────────────────────────────
  const reconcile = (id, reason = "customer says paid") =>
    api.call("POST", `/api/v1/billing/payments/${id}/reconcile`, token, undefined, { "X-Operator-Reason": reason });
  assert.equal((await api.call("POST", `/api/v1/billing/payments/${orderId}/reconcile`, token)).status, 400, "a reason is required");
  const stillPending = await reconcile(orderId);
  assert.equal(stillPending.status, 200, stillPending.text);
  assert.deepEqual(
    [stillPending.json.stored_status, stillPending.json.slickpay_status, stillPending.json.applied, stillPending.json.outcome],
    ["awaiting_payment", "pending", false, "unchanged"],
  );
  assert.equal(stillPending.json.order.status, "awaiting_payment", "never fakes a payment");
  assert.equal(stillPending.json.order.last_reconciled_status, "pending");

  // ── The customer paid but the webhook was lost → reconciliation applies it ────────────────
  invoices.get(invoiceId).status = "paid";
  const applied = await reconcile(orderId);
  assert.equal(applied.json.applied, true, applied.text);
  assert.equal(applied.json.order.status, "paid");
  const renewed = (await api.call("GET", `/api/v1/billing/tenants/${tenant.id}/subscription`, token)).json.licences[0];
  assert.equal(renewed.expires_at.slice(0, 10), "2028-01-01", "one year added to the current expiry");
  assert.equal(renewed.max_machines, 3, "extra slots added");
  const renewAudit = await api.su("SELECT actor_id, reason_code FROM audit_records WHERE action_code = 'license_renew'");
  assert.deepEqual(renewAudit, [{ actor_id: "user_1", reason_code: "slickpay_reconciled" }]);

  // A late webhook does not apply it twice; a second reconciliation changes nothing.
  const lateWebhook = await fetch(`${api.baseUrl}/api/v1/webhooks/slickpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-slickpay-signature": WEBHOOK_SECRET },
    body: JSON.stringify({ id: invoiceId }),
  });
  assert.equal((await lateWebhook.json()).already_processed, true);
  assert.equal((await reconcile(orderId)).json.outcome, "unchanged");
  assert.equal((await api.call("GET", `/api/v1/billing/tenants/${tenant.id}/subscription`, token)).json.licences[0].max_machines, 3);

  // ── SlickPay no longer reports a paid order as paid → flagged, never undone ──────────────
  invoices.get(invoiceId).status = "refunded";
  const mismatch = await reconcile(orderId, "bank says refunded");
  assert.equal(mismatch.json.outcome, "mismatch_paid_here_not_at_slickpay");
  assert.equal(mismatch.json.order.status, "paid");
  assert.equal(mismatch.json.order.last_reconciled_status, "refunded");
  assert.equal(await audited("payment_reconciled"), 4);

  // ── Webhook path (shared with reconciliation) still renews ──────────────────────────────
  const link2 = await api.call("POST", "/api/v1/payments/slickpay/initiate", token, { tenant_id: tenant.id, plan: "standard", amount: 50000 });
  invoices.get(link2.json.invoice_id).status = "paid";
  const webhook = await fetch(`${api.baseUrl}/api/v1/webhooks/slickpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-slickpay-signature": WEBHOOK_SECRET },
    body: JSON.stringify({ id: link2.json.invoice_id }),
  });
  const webhookBody = await webhook.json();
  assert.equal(webhook.status, 200, JSON.stringify(webhookBody));
  assert.equal(webhookBody.expires_at.slice(0, 10), "2029-01-01");

  // ── History across customers, with filters ─────────────────────────────────────────────
  const all = (await api.call("GET", "/api/v1/billing/payments?status=paid", token)).json;
  assert.equal(all.length, 2);
  assert.equal((await api.call("GET", "/api/v1/billing/payments?status=bogus", token)).status, 400);
  assert.equal(
    (await api.call("POST", "/api/v1/billing/payments/order_nope/reconcile", token, undefined, { "X-Operator-Reason": "check" })).status,
    404,
  );

  console.log("billing (4.4): all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
  slickpay.close();
}

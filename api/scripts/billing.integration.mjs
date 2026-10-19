/**
 * Billing and SlickPay payments against a real Postgres, the real API and a local SlickPay stand-in
 * built from SlickPay's documentation (lib/slickpay-standin.mjs): no real money moves.
 *
 * Checks: the server owns the price (tampered amounts refused); invoice requests follow SlickPay's
 * contract; a paid invoice is fulfilled exactly once (new customer, renewal, edition change, seats)
 * whether the confirmation comes from a form-encoded or JSON webhook, the customer's status page,
 * the operator or the reconciliation worker; duplicate and forged webhooks change nothing; amount
 * mismatches, unrecognised statuses, inactive customers and legacy orders wait for a person;
 * SlickPay timeouts change nothing and are retried; unpaid orders expire but a late payment is still
 * honoured; a refund is flagged, never undone; logs carry no key and no customer contact data.
 */
import assert from "node:assert/strict";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { startSlickPayStandIn } from "./lib/slickpay-standin.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

// TEST-ONLY values: not a SlickPay key.
const PUBLIC_KEY = "54|test-only-public-key-not-a-slickpay-key";
const OBSOLETE_SECRET = "test-only-obsolete-secret-value";
const PROXY_TOKEN = "test-only-website-proxy-token-0123456789abcdef";
const PORT = 33231;
const WORKER_PORT = 33232;

const sp = await startSlickPayStandIn({ publicKey: PUBLIC_KEY });
const slickpayEnv = (overrides = {}) => ({
  SLICKPAY_MODE: "enabled",
  SLICKPAY_PUBLIC_KEY: PUBLIC_KEY,
  SLICKPAY_API_BASE_URL: sp.baseUrl,
  SLICKPAY_WEBHOOK_URL: `http://127.0.0.1:${PORT}/api/v1/webhooks/slickpay`,
  SLICKPAY_RETURN_URL: "http://localhost:3000/checkout/result",
  SLICKPAY_HTTP_TIMEOUT_MS: "1500",
  // Long here, so that only the second API instance below (the worker test) re-checks by itself.
  SLICKPAY_RECONCILE_INTERVAL_MINUTES: "60",
  SLICKPAY_ORDER_EXPIRY_HOURS: "24",
  // A setting of the previous version left in an .env: reported by name, otherwise ignored.
  SLICKPAY_SECRET_KEY: OBSOLETE_SECRET,
  WEBSITE_PROXY_TOKEN: PROXY_TOKEN,
  ...overrides,
});
const api = await startControlApi({ port: PORT, extraEnv: slickpayEnv() });
let workerApi = null;

const buyer = { firstname: "Amina", lastname: "Test", email: "amina.buyer@example.test", phone: "+213555000000", company: "Usine Test SARL" };
const CORE = { base_amount: 120000, included_seats: 1, extra_seat_amount: 20000, max_extra_seats: 500, term_months: 12, is_active: true };
const PRO = { base_amount: 240000, included_seats: 3, extra_seat_amount: 30000, max_extra_seats: 500, term_months: 12, is_active: true };

async function http(method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const token = owner.accessToken;
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;
  const order = async (id) => (await api.su("SELECT * FROM payment_orders WHERE id = $1", [id]))[0];
  const invoiceOf = async (orderId) => (await order(orderId)).slickpay_invoice_id;
  const tokenOf = (invoiceId) => new URL(sp.invoice(invoiceId).request.url).searchParams.get("token");
  const licences = (tenantId) => api.su("SELECT * FROM license_keys WHERE tenant_id = $1 ORDER BY created_at", [tenantId]);
  const publicInitiate = (body) => http("POST", `${api.baseUrl}/api/v1/payments/slickpay/initiate`, body);
  const statusPage = (orderId, t) => http("GET", `${api.baseUrl}/api/v1/payments/slickpay/orders/${orderId}/status?token=${encodeURIComponent(t)}`);
  const reconcile = (id, reason = "customer says paid") =>
    api.call("POST", `/api/v1/billing/payments/${id}/reconcile`, token, undefined, { "X-Operator-Reason": reason });
  const putPrice = (plan, body, reason = "initial price list") =>
    api.call("PUT", `/api/v1/billing/prices/${plan}`, token, body, { "X-Operator-Reason": reason });
  const link = async (tenantId, plan, extraSlots) => {
    const r = await api.call("POST", "/api/v1/billing/payment-links", token, { tenant_id: tenantId, plan, extra_slots: extraSlots, buyer });
    assert.equal(r.status, 201, r.text);
    return { orderId: r.json.payment_order_id, invoiceId: await invoiceOf(r.json.payment_order_id), total: r.json.total_amount };
  };
  const webhookUrl = `${api.baseUrl}/api/v1/webhooks/slickpay`;

  // ── Configuration as seen by the console (names only) ───────────────────────────────────────
  const status0 = await api.call("GET", "/api/v1/billing/status", token);
  assert.equal(status0.status, 200, status0.text);
  assert.equal(status0.json.slickpay.mode, "enabled");
  assert.deepEqual(status0.json.slickpay.ignored_settings, ["SLICKPAY_SECRET_KEY"]);
  assert.ok(!status0.text.includes(PUBLIC_KEY), "the key is never returned");

  // ── Price list: nothing is for sale until the owner sets a price ─────────────────────────────
  assert.deepEqual((await http("GET", `${api.baseUrl}/api/v1/payments/slickpay/prices`)).json.prices, []);
  const noPrice = await publicInitiate({ plan: "core", extra_slots: 0, user_info: buyer });
  assert.equal(noPrice.status, 400, noPrice.text);
  assert.equal(noPrice.json.error, "plan_not_for_sale");
  assert.equal(sp.requests.length, 0, "nothing reached SlickPay");
  assert.equal((await api.call("PUT", "/api/v1/billing/prices/core", token, CORE)).status, 400, "a reason is required");
  assert.equal((await putPrice("no-such-edition", CORE)).status, 404);
  assert.equal((await putPrice("core", { ...CORE, base_amount: 0.001 })).status, 400, "DZD to the centime");
  assert.equal((await putPrice("core", CORE)).status, 200);
  assert.equal((await putPrice("professional", PRO)).status, 200);
  assert.equal(await audited("price_update"), 2);
  const prices = (await http("GET", `${api.baseUrl}/api/v1/payments/slickpay/prices`)).json.prices;
  assert.deepEqual(
    prices.map((p) => [p.plan, p.base_amount, p.included_seats, p.extra_seat_amount, p.currency]),
    [["core", 120000, 1, 20000, "DZD"], ["professional", 240000, 3, 30000, "DZD"]],
  );

  // ── Price tampering: the caller's amount is compared, never charged ──────────────────────────
  const tampered = await publicInitiate({ plan: "core", extra_slots: 2, user_info: buyer, amount: 1 });
  assert.equal(tampered.status, 409, tampered.text);
  assert.equal(tampered.json.error, "price_changed");
  assert.equal(tampered.json.quote.total_amount, 160000, "base + 2 x extra seat");
  assert.equal(sp.requests.length, 0, "no invoice for a tampered amount");
  const smuggled = await publicInitiate({ plan: "core", extra_slots: 0, user_info: buyer, return_url: "https://evil.example/" });
  assert.equal(smuggled.status, 400, "the return URL is the server's, not the caller's");

  // ── New customer: checkout, the invoice SlickPay receives, the status page ───────────────────
  const created = await publicInitiate({ plan: "core", extra_slots: 2, user_info: buyer, expected_total_amount: 160000 });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.total_amount, 160000);
  assert.equal(created.json.currency, "DZD");
  const newOrderId = created.json.payment_order_id;
  const inv1 = await invoiceOf(newOrderId);
  assert.equal(created.json.checkout_url, sp.invoice(inv1).url, "the customer goes to SlickPay's payment page");
  const req1 = sp.invoice(inv1).request;
  assert.equal(req1.amount, 160000, "amount in DZD, as priced by the server");
  assert.equal(req1.items.reduce((s, i) => s + i.price * i.quantity, 0), 160000, "items add up to the amount");
  assert.deepEqual([req1.firstname, req1.lastname, req1.email, req1.phone, req1.address], [buyer.firstname, buyer.lastname, buyer.email, buyer.phone, buyer.company]);
  assert.equal(req1.webhook_url, webhookUrl);
  assert.equal(req1.webhook_meta_data.payment_order_id, newOrderId);
  assert.equal(req1.webhook_signature, req1.webhook_meta_data.mfx_token);
  const ret = new URL(req1.url);
  assert.equal(`${ret.origin}${ret.pathname}`, "http://localhost:3000/checkout/result");
  assert.equal(ret.searchParams.get("order"), newOrderId);
  assert.ok(sp.requests.every((r) => r.auth === `Bearer ${PUBLIC_KEY}`), "Bearer public key on every call");
  const pending = await order(newOrderId);
  assert.equal(pending.status, "awaiting_payment");
  assert.equal(pending.tenant_id, null, "no tenant before payment");
  assert.equal((await statusPage(newOrderId, tokenOf(inv1))).json.status, "pending");
  assert.equal((await statusPage(newOrderId, "not-the-token")).status, 404);

  // The customer pays; SlickPay calls the webhook the way its WHMCS module receives it (form POST).
  sp.pay(inv1);
  const hook = await sp.sendWebhook(inv1);
  assert.equal(hook.status, 200, hook.text);
  assert.equal(hook.json.outcome, "applied");
  const paid = await order(newOrderId);
  assert.equal(paid.status, "paid");
  assert.equal(paid.slickpay_paid_amount, 166400, "card amount incl. SlickPay commission");
  assert.equal(paid.slickpay_transaction_ref, sp.invoice(inv1).serial);
  assert.equal(paid.licence_delivery, "disabled", "no e-mail configured: shown to the operator");
  const newTenant = (await api.su("SELECT * FROM tenants WHERE id = $1", [paid.tenant_id]))[0];
  assert.equal(newTenant.display_name, buyer.company);
  assert.equal(newTenant.edition, "core");
  const [issued] = await licences(paid.tenant_id);
  assert.equal(issued.max_machines, 3, "1 included + 2 extra");
  const months = (Date.parse(issued.expires_at) - Date.now()) / (30.44 * 86_400_000);
  assert.ok(months > 11.9 && months < 12.1, `12 months, got ${months}`);
  const page1 = await statusPage(newOrderId, tokenOf(inv1));
  assert.equal(page1.json.status, "paid");
  assert.equal(page1.json.email_hint, "a***@example.test");

  // ── Duplicate webhooks (also concurrent, also JSON): fulfilled once ──────────────────────────
  const dupes = await Promise.all([...Array.from({ length: 5 }, () => sp.sendWebhook(inv1)), sp.sendWebhook(inv1, { format: "json" })]);
  assert.ok(dupes.every((d) => d.status === 200 && d.json.outcome === "already_paid"), JSON.stringify(dupes.map((d) => d.json)));
  assert.equal((await licences(paid.tenant_id)).length, 1);
  assert.equal((await licences(paid.tenant_id))[0].expires_at, issued.expires_at);
  assert.equal(await audited("license_issue"), 1);
  assert.equal(await audited("tenant_create"), 1);

  // ── Existing customer (renewal link from the console) ───────────────────────────────────────
  const tenant = (await api.call("POST", "/api/v1/tenants", token, { slug: "billing-co", display_name: "Billing Co" })).json;
  const licence = (await api.call("POST", "/api/v1/licenses", token, { tenant_id: tenant.id, max_machines: 1, expires_at: "2027-01-01T00:00:00.000Z" })).json;
  const l2 = await link(tenant.id, "core", 0);
  assert.equal(l2.total, 120000);

  // ── Forged webhooks ─────────────────────────────────────────────────────────────────────────
  const unknown = await http("POST", webhookUrl, { id: 999999, success: 1, amount: 120000 });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.ignored, "unknown_invoice");
  const reads2 = sp.statusReads(l2.invoiceId);
  const forged = await http("POST", webhookUrl, { id: l2.invoiceId, success: 1, amount: 120000 });
  assert.equal(forged.status, 200, forged.text);
  assert.equal(forged.json.outcome, "not_paid", "a 'success' claim is checked with SlickPay");
  assert.equal(sp.statusReads(l2.invoiceId), reads2 + 1);
  const wrongToken = await sp.sendWebhook(l2.invoiceId, { overrides: { meta_data: { payment_order_id: l2.orderId, mfx_token: "f".repeat(64) } } });
  assert.equal(wrongToken.status, 401);
  assert.equal(sp.statusReads(l2.invoiceId), reads2 + 1, "a wrong token is refused before asking SlickPay");
  assert.equal((await order(l2.orderId)).status, "awaiting_payment");
  assert.equal((await licences(tenant.id))[0].expires_at.slice(0, 10), "2027-01-01");

  // ── Lost webhook: the operator's check applies it (renewal from the current end) ─────────────
  assert.equal((await api.call("POST", `/api/v1/billing/payments/${l2.orderId}/reconcile`, token)).status, 400, "a reason is required");
  const notYet = await reconcile(l2.orderId);
  assert.deepEqual([notYet.json.outcome, notYet.json.slickpay_status, notYet.json.applied], ["unchanged", "unpaid", false]);
  sp.pay(l2.invoiceId);
  const applied2 = await reconcile(l2.orderId);
  assert.equal(applied2.json.outcome, "applied", applied2.text);
  assert.equal((await licences(tenant.id))[0].expires_at.slice(0, 10), "2028-01-01", "12 months after the current end");
  const renewAudit = await api.su("SELECT actor_id, reason_code FROM audit_records WHERE action_code = 'license_renew'");
  assert.deepEqual(renewAudit, [{ actor_id: "user_1", reason_code: "slickpay_reconciled" }]);

  // ── Status page alone confirms (no webhook); plan change; seats = what was paid for ──────────
  const l3 = await link(tenant.id, "professional", 1);
  assert.equal(l3.total, 270000);
  sp.pay(l3.invoiceId);
  const page3 = await statusPage(l3.orderId, tokenOf(l3.invoiceId));
  assert.equal(page3.json.status, "paid", page3.text);
  assert.equal((await api.su("SELECT edition FROM tenants WHERE id = $1", [tenant.id]))[0].edition, "professional");
  const afterPro = (await licences(tenant.id))[0];
  assert.equal(afterPro.expires_at.slice(0, 10), "2029-01-01");
  assert.equal(afterPro.max_machines, 4, "3 included + 1 extra (not added to the previous count)");

  // ── The Quick Integration status shape (data.payment_status) is understood too ──────────────
  sp.setShape("quick_integration");
  const l4 = await link(tenant.id, "professional", 1);
  assert.equal((await reconcile(l4.orderId)).json.slickpay_status, "unpaid");
  sp.pay(l4.invoiceId);
  assert.equal((await reconcile(l4.orderId)).json.outcome, "applied");
  sp.setShape("details_docs");

  // ── Contradicting status fields: not paid, nothing applied ──────────────────────────────────
  const before5 = (await licences(tenant.id))[0].expires_at;
  sp.setShape("conflicting");
  const l5 = await link(tenant.id, "professional", 1);
  sp.pay(l5.invoiceId);
  const conflicting = await reconcile(l5.orderId);
  assert.deepEqual([conflicting.json.outcome, conflicting.json.order.status], ["status_unrecognised", "awaiting_payment"]);
  assert.equal((await licences(tenant.id))[0].expires_at, before5);
  sp.setShape("details_docs");
  assert.equal((await reconcile(l5.orderId)).json.outcome, "applied");

  // ── Amount mismatch: invoice amount changed, or card paid less → a person decides ────────────
  const before6 = (await licences(tenant.id))[0].expires_at;
  const l6 = await link(tenant.id, "professional", 1);
  sp.reportAmount(l6.invoiceId, 1000);
  sp.pay(l6.invoiceId);
  const mismatch = await sp.sendWebhook(l6.invoiceId);
  assert.equal(mismatch.json.outcome, "amount_mismatch");
  assert.deepEqual([(await order(l6.orderId)).status, (await order(l6.orderId)).error_message], ["needs_review", "amount_mismatch"]);
  assert.equal((await statusPage(l6.orderId, tokenOf(l6.invoiceId))).json.status, "review");
  assert.equal((await reconcile(l6.orderId)).json.outcome, "amount_mismatch", "still not applied on a re-check");
  const l7 = await link(tenant.id, "professional", 1);
  sp.pay(l7.invoiceId);
  sp.invoice(l7.invoiceId).transaction.amount = 10;
  assert.equal((await sp.sendWebhook(l7.invoiceId)).json.outcome, "amount_mismatch", "underpaid card");
  assert.equal((await licences(tenant.id))[0].expires_at, before6);
  assert.equal(await audited("payment_needs_review"), 3);

  // ── SlickPay too slow: nothing changes, 503 so a sender retries, the next check applies it ───
  const l8 = await link(tenant.id, "professional", 1);
  sp.pay(l8.invoiceId);
  sp.setGetDelay(3000);
  const slow = await sp.sendWebhook(l8.invoiceId);
  assert.equal(slow.status, 503, slow.text);
  assert.deepEqual([(await order(l8.orderId)).status, (await order(l8.orderId)).last_check_error], ["awaiting_payment", "timeout"]);
  sp.setGetDelay(0);
  assert.equal((await reconcile(l8.orderId)).json.outcome, "applied");

  // ── Cancelled / abandoned: expires; a late payment is still honoured ─────────────────────────
  const l9 = await link(tenant.id, "core", 0);
  assert.equal((await reconcile(l9.orderId)).json.outcome, "unchanged");
  await api.su("UPDATE payment_orders SET created_at = $1 WHERE id = $2", [new Date(Date.now() - 25 * 3_600_000).toISOString(), l9.orderId]);
  assert.equal((await reconcile(l9.orderId)).json.outcome, "expired");
  assert.equal((await order(l9.orderId)).status, "expired");
  assert.equal((await statusPage(l9.orderId, tokenOf(l9.invoiceId))).json.status, "expired");
  sp.pay(l9.invoiceId);
  assert.equal((await sp.sendWebhook(l9.invoiceId)).json.outcome, "applied", "paid after expiry: still fulfilled");
  assert.equal((await api.su("SELECT edition FROM tenants WHERE id = $1", [tenant.id]))[0].edition, "core");

  // ── Refund at SlickPay after fulfilment: flagged, never undone ──────────────────────────────
  sp.unpay(inv1);
  const refunded = await reconcile(newOrderId, "bank says refunded");
  assert.equal(refunded.json.outcome, "mismatch_paid_here_not_at_slickpay");
  assert.equal(refunded.json.order.status, "paid");

  // ── Suspended customer: waits for a person, then applies ────────────────────────────────────
  const l10 = await link(tenant.id, "core", 0);
  await api.su("UPDATE tenants SET is_active = 0 WHERE id = $1", [tenant.id]);
  sp.pay(l10.invoiceId);
  assert.equal((await sp.sendWebhook(l10.invoiceId)).json.outcome, "needs_review");
  assert.equal((await order(l10.orderId)).error_message, "tenant_inactive");
  await api.su("UPDATE tenants SET is_active = 1 WHERE id = $1", [tenant.id]);
  assert.equal((await reconcile(l10.orderId, "customer resumed")).json.outcome, "applied");

  // ── Order recorded before the price list (no price snapshot): a person decides ───────────────
  const legacyInvoice = await http("POST", `${sp.baseUrl}/users/invoices`, { ...req1, amount: 50000, items: [] }, { Authorization: `Bearer ${PUBLIC_KEY}` });
  sp.pay(legacyInvoice.json.id);
  await api.su(
    `INSERT INTO payment_orders (id, tenant_id, license_id, plan, amount, extra_slots, total_amount, status, slickpay_invoice_id)
     VALUES ('pay_legacy', $1, $2, 'standard', 50000, 0, 50000, 'awaiting_payment', $3)`,
    [tenant.id, licence.id, String(legacyInvoice.json.id)],
  );
  const legacy = await reconcile("pay_legacy");
  assert.equal(legacy.json.outcome, "needs_review");
  assert.equal(legacy.json.order.error_message, "legacy_order_without_price_snapshot");

  // ── Console views: history with filters, no contact data ────────────────────────────────────
  const review = (await api.call("GET", "/api/v1/billing/payments?status=needs_review", token)).json;
  assert.deepEqual(review.map((o) => o.id).sort(), [l6.orderId, l7.orderId, "pay_legacy"].sort());
  const all = (await api.call("GET", "/api/v1/billing/payments", token)).json;
  assert.ok(all.every((o) => o.user_info_json === undefined && !JSON.stringify(o).includes(buyer.email)));
  assert.equal(all.find((o) => o.id === newOrderId).buyer_company, buyer.company);
  assert.equal((await api.call("GET", "/api/v1/billing/payments?status=bogus", token)).status, 400);
  // A price not sold on the website (e.g. a small live-test price): console links only.
  assert.equal((await putPrice("development", { base_amount: 200, included_seats: 1, extra_seat_amount: 0, max_extra_seats: 0, term_months: 1, is_active: false })).status, 200);
  const notSold = await publicInitiate({ plan: "development", extra_slots: 0, user_info: buyer, expected_total_amount: 200 });
  assert.equal(notSold.json.error, "plan_not_for_sale", notSold.text);
  assert.ok(!(await http("GET", `${api.baseUrl}/api/v1/payments/slickpay/prices`)).json.prices.some((p) => p.plan === "development"));
  const testLink = await link(tenant.id, "development", 0);
  assert.equal(testLink.total, 200);
  const sub = (await api.call("GET", `/api/v1/billing/tenants/${tenant.id}/subscription`, token)).json;
  assert.equal(sub.prices.length, 3);
  assert.ok(sub.payments.length >= 9);

  // ── Reconciliation worker (a second API instance, short interval, same database) ─────────────
  const l11 = await link(tenant.id, "core", 0);
  sp.pay(l11.invoiceId);
  // Created with this API's 60-minute interval: as if that hour had passed, its first check is due.
  await api.su("UPDATE payment_orders SET next_check_at = $1 WHERE id = $2", [new Date().toISOString(), l11.orderId]);
  workerApi = await startControlApi({
    port: WORKER_PORT,
    extraEnv: { ...slickpayEnv({ SLICKPAY_RECONCILE_INTERVAL_MINUTES: "0.01" }), DATABASE_URL: api.env.DATABASE_URL },
  });
  let workerPaid = false;
  for (let i = 0; i < 60 && !workerPaid; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    workerPaid = (await order(l11.orderId)).status === "paid";
  }
  assert.ok(workerPaid, `the worker fulfilled the order without any webhook:\n${workerApi.output()}`);
  const workerAudit = await api.su("SELECT actor_id FROM audit_records WHERE correlation_id = $1 AND action_code = 'license_renew'", [l11.orderId]);
  assert.deepEqual(workerAudit, [{ actor_id: "system_slickpay_reconciler" }]);

  // ── Website proxy: with the shared token, limits count per customer, not per Vercel address ──
  const viaWebsite = (clientIp, token = PROXY_TOKEN) =>
    http("POST", `${api.baseUrl}/api/v1/payments/slickpay/initiate`, { plan: "no-such-plan", extra_slots: 0, user_info: buyer }, {
      "X-Maintafox-Proxy-Token": token,
      "X-Maintafox-Client-Ip": clientIp,
    });
  for (let i = 0; i < 10; i += 1) assert.equal((await viaWebsite("198.51.100.7")).status, 400);
  assert.equal((await viaWebsite("198.51.100.7")).status, 429, "11th order of one customer in an hour");
  assert.equal((await viaWebsite("198.51.100.8")).status, 400, "another customer behind the same proxy is not blocked");

  // ── Logs: no key, no obsolete secret, no customer e-mail ────────────────────────────────────
  for (const out of [api.output(), workerApi.output()]) {
    assert.ok(!out.includes(PUBLIC_KEY), "public key not logged");
    assert.ok(!out.includes(OBSOLETE_SECRET), "obsolete secret not logged");
    assert.ok(!out.includes(PROXY_TOKEN), "proxy token not logged");
    assert.ok(!out.includes(buyer.email), "customer e-mail not logged");
  }
  assert.ok(api.output().includes("slickpay_obsolete_settings_ignored"));

  console.log("billing (SlickPay): all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  if (workerApi) await workerApi.stop();
  await api.stop();
  await sp.close();
}

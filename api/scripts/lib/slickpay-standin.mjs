/**
 * Local stand-in for SlickPay's invoice API, for integration tests (no sandbox account exists).
 * Built from SlickPay's own documentation, not from our API's expectations:
 *
 * - https://developers.slick-pay.com/authentication: `Authorization: Bearer <public key>` on every call.
 * - https://developers.slick-pay.com/invoices/create: POST /api/v2/users/invoices; `amount` numeric
 *   (DZD); a contact uuid or firstname/lastname/phone/email/address; `url`, `items`, `webhook_url`,
 *   `webhook_signature`, `webhook_meta_data`; answer {success: 1, message, id, url}.
 * - https://developers.slick-pay.com/invoices/details: GET /api/v2/users/invoices/:id answers
 *   {success: 1, completed: 0|1, data: {...}}; the WordPress plugin (github.com/Slick-Pay-Algeria/
 *   slickpay-wp) reads data.completed, data.status, data.serial, data.url, data.transaction.amount.
 *   The Quick Integration page instead reads data.payment_status ('paid' | 'unpaid'): mode
 *   "quick_integration" answers that shape.
 * - https://developers.slick-pay.com/invoices/calculate: commission example 1000 -> 40; the WHMCS
 *   module computes the fee as (webhook amount - invoice amount), so a card payment includes it.
 * - Webhook (github.com/Slick-Pay-Algeria/whmcs, modules/gateways/callback/slickpay.php): a form POST
 *   with `id`, `success`, `amount` and `meta_data[...]` (the invoice's webhook_meta_data).
 *
 * Not documented, so marked as assumptions: the 401 body ("Unauthenticated.", Laravel/Sanctum, as the
 * "54|..." key format suggests), the 422 body ({message, errors: {field: [..]}}, Laravel), the 404 body.
 */
import { createServer } from "node:http";
import { once } from "node:events";

export async function startSlickPayStandIn({ publicKey, commissionRate = 0.04 }) {
  const invoices = new Map(); // id -> invoice
  const requests = []; // every request received: { method, path, auth, body }
  let nextId = 1;
  let shape = "details_docs";
  let getDelayMs = 0;

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const auth = req.headers.authorization ?? null;
    requests.push({ method: req.method, path: req.url, auth, body });
    const send = (status, json) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(json));
    };
    if (auth !== `Bearer ${publicKey}`) {
      send(401, { message: "Unauthenticated." });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v2/users/invoices") {
      const errors = {};
      if (typeof body?.amount !== "number" || !(body.amount > 0)) errors.amount = ["The amount field is required."];
      if (!body?.contact) {
        for (const field of ["firstname", "lastname", "phone", "email", "address"]) {
          if (typeof body?.[field] !== "string" || !body[field].trim()) errors[field] = [`The ${field} field is required.`];
        }
      }
      if (Object.keys(errors).length > 0) {
        send(422, { message: "The given data was invalid.", errors });
        return;
      }
      const id = nextId++;
      const serial = `PAY-${String(id).padStart(12, "0")}`;
      const address = `http://127.0.0.1:${server.address().port}`;
      invoices.set(String(id), {
        id,
        serial,
        request: body,
        amount: body.amount,
        reportedAmount: body.amount,
        completed: 0,
        status: "pending",
        transaction: null,
        url: `${address}/api/v2/users/invoices/satim/payment/${serial}`,
      });
      send(200, { success: 1, message: "Invoice created successfully.", id, url: invoices.get(String(id)).url });
      return;
    }

    const m = /^\/api\/v2\/users\/invoices\/(\d+)$/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      if (getDelayMs > 0) await new Promise((r) => setTimeout(r, getDelayMs));
      const inv = invoices.get(m[1]);
      if (!inv) {
        send(404, { success: 0, message: "Invoice not found." });
        return;
      }
      const data = {
        id: inv.id,
        amount: inv.reportedAmount,
        status: inv.status,
        serial: inv.serial,
        url: inv.url,
        transaction: inv.transaction,
      };
      if (shape === "quick_integration") {
        send(200, { success: 1, data: { ...data, payment_status: inv.completed ? "paid" : "unpaid" } });
      } else if (shape === "conflicting") {
        send(200, { success: 1, completed: inv.completed, data: { ...data, payment_status: inv.completed ? "unpaid" : "paid" } });
      } else {
        send(200, { success: 1, completed: inv.completed, data: { ...data, completed: inv.completed } });
      }
      return;
    }
    send(404, { success: 0, message: "Not found." });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v2`;

  function invoice(id) {
    const inv = invoices.get(String(id));
    if (!inv) throw new Error(`stand-in: no invoice ${id}`);
    return inv;
  }

  return {
    baseUrl,
    requests,
    invoice,
    /** The customer pays on the SATIM page: completed, with SlickPay's commission on the card. */
    pay(id) {
      const inv = invoice(id);
      inv.completed = 1;
      inv.status = "paid";
      inv.transaction = { amount: Math.round(inv.amount * (1 + commissionRate) * 100) / 100, serial: `SATIM-${inv.serial}`, log: "{}" };
    },
    /** A refund or reversal made in SlickPay's dashboard. */
    unpay(id) {
      const inv = invoice(id);
      inv.completed = 0;
      inv.status = "refunded";
    },
    /** SlickPay reports another invoice amount than the one created (tampering / platform error). */
    reportAmount(id, amount) {
      invoice(id).reportedAmount = amount;
    },
    /** Which documented status shape GET answers with: details_docs | quick_integration | conflicting. */
    setShape(next) {
      shape = next;
    },
    /** Delays every GET (to exceed the API's SLICKPAY_HTTP_TIMEOUT_MS). */
    setGetDelay(ms) {
      getDelayMs = ms;
    },
    statusReads(id) {
      return requests.filter((r) => r.method === "GET" && r.path === `/api/v2/users/invoices/${id}`).length;
    },
    /** SlickPay's webhook call as its WHMCS module receives it: form-encoded id, success, amount, meta_data[...]. */
    async sendWebhook(id, { format = "form", overrides = {}, headers = {} } = {}) {
      const inv = invoice(id);
      const fields = {
        id: String(inv.id),
        success: inv.completed ? "1" : "0",
        amount: String(inv.transaction?.amount ?? inv.amount),
        meta_data: inv.request.webhook_meta_data ?? {},
        ...overrides,
      };
      let body;
      let contentType;
      if (format === "json") {
        body = JSON.stringify(fields);
        contentType = "application/json";
      } else {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) {
          if (v && typeof v === "object") for (const [mk, mv] of Object.entries(v)) params.append(`${k}[${mk}]`, String(mv));
          else params.append(k, String(v));
        }
        body = params.toString();
        contentType = "application/x-www-form-urlencoded";
      }
      const res = await fetch(inv.request.webhook_url, { method: "POST", headers: { "Content-Type": contentType, ...headers }, body });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, json, text };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

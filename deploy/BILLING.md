# Billing and SlickPay online payments

Code: `api/src/billing/slickpay.ts` (SlickPay client, status interpretation, webhook parsing),
`api/src/routes/billing.ts` (checkout, webhook, customer status page, reconciliation worker, console
billing), `api/src/routes/licences.ts` (manual licence edits, audited); console
`src/vendor-console/components/BillingPanel.tsx` (page **Billing**, and each customer's page).
Migrations `014_billing_reconciliation.sql`, `016_slickpay_hardening.sql`. Test:
`api/scripts/billing.integration.mjs` with `api/scripts/lib/slickpay-standin.mjs` (a local SlickPay
built from SlickPay's documentation; no real money moves). Website side (repo maintafox-website-V1):
`app/(site)/checkout`, `app/(site)/checkout/result`, `app/api/payments/slickpay/*`.

## How a payment works

1. The website shows the plans and prices it reads from this server (`GET /api/v1/payments/slickpay/prices`).
2. The customer confirms. The website sends plan, extra seats, contact, and the total they saw.
   This server prices the order **from its own price list** (the total sent is only compared:
   `409 price_changed` if it differs), records the order, and creates the SlickPay invoice with:
   the amount in DZD, our return page (`SLICKPAY_RETURN_URL?order=…&token=…`), our webhook URL, and a
   random per-order token in `webhook_meta_data` / `webhook_signature`.
3. The customer pays on SlickPay's SATIM page and comes back to `/checkout/result`, which asks this
   server for the order's status. While the order is unpaid, the server asks SlickPay itself.
4. Whatever tells us first (webhook, status page, the automatic re-check, or an operator's
   "Check with SlickPay"), **the payment is applied only after this server reads the invoice back
   from SlickPay** with the invoice id it stored, and only once: one invoice belongs to one order
   (unique index), and fulfilment runs under a row lock.
5. Fulfilment: a new customer is created (no customer is created before payment), the customer's
   edition is set to the plan paid for, the licence is issued or renewed for the plan's term (from
   the later of today and the current end date), seats = seats included + extra seats paid for
   (never fewer than the machines active now), the order is marked paid with SlickPay's amount and
   transaction reference, and everything is audited. The buyer receives the licence by e-mail when
   e-mail is enabled (`EMAIL_DELIVERY_MODE=smtp`); otherwise the Billing page marks the order
   "licence e-mail not sent" and someone must send the key.
6. Unpaid orders are re-checked automatically (first after `SLICKPAY_RECONCILE_INTERVAL_MINUTES`,
   then doubling), and marked **expired** after `SLICKPAY_ORDER_EXPIRY_HOURS`. A payment that arrives
   later is still applied.
7. A payment SlickPay reports as paid but that cannot be applied automatically becomes **needs
   review** (never "failed"): amount different from the order, customer suspended, licence revoked,
   order from before the price list, unrecognisable SlickPay answer. The Billing page lists them
   with the reason. Nothing is lost; after fixing the cause, "Check with SlickPay" applies it.

## What SlickPay documents, and what it does not

Sources (read 2026-10-13):

- https://developers.slick-pay.com/authentication — every call: `Authorization: Bearer <PUBLIC_KEY>`.
- https://developers.slick-pay.com/quick-integration — create invoice, redirect to `url`, check status.
- https://developers.slick-pay.com/invoices/create — `POST /api/v2/users/invoices` fields and answer
  `{success, message, id, url}`; live `https://prodapi.slick-pay.com/api/v2`, sandbox
  `https://devapi.slick-pay.com/api/v2`.
- https://developers.slick-pay.com/invoices/details — `GET /api/v2/users/invoices/:id`
  `{success, completed: 0|1, data}`.
- https://developers.slick-pay.com/invoices/calculate — commission example (1000 → 40).
- https://developers.slick-pay.com/web-payment — "implement server-side verification … to check the
  SlickPay invoice status before updating the order status".
- Official SDKs, https://github.com/Slick-Pay-Algeria: `slickpay-npm` (base URLs, Bearer public key),
  `slickpay-wp` (reads `data.completed == 1`, `data.serial`, `data.transaction.amount`), `whmcs`
  (webhook received as a form POST with `id`, `success`, `amount`, `meta_data[…]`).

Not documented, and how this server handles it (safest choice):

| Unknown | Handling |
| --- | --- |
| The **secret key**: no documented call uses it | Not used, not stored. Only the public key is configured. |
| The exact paid signal: docs show `completed` (0/1), the Quick Integration page `data.payment_status` (`paid`/`unpaid`) | Both read; paid only if at least one says paid and none says unpaid; anything else is "unknown" and never applied. |
| The webhook body and how `webhook_signature` comes back | The webhook is only a hint (JSON or form). Our per-order token is checked when present (wrong token → 401); the status is always re-read from SlickPay. |
| Webhook retries | Unknown: the automatic re-check and the customer's status page confirm payments without any webhook. |
| Whether the card amount includes SlickPay's commission | The invoice amount must equal the order; a card amount lower than the order is "needs review". Check what the customer is charged in the live test. |
| Refund API | None documented: refunds are made in SlickPay's dashboard or with their support (below). |
| Rate limits, error codes | Not documented. Calls time out after `SLICKPAY_HTTP_TIMEOUT_MS`; errors are logged by code, retried by the worker. |
| Minimum invoice amount | Not documented for invoices (transfers: "above 100"). Use at least 200 DZD for the live test. |

## Owner set-up

### Server `.env` (VPS, next to docker-compose.yml) — names only, values from you

| Setting | Value to put |
| --- | --- |
| `SLICKPAY_MODE` | `enabled` (or `disabled` to switch online payment off) |
| `SLICKPAY_PUBLIC_KEY` | the **public** key from your SlickPay dashboard |
| `SLICKPAY_API_BASE_URL` | `https://prodapi.slick-pay.com/api/v2` |
| `SLICKPAY_WEBHOOK_URL` | `https://api.maintafox.systems/api/v1/webhooks/slickpay` |
| `SLICKPAY_RETURN_URL` | `https://www.maintafox.systems/checkout/result` |
| `SLICKPAY_HTTP_TIMEOUT_MS` | `15000` |
| `SLICKPAY_RECONCILE_INTERVAL_MINUTES` | `5` |
| `SLICKPAY_ORDER_EXPIRY_HOURS` | `72` |
| `WEBSITE_PROXY_TOKEN` | a new random secret, at least 32 characters (`openssl rand -hex 32`); the **same** value goes into Vercel as `CONTROL_PLANE_PROXY_TOKEN` |
| `EMAIL_DELIVERY_MODE` + `SMTP_*`, `EMAIL_FROM` | `smtp` and your mail provider, so buyers receive their licence key automatically (deploy/NOTIFICATION_EMAIL.md) |

**Delete** from the `.env`: `SLICKPAY_SECRET_KEY`, `SLICKPAY_WEBHOOK_SECRET`,
`SLICKPAY_DEFAULT_RETURN_URL`, `SLICKPAY_EXTRA_SLOT_PRICE` (no longer read). The SlickPay **secret
key must not be on the server** at all: nothing uses it. Keep it only in your password manager.

The API refuses to start if `SLICKPAY_MODE` is missing, or if it is `enabled` and any setting above
(except `WEBSITE_PROXY_TOKEN`) is missing or invalid; the log line says which one.

### Vercel (website project, Production environment)

| Setting | Value |
| --- | --- |
| `CONTROL_PLANE_API_URL` | unchanged: `https://api.maintafox.systems/api/v1` |
| `CONTROL_PLANE_PROXY_TOKEN` | the same secret as `WEBSITE_PROXY_TOKEN` on the server |

No SlickPay key on Vercel: only the server talks to SlickPay. Redeploy the website after changing
variables.

### SlickPay dashboard

- Your bank account is added and is the default one (invoices are paid into the default account).
- Nothing else is required: the return URL and the webhook URL are sent with every invoice. If the
  dashboard has a webhook or callback URL field, set it to
  `https://api.maintafox.systems/api/v1/webhooks/slickpay`, and a return URL field to
  `https://www.maintafox.systems/checkout/result`.

### Price list (console → Billing → Price list)

Nothing can be bought online until you set prices (the owner role only). The website currently shows
these figures; enter them unless you decide otherwise, and keep the website's pricing page in line:

| Plan (edition) | Base price (DZD) | Seats included | Extra seat (DZD) | Max extra seats | Term (months) | On the website |
| --- | --- | --- | --- | --- | --- | --- |
| `core` | 120000 | 1 | 20000 | 500 | 12 | yes |
| `professional` | 240000 | 3 | 30000 | 500 | 12 | yes |

## Deploy checklist

1. Migration `016_slickpay_hardening.sql` (runs at API start): price list table; `payment_orders`
   may have no customer until paid; new columns; status values checked; **one order per SlickPay
   invoice** (unique index). Before deploying, check no invoice id is used twice (the index would
   fail): `SELECT slickpay_invoice_id, count(*) FROM payment_orders WHERE slickpay_invoice_id IS NOT
   NULL GROUP BY 1 HAVING count(*) > 1;` must return nothing.
2. Update the server `.env` (above), then rebuild and restart the API and console images.
3. Set the price list in the console.
4. Set the Vercel variable, merge and deploy the website.
5. Orders created before this version and still unpaid have no price snapshot: if SlickPay reports
   one paid, it appears under "needs review" (extend by hand).

**Rollback.** Stop the new images, `DELETE FROM schema_migrations WHERE version = 16;`, start the
previous images (they ignore the new columns; orders without a customer would break them, so first
check `SELECT count(*) FROM payment_orders WHERE tenant_id IS NULL;` is 0, or delete those unpaid
rows). To re-deploy later: `DROP TABLE billing_price_list;` and drop the new columns, constraints and
indexes first (see the migration).

## Live verification with one small real payment

There is no sandbox account, so this is the only end-to-end proof. It costs about 200 DZD plus
SlickPay's commission. Do it right after deploying, at a quiet time.

1. **Test price, not sold on the website.** Console → Billing → Price list → *Add a plan price*:
   plan `development`, base price `200`, seats included `1`, extra seat `0`, max extra seats `0`,
   term `1`, **Sold on the website unticked**, reason "live SlickPay test".
   *Check:* the website's checkout does not offer it (it only shows `core` and `professional`).
2. **Test customer.** Console → Customers → create "SlickPay test" (any slug). Console → Billing →
   choose it → *Create a payment link*: plan `development`, extra seats 0, your own name, e-mail
   and phone. *Check:* the total shows 200 DZD; a link appears; the order shows "Awaiting payment".
3. **Pay** the link with your own CIB / Edahabia card. Note exactly what your card is charged
   (200 or 200 + commission). You are sent back to `www.maintafox.systems/checkout/result`.
   *Check:* the page shows "Payment confirmed" within a few seconds (if it says "being confirmed",
   wait: the automatic re-check runs every few minutes).
4. **Check the console** (Billing, the test customer): order **Paid**; "card: … DZD" equals what
   your bank shows; a SlickPay serial is shown; a licence exists, valid one month, 1 seat; customer
   edition `development`. Settings → Audit: `license_issue` (actor `system_slickpay_webhook`,
   `…status_page` or `…reconciler`) — this also tells you whether SlickPay's webhook arrived.
5. **Check the server logs** (`docker compose logs api | grep slickpay_`): one
   `slickpay_invoice_created`, then `slickpay_status_read` with the signals SlickPay really sent
   (e.g. `completed=1`), then `slickpay_order_fulfilled`. If there is a `slickpay_webhook_handled`
   line, note its `token` value (`valid` / `absent`) and send it to the developer: it shows how
   SlickPay returns the signature. A `slickpay_status_unrecognised` line means SlickPay's answer
   has another shape: send the line (it holds no key and no customer data).
6. **Duplicate safety:** click "Check with SlickPay" on the paid order: answer "Already applied"
   or "nothing to change"; the licence end date does not move.
7. **Abandoned payment:** create a second link, open it, and cancel on the SATIM page (or close it).
   *Check:* the result page / the order stays "Awaiting payment"; after `SLICKPAY_ORDER_EXPIRY_HOURS`
   it becomes "Expired". Nothing is granted.
8. **Clean up:** leave the `development` price with "Sold on the website" unticked (only console
   links can use it); revoke the test licence and suspend or delete the test customer.
9. **Refund the test** if you want your 200 DZD back (below).

What the stand-in tests already prove without money: pricing, tampering refusal, exactly-once
fulfilment (duplicate and concurrent webhooks), forged webhooks, amount mismatch, timeouts and
retries, expiry, refunds flagged, the worker, logs without secrets. What only the live test proves:
SlickPay's real answer shape, whether the webhook arrives and how it is signed, whether the
commission is added to the customer's charge, and that money reaches your bank account.

## Refunds

SlickPay documents no refund API. To refund: SlickPay dashboard (or SlickPay support) for that
invoice / SATIM serial (both shown on the order). Then in the console: "Check with SlickPay" on the
order — it shows "recorded as paid here, but SlickPay now says …" and **changes nothing**. Undo the
licence yourself on the Entitlements page (shorten the end date, reduce seats, or revoke), with the
reason "refund of order pay_…". The audit log keeps both.

## Operating

- **Needs a person** (top of the Billing page): each order says why. Typical fixes: resume the
  customer then "Check with SlickPay"; or extend the licence by hand and keep the order as the record.
- **Licence e-mail not sent / failed**: send the licence key (Entitlements page) to the buyer.
- **Awaiting payment** orders need nothing: they are re-checked automatically; "Check with SlickPay"
  forces a check when a customer says they paid.
- A customer who paid twice (two orders): both are applied (two terms). Refund one if needed.

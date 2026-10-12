# Billing and subscription (Phase 4.4)

Code: `api/src/routes/billing.ts` (SlickPay checkout, webhook, subscription, payment history,
reconciliation), `api/src/routes/licences.ts` (licence edits, now audited); console
`src/vendor-console/components/BillingPanel.tsx` (page **Billing**, permission `customer.manage`).
Migration `014_billing_reconciliation.sql`. Test: `api/scripts/billing.integration.mjs` (in
`test:all`; it runs a local HTTP stand-in for SlickPay, so no real money moves).

What the page shows, per customer:

- each licence: end date, days left (highlighted under 30 days), slots used / slots bought, channel;
- every payment order **exactly as recorded** (pending, awaiting payment, paid, failed), the SlickPay
  invoice, when SlickPay was last asked and what it answered.

Actions:

- **Check with SlickPay** (reason required, audited `payment_reconciled`): the server asks SlickPay
  for the invoice's real status. If SlickPay says *paid* and the payment was not applied (the
  webhook got lost), it is applied now, by the same code as the webhook (licence +1 year from its
  current end, extra slots added, audit `license_renew` with the operator as actor). If the order is
  recorded as paid here but SlickPay no longer says paid (refund), nothing is undone: it is shown as a
  mismatch for a person to handle. **No button marks a payment as paid.**
- **Create a payment link**: a SlickPay invoice for this customer (renewal, extra slots); send the
  link to the customer; paying it renews automatically.
- **Extend or add slots by hand** (bank transfer, goodwill): licence edit on the Entitlements page,
  now written to the audit log (`license_update`, before / after, reason).

## Found while building this (decisions for the owner)

1. **The price is not checked.** The public checkout takes the amount from the caller (website or
   console), and a paid invoice renews the licence for a year whatever the amount was. A customer
   could change the amount in the browser and pay less. Fix needs a decision: a price list per plan
   on the server (amount computed there, not sent), and the webhook comparing SlickPay's paid amount
   with it. Not changed here (it changes the public website's contract).
2. **SlickPay settings have hidden defaults** (`SLICKPAY_API_BASE_URL`, `SLICKPAY_WEBHOOK_URL`,
   `SLICKPAY_DEFAULT_RETURN_URL`, webhook secret falling back to the secret key, extra slot price 0).
   Not changed here; listed for a later clean-up with the price list.

## Deploy checklist

1. **Migration** `014_billing_reconciliation.sql`: `payment_orders.last_reconciled_at`,
   `last_reconciled_status`.
2. **Environment:** nothing new. SlickPay works only when `SLICKPAY_PUBLIC_KEY` and
   `SLICKPAY_SECRET_KEY` are set (the page says so otherwise); extra-slot pricing needs
   `SLICKPAY_EXTRA_SLOT_PRICE`.
3. Rebuild and restart the API and console images.
4. Check: Billing page lists a customer's licence and payments; on a real unpaid invoice, "Check
   with SlickPay" answers with SlickPay's status and changes nothing.

**Rollback.** `DELETE FROM schema_migrations WHERE version = 14` (and the later ones being rolled
back) before starting the previous images; the two columns are ignored by the previous API.
Re-deploying later: `ALTER TABLE payment_orders DROP COLUMN last_reconciled_at, DROP COLUMN
last_reconciled_status;` first.

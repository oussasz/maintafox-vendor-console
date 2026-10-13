-- SlickPay hardening (deploy/BILLING.md): the server owns the price, a paid order is fulfilled
-- exactly once, unpaid orders are re-checked with SlickPay until they expire.

-- Price list, one row per plan (= edition id). No row is seeded: online payment of a plan is refused
-- until the owner sets its price on the console's Billing page.
CREATE TABLE billing_price_list (
  plan TEXT PRIMARY KEY,
  base_amount NUMERIC(12, 2) NOT NULL CHECK (base_amount > 0),
  included_seats INTEGER NOT NULL CHECK (included_seats >= 1),
  extra_seat_amount NUMERIC(12, 2) NOT NULL CHECK (extra_seat_amount >= 0),
  max_extra_seats INTEGER NOT NULL CHECK (max_extra_seats >= 0),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 36),
  currency TEXT NOT NULL CHECK (currency = 'DZD'),
  is_active BOOLEAN NOT NULL,
  updated_at TEXT NOT NULL DEFAULT mfx_utc_now_text(),
  updated_by TEXT NOT NULL
);
ALTER TABLE billing_price_list ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON billing_price_list USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator());

-- A new customer's order has no tenant until it is paid (the tenant is created on fulfilment).
ALTER TABLE payment_orders ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE payment_orders
  -- Price snapshot at checkout: fulfilment applies what was paid for, whatever the list says later.
  ADD COLUMN included_seats INTEGER NULL,
  ADD COLUMN extra_seat_amount DOUBLE PRECISION NULL,
  ADD COLUMN term_months INTEGER NULL,
  -- sha256 of the token in the customer's return URL (order status page).
  ADD COLUMN status_token_sha256 TEXT NULL,
  -- sha256 of the per-order token sent to SlickPay in webhook_meta_data / webhook_signature.
  ADD COLUMN webhook_token_sha256 TEXT NULL,
  -- What SlickPay reported when the order was fulfilled.
  ADD COLUMN slickpay_paid_amount DOUBLE PRECISION NULL,
  ADD COLUMN slickpay_transaction_ref TEXT NULL,
  -- Automatic re-checks of an unpaid order (reconciliation worker).
  ADD COLUMN next_check_at TEXT NULL,
  ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_check_error TEXT NULL,
  -- Licence e-mail to the buyer after fulfilment: pending | sent | failed | disabled.
  ADD COLUMN licence_delivery TEXT NULL;

ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_status_check
  CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'failed', 'expired', 'needs_review'));
ALTER TABLE payment_orders
  ADD CONSTRAINT payment_orders_licence_delivery_check
  CHECK (licence_delivery IS NULL OR licence_delivery IN ('pending', 'sent', 'failed', 'disabled'));

-- One SlickPay invoice belongs to exactly one order: the fulfilment key.
DROP INDEX idx_payment_orders_invoice;
CREATE UNIQUE INDEX payment_orders_invoice_unique ON payment_orders (slickpay_invoice_id) WHERE slickpay_invoice_id IS NOT NULL;
CREATE INDEX payment_orders_due_check ON payment_orders (next_check_at) WHERE status = 'awaiting_payment';

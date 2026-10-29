-- Billing reconciliation (master plan Phase 4.4): the last time an operator asked SlickPay for an
-- order's real status, and what SlickPay answered. The order's own status changes only when SlickPay
-- says the invoice is paid (routes/billing.ts applyPaidOrder), never from the console.
ALTER TABLE payment_orders
  ADD COLUMN last_reconciled_at TEXT NULL,
  ADD COLUMN last_reconciled_status TEXT NULL;

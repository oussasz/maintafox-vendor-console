-- Email channel of desktop notifications (POST /api/v1/notifications/email, deploy/NOTIFICATION_EMAIL.md).
-- One row per (tenant, request_id): makes the endpoint idempotent across the devices that hold the
-- same notification. Neither the address nor the message is stored, only a hash of the request.
CREATE TABLE notification_email_requests (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  notification_sync_id TEXT NOT NULL,
  recipient_user_sync_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  attempts INTEGER NOT NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id, request_id)
);
ALTER TABLE notification_email_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_email_requests
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

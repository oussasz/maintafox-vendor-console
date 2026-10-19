-- Administrator recovery codes (decision register 2026-10-19, "No active administrator left on a
-- PC", part a). One row per code issued from the console: which PC activation it is bound to, who
-- issued it, why, and until when it is valid. The code string and its signature are NEVER stored
-- (shown once to the operator); the desktop enforces single use by code_id.
-- New table only: no existing table changes. No foreign keys (like sync_device_resync_request):
-- the history stays readable after a rebind moves the activation to another fingerprint.
CREATE TABLE admin_recovery_codes (
  code_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  -- Operator actor id (resolveActorId) and the X-Operator-Reason they gave.
  issued_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- RFC 3339 UTC strings exactly as signed into the code (toISOString()).
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Signing key of the code (entitlement key id) and the ledger record of the issuance.
  key_id TEXT NOT NULL,
  audit_record_id TEXT NOT NULL
);
CREATE INDEX admin_recovery_codes_device
  ON admin_recovery_codes (tenant_id, machine_fingerprint, issued_at DESC);

-- Tenant data: same isolation as the other tenant tables (007).
ALTER TABLE admin_recovery_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admin_recovery_codes
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

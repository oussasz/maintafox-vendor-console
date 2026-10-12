-- Support becomes real data (master plan Phase 3.4): tickets opened by operators or by devices,
-- diagnostic bundles uploaded by devices to object storage, editable runbooks. The bootstrap seed
-- fixtures are removed.

-- Tickets
-- An operator-opened ticket has no app version or sync hint until a device reports one.
ALTER TABLE support_tickets ALTER COLUMN sync_status_hint DROP NOT NULL;
ALTER TABLE support_tickets ALTER COLUMN app_version_reported DROP NOT NULL;
ALTER TABLE support_tickets ADD COLUMN summary TEXT NULL;
ALTER TABLE support_tickets ADD COLUMN origin TEXT NULL CHECK (origin IN ('operator', 'device'));
-- 'user_<id>' (operator) or 'device:<machine fingerprint>'.
ALTER TABLE support_tickets ADD COLUMN created_by TEXT NULL;
CREATE INDEX support_tickets_tenant_created_idx ON support_tickets (tenant_id, created_at_rfc3339 DESC);

-- Diagnostic bundles
ALTER TABLE diagnostic_bundles ADD COLUMN tenant_id TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN machine_fingerprint TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN app_version TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN status TEXT NULL CHECK (status IN ('pending_upload', 'uploaded', 'rejected'));
ALTER TABLE diagnostic_bundles ADD COLUMN object_key TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN byte_size BIGINT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN content_sha256 TEXT NULL;
-- Ticket the device asked to open with the bundle (opened when the upload is verified).
ALTER TABLE diagnostic_bundles ADD COLUMN requested_ticket_json TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN ticket_id TEXT NULL REFERENCES support_tickets (ticket_id);
ALTER TABLE diagnostic_bundles ADD COLUMN uploaded_at_rfc3339 TEXT NULL;
ALTER TABLE diagnostic_bundles ADD COLUMN rejection_reason TEXT NULL;
CREATE INDEX diagnostic_bundles_tenant_created_idx ON diagnostic_bundles (tenant_id, created_at_rfc3339 DESC);

-- Devices write their own bundles (tenant scope); bundles without a tenant stay operator-only.
DROP POLICY operator_only ON diagnostic_bundles;
CREATE POLICY tenant_isolation ON diagnostic_bundles
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
DROP POLICY operator_only ON diagnostic_bundle_artifacts;
CREATE POLICY tenant_isolation ON diagnostic_bundle_artifacts
  USING (mfx_scope_operator() OR EXISTS (
    SELECT 1 FROM diagnostic_bundles b WHERE b.bundle_id = diagnostic_bundle_artifacts.bundle_id))
  WITH CHECK (mfx_scope_operator() OR EXISTS (
    SELECT 1 FROM diagnostic_bundles b WHERE b.bundle_id = diagnostic_bundle_artifacts.bundle_id));

-- Seed fixtures (SEED_BEHAVIOR=full) are not real data: remove them. Only these exact ids.
-- The seed's audit record stays: the audit ledger is an append-only hash chain.
DELETE FROM offline_ticket_reconciliation WHERE desktop_queue_id IN ('dq_seed_01', 'dq_seed_02');
DELETE FROM diagnostic_bundle_artifacts WHERE bundle_id = 'bundle_seed_001';
DELETE FROM diagnostic_bundles WHERE bundle_id = 'bundle_seed_001';
DELETE FROM support_tickets
WHERE ticket_id = 'sup_seed_001'
  AND NOT EXISTS (SELECT 1 FROM support_ticket_interventions i WHERE i.ticket_id = 'sup_seed_001');

-- Runbooks: real procedures, editable by operators
ALTER TABLE incident_runbooks ADD COLUMN updated_at_rfc3339 TEXT NULL;
ALTER TABLE incident_runbooks ADD COLUMN updated_by TEXT NULL;
-- The standard runbook content is ensured at API startup (api/src/app/runbooks.ts), like the
-- edition catalog, so the one-shot SQLite import still finds an empty target table.

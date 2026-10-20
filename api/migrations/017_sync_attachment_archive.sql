-- Sync deletes and overwrites of attachments that can be undone, and who changed the safety settings (CMMS Advisor decision
-- 2026-10-20). The sync server knows the sending DEVICE (activation: licence + machine fingerprint),
-- never the user, so it cannot prove who deleted something; it can keep what was deleted and which
-- device sent the change. New tables only: no existing table changes.

-- 1. Archive of photos / attachments deleted OR REPLACED by sync (the only history sync may
--    delete; the type list lives in api/src/sync/attachment-archive.ts). Written in the exchange
--    transaction that accepted the change, before the current state is overwritten: for every
--    accepted delete/archive, and for every accepted upsert/update that replaces a live row with
--    a different payload (a junk object_key or relative_path destroys the attachment as surely as
--    a delete). A vendor operator can restore the prior row (reason + step-up
--    sync_attachment_restore, audited): the server re-issues it to every device as a new
--    server-originated change (deploy/SYNC_OPERATIONS.md).
--    Privacy: prior payloads are kept with no time limit, until the tenant is deleted.
CREATE TABLE sync_deleted_attachment_archive (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  -- 'delete' (delete or archive operation) or 'overwrite' (a live row replaced by another payload).
  change_kind TEXT NOT NULL CHECK (change_kind IN ('delete', 'overwrite')),
  -- What the server held just before the change: 'present' (a live row, archived below),
  -- 'already_deleted' (the state was already a delete marker), 'unknown' (no state on the server).
  prior_state TEXT NOT NULL CHECK (prior_state IN ('present', 'already_deleted', 'unknown')),
  prior_operation TEXT NULL,
  prior_row_version BIGINT NULL,
  -- The payload exactly as stored in sync_entity_state.payload_raw (sealed for sensitive types).
  prior_payload_raw TEXT NULL,
  prior_payload_hash TEXT NULL,
  prior_owner_user_sync_id TEXT NULL,
  prior_origin_machine_fingerprint TEXT NULL,
  prior_last_ingress_id BIGINT NULL,
  -- Where the file is: locator fields of the payload (object_key, content_sha256, byte_size,
  -- relative_path) and the media manifest row of the entity, if any. Never file content.
  object_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (prior_state <> 'present' OR (prior_payload_raw IS NOT NULL AND prior_row_version IS NOT NULL
         AND prior_payload_hash IS NOT NULL AND prior_last_ingress_id IS NOT NULL)),
  CHECK (change_kind = 'delete' OR prior_state = 'present'),
  -- The accepted change and the device that sent it.
  change_operation TEXT NOT NULL,
  change_row_version BIGINT NOT NULL,
  change_ingress_id BIGINT NOT NULL,
  change_payload_hash TEXT NOT NULL,
  changed_by_license_id TEXT NOT NULL,
  changed_by_machine_fingerprint TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v1', 'v2')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Restore (all set together, once).
  restored_at TIMESTAMPTZ NULL,
  restored_by TEXT NULL,
  restore_reason TEXT NULL,
  restore_audit_record_id TEXT NULL,
  restore_ingress_id BIGINT NULL,
  restore_row_version BIGINT NULL,
  CHECK (
    (restored_at IS NULL AND restored_by IS NULL AND restore_reason IS NULL AND restore_audit_record_id IS NULL
      AND restore_ingress_id IS NULL AND restore_row_version IS NULL)
    OR
    (restored_at IS NOT NULL AND restored_by IS NOT NULL AND restore_reason IS NOT NULL
      AND restore_audit_record_id IS NOT NULL AND restore_ingress_id IS NOT NULL AND restore_row_version IS NOT NULL)
  )
);
CREATE UNIQUE INDEX sync_deleted_attachment_archive_change
  ON sync_deleted_attachment_archive (tenant_id, change_ingress_id);
CREATE INDEX sync_deleted_attachment_archive_tenant
  ON sync_deleted_attachment_archive (tenant_id, changed_at DESC, id DESC);
CREATE INDEX sync_deleted_attachment_archive_entity
  ON sync_deleted_attachment_archive (tenant_id, entity_type, entity_sync_id);

-- The archived state is evidence: an UPDATE may only record the restore, once.
CREATE FUNCTION mfx_sync_attachment_archive_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'sync_deleted_attachment_archive % is already restored', OLD.id;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.entity_type, NEW.entity_sync_id, NEW.change_kind, NEW.prior_state, NEW.prior_operation,
      NEW.prior_row_version, NEW.prior_payload_raw, NEW.prior_payload_hash, NEW.prior_owner_user_sync_id,
      NEW.prior_origin_machine_fingerprint, NEW.prior_last_ingress_id, NEW.object_refs, NEW.change_operation,
      NEW.change_row_version, NEW.change_ingress_id, NEW.change_payload_hash, NEW.changed_by_license_id,
      NEW.changed_by_machine_fingerprint, NEW.protocol_version, NEW.changed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.entity_type, OLD.entity_sync_id, OLD.change_kind, OLD.prior_state, OLD.prior_operation,
      OLD.prior_row_version, OLD.prior_payload_raw, OLD.prior_payload_hash, OLD.prior_owner_user_sync_id,
      OLD.prior_origin_machine_fingerprint, OLD.prior_last_ingress_id, OLD.object_refs, OLD.change_operation,
      OLD.change_row_version, OLD.change_ingress_id, OLD.change_payload_hash, OLD.changed_by_license_id,
      OLD.changed_by_machine_fingerprint, OLD.protocol_version, OLD.changed_at) THEN
    RAISE EXCEPTION 'sync_deleted_attachment_archive: only the restore columns may change';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sync_deleted_attachment_archive_guard
  BEFORE UPDATE ON sync_deleted_attachment_archive
  FOR EACH ROW EXECUTE FUNCTION mfx_sync_attachment_archive_guard();

-- 2. Forensic device log: one row per accepted change of the three-person lock-removal setting
--    and the other safety settings (site_settings, site_setting_events, permit_types), with the
--    device that sent it. The ingress log also records the device, but retention compacts it
--    (SYNC_INGRESS_RETENTION_DAYS) and it has no licence id; this log is never compacted (retention
--    does not touch it) and holds no payload, only its hash. Append-only: rows are never updated;
--    they are deleted only with their tenant (tenant delete).
CREATE TABLE sync_forensic_change_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  base_row_version BIGINT NULL,
  -- server_seq of the change (sync_mirror_ingress.id; that log row may be compacted later).
  server_seq BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  license_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v1', 'v2')),
  received_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX sync_forensic_change_log_seq ON sync_forensic_change_log (tenant_id, server_seq);
CREATE INDEX sync_forensic_change_log_entity
  ON sync_forensic_change_log (tenant_id, entity_type, entity_sync_id, id);

CREATE FUNCTION mfx_sync_forensic_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'sync_forensic_change_log is append-only';
END
$$;
CREATE TRIGGER sync_forensic_change_log_append_only
  BEFORE UPDATE ON sync_forensic_change_log
  FOR EACH ROW EXECUTE FUNCTION mfx_sync_forensic_log_append_only();
REVOKE UPDATE ON sync_forensic_change_log FROM mfx_app;

-- Tenant data: same isolation as the other sync tables (007).
ALTER TABLE sync_deleted_attachment_archive ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_deleted_attachment_archive
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
ALTER TABLE sync_forensic_change_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_forensic_change_log
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

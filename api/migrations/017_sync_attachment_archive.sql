-- Sync deletes and overwrites of attachments that can be undone, and who changed the safety
-- settings (CMMS Advisor decision 2026-10-20). The sync server knows the sending DEVICE (activation: licence + machine fingerprint),
-- never the user, so it cannot prove who deleted something; it can keep what was deleted and which
-- device sent the change. New tables only: no existing table changes.

-- 1. Archive of photos / attachments deleted OR REPLACED (the only history sync may delete; the
--    type list lives in api/src/sync/attachment-archive.ts). Rule: every replacement of a LIVE
--    row of an archived type is archived, so a version is hidden but never destroyed:
--    - 'delete': an accepted delete/archive (always recorded, also when the server held a delete
--      marker or nothing: prior_state already_deleted / unknown);
--    - 'overwrite': an accepted upsert/update/create replacing a live row with another payload;
--    - 'restore': an operator restore replacing a live row with another payload (device = server,
--      changed_by_operator = the operator).
--    Written in the transaction that makes the change, before the current state is overwritten.
--    Entries are immutable. Any entry with prior_state 'present' can be restored, any number of
--    times (each restore archives what it replaces; restores are listed in
--    sync_attachment_restore_log). deploy/SYNC_OPERATIONS.md.
--    Privacy: prior payloads are kept with no time limit, until the tenant is deleted.
CREATE TABLE sync_deleted_attachment_archive (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('delete', 'overwrite', 'restore')),
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
  -- relative_path, document_ref) and the media manifest row of the entity, if any. Never content.
  object_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The change moved the file reference (object_key, content_sha256, relative_path or the type's
  -- document_ref): always true for a delete. Edits of a caption or title are false.
  locator_changed BOOLEAN NOT NULL,
  CHECK (prior_state <> 'present' OR (prior_payload_raw IS NOT NULL AND prior_row_version IS NOT NULL
         AND prior_payload_hash IS NOT NULL AND prior_last_ingress_id IS NOT NULL)),
  CHECK (change_kind = 'delete' OR prior_state = 'present'),
  -- The change and who sent it: a device (licence + fingerprint) or, for a restore, the server
  -- (fingerprint server:attachment-restore) and the operator.
  change_operation TEXT NOT NULL,
  change_row_version BIGINT NOT NULL,
  change_ingress_id BIGINT NOT NULL,
  change_payload_hash TEXT NOT NULL,
  changed_by_license_id TEXT NULL,
  changed_by_machine_fingerprint TEXT NOT NULL,
  changed_by_operator TEXT NULL,
  CHECK ((change_kind = 'restore') = (changed_by_operator IS NOT NULL)),
  CHECK (change_kind = 'restore' OR changed_by_license_id IS NOT NULL),
  protocol_version TEXT NOT NULL CHECK (protocol_version IN ('v1', 'v2')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sync_deleted_attachment_archive_change
  ON sync_deleted_attachment_archive (tenant_id, change_ingress_id);
CREATE INDEX sync_deleted_attachment_archive_tenant
  ON sync_deleted_attachment_archive (tenant_id, changed_at DESC, id DESC);
CREATE INDEX sync_deleted_attachment_archive_entity
  ON sync_deleted_attachment_archive (tenant_id, entity_type, entity_sync_id);

-- Every operator restore of an archive entry (an entry may be restored more than once).
CREATE TABLE sync_attachment_restore_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  archive_id BIGINT NOT NULL REFERENCES sync_deleted_attachment_archive (id),
  restored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  audit_record_id TEXT NOT NULL,
  -- The log row and version the restore wrote, and the archive entry of the live row it replaced
  -- (NULL when it replaced a delete marker or the same payload).
  restore_ingress_id BIGINT NOT NULL,
  restore_row_version BIGINT NOT NULL,
  replaced_archive_id BIGINT NULL REFERENCES sync_deleted_attachment_archive (id)
);
CREATE INDEX sync_attachment_restore_log_archive ON sync_attachment_restore_log (tenant_id, archive_id, id);

-- Highest row_version the server ever accepted per entity of an archived type (also written by
-- restores). A restore writes above it, so devices never see a restored row at a version below
-- one they hold, even when a v1 device wrote versions backwards with identical re-sends (those are
-- not archived) and the ingress log holding them was compacted.
CREATE TABLE sync_attachment_version_high_water (
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  max_row_version BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, entity_type, entity_sync_id)
);

-- Console listing: entries that kept a version, newest first, per tenant and per item.
CREATE INDEX sync_deleted_attachment_archive_kept
  ON sync_deleted_attachment_archive (tenant_id, changed_at DESC, id DESC) WHERE prior_state = 'present';

-- Evidence: archive entries and restore records are never updated (deleted only with the tenant).
CREATE FUNCTION mfx_sync_attachment_archive_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER sync_deleted_attachment_archive_immutable
  BEFORE UPDATE ON sync_deleted_attachment_archive
  FOR EACH ROW EXECUTE FUNCTION mfx_sync_attachment_archive_immutable();
CREATE TRIGGER sync_attachment_restore_log_immutable
  BEFORE UPDATE ON sync_attachment_restore_log
  FOR EACH ROW EXECUTE FUNCTION mfx_sync_attachment_archive_immutable();
-- DELETE stays granted to mfx_app on both tables only for tenant delete (purgeTenantSyncData).
REVOKE UPDATE ON sync_deleted_attachment_archive, sync_attachment_restore_log FROM mfx_app;

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
ALTER TABLE sync_attachment_restore_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_attachment_restore_log
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
ALTER TABLE sync_attachment_version_high_water ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_attachment_version_high_water
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
ALTER TABLE sync_forensic_change_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_forensic_change_log
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

-- Sync protocol v2 (deploy/SYNC_PROTOCOL_V2.md): current state, device checkpoints, device-scoped
-- idempotency, conflict log, device profile / users / media manifest. v1 tables stay in use.

-- Parses text as jsonb, or NULL when Postgres cannot store it (e.g. a \u0000 escape). The byte-exact
-- payload is always kept in payload_raw; payload_json is the queryable copy.
CREATE OR REPLACE FUNCTION mfx_try_jsonb(input text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE
  AS $$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- The append log (sync_mirror_ingress.id is the server_seq) gains the v2 item fields.
ALTER TABLE sync_mirror_ingress ADD COLUMN base_row_version BIGINT NULL;
ALTER TABLE sync_mirror_ingress ADD COLUMN owner_user_sync_id TEXT NULL;
ALTER TABLE sync_mirror_ingress ADD COLUMN protocol_version TEXT NOT NULL DEFAULT 'v1';
CREATE INDEX idx_sync_mirror_ingress_tenant_device
  ON sync_mirror_ingress (tenant_id, machine_fingerprint, id);

ALTER TABLE sync_rejection_log ADD COLUMN machine_fingerprint TEXT NULL;
ALTER TABLE sync_rejection_log ADD COLUMN entity_type TEXT NULL;

-- Latest state per entity. Deletes are tombstones (deleted = true) and are never compacted.
CREATE TABLE sync_entity_state (
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  operation TEXT NOT NULL,
  payload_raw TEXT NOT NULL,
  payload_json JSONB NULL,
  payload_hash TEXT NOT NULL,
  deleted BOOLEAN NOT NULL,
  owner_user_sync_id TEXT NULL,
  origin_machine_fingerprint TEXT NOT NULL,
  last_ingress_id BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, entity_type, entity_sync_id)
);
CREATE INDEX idx_sync_entity_state_delta ON sync_entity_state (tenant_id, last_ingress_id);
CREATE INDEX idx_sync_entity_state_owner
  ON sync_entity_state (tenant_id, owner_user_sync_id, last_ingress_id)
  WHERE owner_user_sync_id IS NOT NULL;

-- Existing v1 history becomes the initial current state (latest log row per entity).
INSERT INTO sync_entity_state (
  tenant_id, entity_type, entity_sync_id, row_version, operation, payload_raw, payload_json,
  payload_hash, deleted, owner_user_sync_id, origin_machine_fingerprint, last_ingress_id, updated_at
)
SELECT DISTINCT ON (tenant_id, entity_type, entity_sync_id)
  tenant_id, entity_type, entity_sync_id, row_version, operation, payload_json,
  mfx_try_jsonb(payload_json), payload_hash, operation = 'delete', NULL, machine_fingerprint, id,
  received_at_rfc3339::timestamptz
FROM sync_mirror_ingress
ORDER BY tenant_id, entity_type, entity_sync_id, id DESC;

-- Per-device delivery position (v2). acknowledged_seq = checkpoint the device last sent back (it
-- has applied everything up to it); issued_seq = checkpoint last handed to it.
CREATE TABLE sync_device_checkpoint (
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  acknowledged_seq BIGINT NOT NULL,
  issued_seq BIGINT NOT NULL,
  device_class TEXT NULL CHECK (device_class IN ('desktop', 'mobile')),
  tenant_config_json TEXT NULL,
  last_exchange_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, machine_fingerprint)
);

-- Users a device has reported in current_user_sync_ids (drives user_snapshot_required).
CREATE TABLE sync_device_user (
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  user_sync_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, machine_fingerprint, user_sync_id)
);

-- Device-scoped exchange idempotency with request hash (same key + different body = 409).
CREATE TABLE sync_exchange_idempotency_v2 (
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  server_batch_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, machine_fingerprint, idempotency_key)
);
CREATE INDEX idx_sync_exchange_idempotency_v2_created ON sync_exchange_idempotency_v2 (created_at);

-- Items refused because the device edited a stale version. Never applied; kept for operators.
CREATE TABLE sync_conflict_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  server_batch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  local_row_version BIGINT NOT NULL,
  local_base_row_version BIGINT NULL,
  server_row_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sync_conflict_log_tenant ON sync_conflict_log (tenant_id, id DESC);

-- Latest media manifest entry per attachment, as reported by devices.
CREATE TABLE sync_media_manifest (
  tenant_id TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  reported_by_machine_fingerprint TEXT NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, entity_sync_id)
);

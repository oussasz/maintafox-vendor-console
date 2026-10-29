-- Sync mirror schema (Postgres). Applied on API boot when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS sync_tenant_checkpoint (
  tenant_id TEXT PRIMARY KEY,
  checkpoint_seq BIGINT NOT NULL DEFAULT 0,
  checkpoint_token TEXT NOT NULL,
  updated_at_rfc3339 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_mirror_ingress (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  received_at_rfc3339 TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_mirror_ingress_tenant_id
  ON sync_mirror_ingress (tenant_id, id);

CREATE TABLE IF NOT EXISTS sync_exchange_idempotency (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  server_batch_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_rfc3339 TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sync_device_cursor (
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  last_delivered_ingress_id BIGINT NOT NULL DEFAULT 0,
  updated_at_rfc3339 TEXT NOT NULL,
  PRIMARY KEY (tenant_id, machine_fingerprint)
);

CREATE TABLE IF NOT EXISTS sync_rejection_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  rejection_code TEXT NOT NULL,
  rejection_message TEXT NOT NULL,
  created_at_rfc3339 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_rejection_log_tenant
  ON sync_rejection_log (tenant_id, id DESC);

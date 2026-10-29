-- Measured sync operations metrics (master plan Phase 3.3, api/src/ops/sync-health.ts).

-- Retries: a device that resends an exchange it already sent (lost response) is answered from the
-- stored response; count those replays so retry pressure is measured, not estimated.
ALTER TABLE sync_exchange_idempotency_v2 ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_exchange_idempotency_v2 ADD COLUMN last_replay_at TIMESTAMPTZ NULL;
ALTER TABLE sync_exchange_idempotency ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_exchange_idempotency ADD COLUMN last_replay_at TIMESTAMPTZ NULL;

-- The exchange that refused an item (drill-down from the ops dashboard). NULL for older rows.
ALTER TABLE sync_rejection_log ADD COLUMN server_batch_id TEXT NULL;

-- Window queries of the ops metrics.
-- created_at_rfc3339 is ISO-8601 UTC text (toISOString), so text order is time order.
CREATE INDEX idx_sync_rejection_log_tenant_created ON sync_rejection_log (tenant_id, created_at_rfc3339);
CREATE INDEX idx_sync_conflict_log_tenant_created ON sync_conflict_log (tenant_id, created_at);
CREATE INDEX idx_sync_exchange_idempotency_v2_tenant_created ON sync_exchange_idempotency_v2 (tenant_id, created_at);

-- Operator-requested full resynchronisation of one device (master plan Phase 4.5, repair action).
-- While a request is open, the device's next exchange that presents a checkpoint is refused with
-- invalid_checkpoint_token: the desktop then returns its unsent changes to its outbox, drops its
-- checkpoint and downloads a full snapshot (src-tauri sync worker, CheckpointRefused). The request
-- closes when that device completes a full ("all") snapshot.
CREATE TABLE sync_device_resync_request (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  audit_record_id TEXT NOT NULL,
  completed_at TIMESTAMPTZ NULL
);
-- At most one open request per device.
CREATE UNIQUE INDEX sync_device_resync_request_open
  ON sync_device_resync_request (tenant_id, machine_fingerprint) WHERE completed_at IS NULL;
CREATE INDEX sync_device_resync_request_device
  ON sync_device_resync_request (tenant_id, machine_fingerprint, requested_at DESC);

-- Tenant data (read by the device's own requests): same isolation as the other sync tables (007).
ALTER TABLE sync_device_resync_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_device_resync_request
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

-- Per-user signed sync changes (sync-signing-design.md v9). The server becomes the judge of WHO
-- made a change (Ed25519 signatures against its key directory) and of authority data (accounts,
-- grants, roles: accepted only from a signer holding the right in the server's own state).
-- Numbered 022: 019-021 are used by the mobile branches.

-- 1. Cutover: rows ingested before this sequence are legacy (judged as before); from it on, the
--    signature rules apply. One row, global (server_seq is global: sync_mirror_ingress.id).
CREATE TABLE sync_signing_cutover (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  cutover_seq BIGINT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sync_signing_cutover (id, cutover_seq)
SELECT 1, COALESCE(MAX(id), 0) + 1 FROM sync_mirror_ingress;

-- 2. Key directory: one Ed25519 key per (user, PC). Never deleted (revoked instead) so signatures
--    already accepted stay explainable; removed only with the tenant.
CREATE TABLE sync_user_signing_keys (
  tenant_id TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK (key_id ~ '^[0-9a-f]{32}$'),
  user_sync_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL,
  -- Ingress seq of the published key row (server-originated `user_signing_keys`).
  enrolled_seq BIGINT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_seq BIGINT NULL,
  revoked_reason TEXT NULL CHECK (revoked_reason IS NULL OR revoked_reason IN
    ('password_changed', 'account_disabled', 'account_deleted', 'operator')),
  PRIMARY KEY (tenant_id, key_id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sync_user_signing_keys_user ON sync_user_signing_keys (tenant_id, user_sync_id);

-- 3. Enrolment attempts (rate limits before any Argon2 work). The password is never stored.
CREATE TABLE sync_user_key_enrol_attempts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_sync_id TEXT NOT NULL,
  machine_fingerprint TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL,
  succeeded BOOLEAN NOT NULL
);
CREATE INDEX sync_user_key_enrol_attempts_device
  ON sync_user_key_enrol_attempts (tenant_id, user_sync_id, machine_fingerprint, attempted_at DESC);
CREATE INDEX sync_user_key_enrol_attempts_user
  ON sync_user_key_enrol_attempts (tenant_id, user_sync_id, attempted_at DESC);

-- 4. Verified signatures travel with the log row and the current state (JSON array of
--    {user_sync_id, key_id, signature}); NULL = unsigned (legacy or a type that needs none).
ALTER TABLE sync_mirror_ingress ADD COLUMN signatures_json TEXT NULL;
ALTER TABLE sync_entity_state ADD COLUMN signatures_json TEXT NULL;

-- 5. Founding administrator slot: one per tenant, ever, only from the device of the tenant's
--    first activation. Closed for every tenant that already has data (their authority is legacy).
CREATE TABLE sync_tenant_founding (
  tenant_id TEXT PRIMARY KEY,
  founding_machine_fingerprint TEXT NOT NULL,
  slot_open BOOLEAN NOT NULL,
  founding_account_sync_id TEXT NULL,
  closed_at TIMESTAMPTZ NULL,
  closed_reason TEXT NULL CHECK (closed_reason IS NULL OR closed_reason IN
    ('founding_admin_created', 'other_device_pushed', 'existing_tenant', 'operator')),
  CHECK (slot_open = (closed_at IS NULL))
);
INSERT INTO sync_tenant_founding (tenant_id, founding_machine_fingerprint, slot_open, closed_at, closed_reason)
SELECT DISTINCT ON (tenant_id) tenant_id, machine_fingerprint, false, now(), 'existing_tenant'
FROM machine_activations
ORDER BY tenant_id, activated_at ASC, id ASC;

-- 6. Recovery codes are consumed by the one sync item that performs the recovery. Codes issued
--    before this migration count as consumed (they could otherwise be replayed by any PC that
--    ever held one).
ALTER TABLE admin_recovery_codes ADD COLUMN consumed_at TIMESTAMPTZ NULL;
ALTER TABLE admin_recovery_codes ADD COLUMN consumed_seq BIGINT NULL;
ALTER TABLE admin_recovery_codes ADD COLUMN consumed_entity_sync_id TEXT NULL;
UPDATE admin_recovery_codes SET consumed_at = now() WHERE consumed_at IS NULL;

-- Tenant data: same isolation as the other sync tables (007).
ALTER TABLE sync_user_signing_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_user_signing_keys
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
ALTER TABLE sync_user_key_enrol_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_user_key_enrol_attempts
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());
ALTER TABLE sync_tenant_founding ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_tenant_founding
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

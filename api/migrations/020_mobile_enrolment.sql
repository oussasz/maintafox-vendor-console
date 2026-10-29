-- Admin-issued enrolment of technician phones (Android field app). Owner-approved 2026-10-29
-- (decision register, CMMS Advisor): the licence key is never given to a phone.
--
-- An administrator on an activated desktop issues ONE enrolment for ONE named person at ONE site.
-- The phone presents the enrolment's one-time secret (QR token, or the 8-character typed code)
-- instead of the licence key. The server checks the secret and a free mobile slot, creates the
-- phone's activation bound to that person and site, and the enrolment is spent. An enrolment
-- expires 15 minutes after issue and can be cancelled before it is used.
--
-- Only hashes of the secrets are stored (HMAC with a server key, routes/mobile-enrolment.ts).
CREATE TABLE mobile_enrolments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  license_id TEXT NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  -- The person and site as the desktop knows them (sync ids), with the names shown in lists.
  person_sync_id TEXT NOT NULL,
  person_label TEXT NOT NULL,
  site_sync_id TEXT NOT NULL,
  site_label TEXT NOT NULL,
  issued_by_sync_id TEXT NOT NULL,
  issued_by_label TEXT NOT NULL,
  issued_by_machine TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ NULL,
  cancelled_by_label TEXT NULL,
  cancelled_by_sync_id TEXT NULL,
  redeemed_at TIMESTAMPTZ NULL,
  activation_id TEXT NULL REFERENCES machine_activations(id) ON DELETE SET NULL,
  CONSTRAINT mobile_enrolments_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT mobile_enrolments_single_end_check CHECK (cancelled_at IS NULL OR redeemed_at IS NULL)
);
-- A secret is looked up across tenants (mfx_mobile_enrolment_tenant below), so each is unique.
CREATE UNIQUE INDEX mobile_enrolments_token_hash_idx ON mobile_enrolments (token_hash);
CREATE UNIQUE INDEX mobile_enrolments_code_hash_idx ON mobile_enrolments (code_hash);
CREATE INDEX mobile_enrolments_open_idx
  ON mobile_enrolments (license_id, expires_at) WHERE cancelled_at IS NULL AND redeemed_at IS NULL;

ALTER TABLE mobile_enrolments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mobile_enrolments
  USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant());

-- A phone presents only the secret: its tenant is resolved by this one cross-tenant lookup (same
-- pattern as mfx_license_key_tenant, migration 007). It answers for any matching row; the route
-- refuses spent, cancelled or expired enrolments inside the tenant's scope.
CREATE FUNCTION mfx_mobile_enrolment_tenant(secret_hash text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT tenant_id FROM mobile_enrolments WHERE token_hash = secret_hash OR code_hash = secret_hash LIMIT 1 $$;
REVOKE ALL ON FUNCTION mfx_mobile_enrolment_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mfx_mobile_enrolment_tenant(text) TO mfx_app;

-- The phone's binding, kept on its activation for the desktop's "Téléphones" list.
ALTER TABLE machine_activations ADD COLUMN enrolment_id TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN person_sync_id TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN person_label TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN site_sync_id TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN site_label TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN enrolled_by_label TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN enrolled_at TIMESTAMPTZ NULL;
ALTER TABLE machine_activations ADD COLUMN revoked_by_label TEXT NULL;
ALTER TABLE machine_activations ADD COLUMN revoked_by_sync_id TEXT NULL;
-- admin: removed by an administrator; user_disabled: its person's account was disabled; lost: the
-- phone is lost or stolen, so it gets no final upload.
ALTER TABLE machine_activations ADD COLUMN revoke_reason TEXT NULL
  CONSTRAINT machine_activations_revoke_reason_check CHECK (revoke_reason IN ('admin', 'user_disabled', 'lost'));
-- Revoked by the customer's administrator: the slot is free at once (revoked_at is set). Unless the
-- phone was reported lost, it may still upload its pending work for a limited time (push only,
-- nothing sent back), then wipes itself and confirms (wiped_at). The token stops working for
-- everything else.
ALTER TABLE machine_activations ADD COLUMN wiped_at TIMESTAMPTZ NULL;
ALTER TABLE machine_activations DROP CONSTRAINT machine_activations_revocation_kind_check;
ALTER TABLE machine_activations ADD CONSTRAINT machine_activations_revocation_kind_check
  CHECK (revocation_kind IN ('machine', 'license', 'released', 'tenant_admin'));
CREATE INDEX machine_activations_person_idx
  ON machine_activations (tenant_id, person_sync_id) WHERE person_sync_id IS NOT NULL;

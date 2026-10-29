-- Phone enrolment hardening (review of the phone-removal changes, 2026-10-29).
--
-- A redeem whose answer was lost is answered again only to the same app install: the phone sends a
-- random `redeem_nonce` with every redeem (generated once per secret, reused on retries) and the
-- server keeps its SHA-256 with the redemption. The fingerprint alone is not secret enough.
ALTER TABLE mobile_enrolments ADD COLUMN redeem_nonce_sha256 TEXT NULL;
ALTER TABLE mobile_enrolments ADD CONSTRAINT mobile_enrolments_redeem_nonce_check
  CHECK (redeem_nonce_sha256 IS NULL OR redeem_nonce_sha256 ~ '^[0-9a-f]{64}$');

-- A removed phone's presign-put looks its file up by object key (routes/sync.ts). Built inside the
-- migration's transaction, which locks writes to sync_media_manifest while it runs: on a database
-- that already holds production data, build it instead with CREATE INDEX CONCURRENTLY outside a
-- transaction (then mark this migration applied).
CREATE INDEX sync_media_manifest_object_key_idx ON sync_media_manifest (tenant_id, object_key);

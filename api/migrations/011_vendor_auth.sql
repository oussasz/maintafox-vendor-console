-- Vendor-console operator authentication (master plan Phase 4.1): mandatory TOTP, recovery codes,
-- server-side sessions with rotating refresh tokens.
--
-- Sessions are server-side so "log out everywhere", reuse detection and the MFA reset revoke access
-- immediately: every access token names its session and the API checks it on each request.
-- Secrets are never stored in clear: the TOTP secret is AES-256-GCM sealed (vendor-auth/secrets.ts),
-- refresh tokens and recovery codes are stored as SHA-256 hashes of high-entropy random values.

ALTER TABLE users
  ADD COLUMN totp_secret_sealed TEXT,
  -- Secret shown during enrolment, promoted to totp_secret_sealed once a code from it is confirmed.
  ADD COLUMN totp_pending_sealed TEXT,
  ADD COLUMN totp_enrolled_at TIMESTAMPTZ,
  -- Last accepted TOTP time step: a code is never accepted twice (RFC 6238 §5.2).
  ADD COLUMN totp_last_step BIGINT,
  -- After a server-side MFA reset (tools/vendor-mfa-reset.ts): SHA-256 of the one-time code the CLI
  -- printed. Re-enrolment needs it, so knowing the password alone cannot claim the account.
  ADD COLUMN mfa_reset_code_sha256 TEXT;

CREATE TABLE vendor_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Absolute lifetime: refreshing never extends a session past this.
  expires_at TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_ip TEXT,
  user_agent TEXT
);
CREATE INDEX vendor_sessions_user_idx ON vendor_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE vendor_refresh_tokens (
  token_sha256 TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES vendor_sessions (id) ON DELETE CASCADE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the token is exchanged; presenting it again is reuse (the session is revoked), except
  -- right after the exchange while its successor is still unused (a lost response, not a theft).
  rotated_at TIMESTAMPTZ,
  replaced_by_sha256 TEXT
);
CREATE INDEX vendor_refresh_tokens_session_idx ON vendor_refresh_tokens (session_id);

CREATE TABLE vendor_recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_sha256)
);

-- Like users, these are vendor-operator records, not tenant data: no row-level security (migration
-- 007 isolates tenants). They are read before any data scope exists (login, token checks).

# Vendor console sign-in: two-step verification, sessions, step-up (Phase 4.1)

Code: `api/src/routes/auth.ts`, `api/src/vendor-auth/*`, `api/src/auth-tokens.ts`, guard
`api/src/app/guards.ts`; console `src/pages/LoginPage.tsx`, `src/lib/auth-session.ts`,
`src/lib/api-client.ts`, `src/vendor-console/VendorConsoleStepUpDialog.tsx`,
`src/vendor-console/VendorConsoleAccountMenu.tsx`. Migration `011_vendor_auth.sql`.
Test: `api/scripts/vendor-auth.integration.mjs` (in `test:all`).

## How signing in works

1. **Password** (`POST /api/v1/auth/login`) → no session yet, only a 10-minute "second factor
   pending" token.
2. **First time only — set up an authenticator app.** The console shows a QR code (and the same key
   as text). Scan it with any authenticator app (Google Authenticator, Microsoft Authenticator,
   Aegis, 2FAS, 1Password, Bitwarden...), type the 6-digit code it shows. The console then shows
   **10 recovery codes, once**: print them or save the file somewhere safe, away from the phone.
3. **Every time after** — type the 6-digit code from the app (or one recovery code).

There is no way into the console without step 2/3. An operator who has no authenticator yet is
always sent through step 2: nobody is locked out because they have not enrolled.

**Session.** The browser keeps a 15-minute access token in memory only (nothing in local storage)
and an httpOnly, Secure, SameSite=Strict cookie (`mfx_vendor_refresh`, path `/api/v1/auth`) that
renews it. The cookie is replaced at every renewal; if an old one is ever presented again (a stolen
copy), the whole session is ended and the event is recorded. (Exception: if it comes back within
10 seconds while its replacement was never used — the browser lost the answer — it is refused
without ending the session or raising an alarm; the operator just signs in again.) A session lasts at most **12 hours**,
and ends after **2 hours** without any activity. Account menu (top right): **Log out** (this
browser) and **Log out everywhere** (every browser, e.g. after losing a laptop).

**Step-up (dangerous actions).** Revoking a licence or a machine, changing update or offline
policies, support interventions, new recovery codes... ask for a **fresh 6-digit code**. The server
then issues a 5-minute proof valid for **that kind of action only**, in this session only (kinds:
`shared/step-up-actions.v1.json`). Within those 5 minutes the same proof serves further actions of
the same kind (e.g. several revocations in a row) in this session only; it is never accepted for
another kind. A code is never accepted twice: if the console says the code was refused right after
another one, wait for the app to show the next code.

**Limits.** 10 sign-in attempts per 15 minutes per address, 10 wrong codes per 15 minutes per
operator, 10 refused step-ups per 15 minutes per operator (correct codes never count). When a limit
is hit, wait 15 minutes. Someone who knows your password can use up the wrong-code limit and delay
your sign-in by 15 minutes, but cannot sign in: if that happens, change the password.

Every sign-in, failure, enrolment, renewal, reuse, step-up, refusal and logout is in the audit
ledger (category `vendor_auth`, console Audit page).

## If the authenticator is lost

- **You still have a recovery code:** sign in with it ("Use a recovery code instead"), then account
  menu → **New recovery codes**. To move the authenticator to a new phone, use the reset below.
- **No phone and no recovery code:** reset the second factor on the server (needs SSH access):

  ```bash
  cd /opt/maintafox-vendor-console
  docker compose exec api node dist/tools/vendor-mfa-reset.js --email you@example.com --reason "phone lost 2026-10-12"
  ```

  It removes the authenticator and recovery codes of that operator, ends all their sessions, writes
  an audit record (actor `system:cli-vendor-mfa-reset`, your reason, the server user) and prints a
  one-time **reset code** (`reset_code`, e.g. `K7M2Q-XR4TP`). The password does not change. At the
  next sign-in the console asks for that reset code, then leads through step 2 again: knowing the
  password alone is not enough to claim the account after a reset. The code is shown only in that
  output (never stored in clear, never in the audit log).

  Anyone who can run commands on the server can do this: protect SSH access accordingly.

## Deploy checklist

1. **Migration** `011_vendor_auth.sql` runs automatically at API start (adds TOTP columns to
   `users`, tables `vendor_sessions`, `vendor_refresh_tokens`, `vendor_recovery_codes`).
2. **Environment:** no new variable. The TOTP secrets are sealed (AES-256-GCM) with their own
   subkey, derived from `SYNC_PAYLOAD_ENCRYPTION_KEY` by HKDF-SHA256 with the context label
   `maintafox/vendor-totp/v1` (`PayloadCipher.derive`, `api/src/vendor-auth/service.ts`): sync
   payloads and TOTP secrets never use the same key material. **Rotating
   `SYNC_PAYLOAD_ENCRYPTION_KEY` therefore also requires re-encrypting the TOTP secrets** with the
   new key's subkey. No rotation tool exists yet (for sync payloads either,
   `deploy/TENANT_ISOLATION.md`); until one does, a rotation must be followed by the MFA reset above
   for every operator, who then enrol again.
3. **Edge:** the console and the API must stay on the same site (`console.maintafox.systems` and
   `api.maintafox.systems`): the refresh cookie is SameSite=Strict. `CORS_ORIGIN` must list the
   console origin exactly (already the case); the cookie routes refuse any other `Origin`.
4. Rebuild and start both images (`docker compose build api vendor-console && docker compose up -d`).
5. **Right after deploy, the owner signs in** and completes step 2. Until then, an operator who has
   never enrolled can be enrolled by whoever knows the password first (no reset code exists for a
   first enrolment): do not delay, and check the Audit page shows your own `mfa_enrolled`.
6. Check: Audit page shows `mfa_enrolled` then `login_success`; account menu shows 10 recovery codes.

Every console tab open before the deploy is signed out (the old 12-hour tokens are refused: they
belong to no session).

**Rollback.** The API refuses to start on a database that has a migration it does not know, so
before starting the previous images, un-record migration 011 (its columns and tables can stay: the
previous API does not read them, and operators sign in with the password alone again):

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM schema_migrations WHERE version = 11"
```

Then deploy the previous images. Re-deploying 4.1 later re-applies 011, so first remove what it
created: `ALTER TABLE users DROP COLUMN totp_secret_sealed, DROP COLUMN totp_pending_sealed, DROP
COLUMN totp_enrolled_at, DROP COLUMN totp_last_step, DROP COLUMN mfa_reset_code_sha256; DROP TABLE vendor_refresh_tokens,
vendor_sessions, vendor_recovery_codes;` (operators then enrol again).

# Tenant isolation and encryption at rest (Phase 3.2)

## Row-level security (migration 007)

The API's code filters by tenant in every query (`WHERE tenant_id = ...`). Postgres now enforces
the same rule a second time, so a query bug that drops the `WHERE` cannot leak another tenant's
rows.

- Every API transaction runs as the role **`mfx_app`** (`SET LOCAL ROLE`): not a superuser, not
  the table owner, no `BYPASSRLS`. The connection user (`DATABASE_URL`, the one that runs the
  migrations) must be allowed to switch to it (a superuser, as in docker-compose, or a member of
  `mfx_app`). Statements outside an explicit transaction get their own transaction.
- Each transaction carries one data scope (`api/src/db/database.ts`, `api/src/app/scope.ts`):
  - **tenant** (`mfx.tenant_id`): device requests, from the verified activation token;
  - **operator** (`mfx.operator_actor`): console requests (`user_<id>`) and system tasks
    (`system:startup`, `system:sync-retention`, `system:slickpay-checkout`,
    `system:slickpay-webhook`, `system:sqlite-import`). Each operator scope the API opens is written
    to **`operator_scope_access`** (actor, method, path, time), kept
    `OPERATOR_ACCESS_LOG_RETENTION_DAYS`.
  - **none**: every protected table looks empty.
- Protected tables: every table with a `tenant_id` column (licences, activations, payments,
  support tickets, policy history, all 11 sync tables), `tenants`, ticket interventions (through
  their ticket), and operator-only: `audit_records`, `idempotency_keys`, diagnostic bundles,
  offline reconciliation, `legacy_sqlite_archive`, `operator_scope_access`.
- Activation preview/claim present only a licence key: the single cross-tenant lookup allowed is
  `mfx_license_key_tenant(key)` (SECURITY DEFINER, returns only the tenant id); the request then
  runs in that tenant's scope.
- Not protected (not tenant data): `users`, edition catalog, cohort update policies,
  `schema_migrations` (read-only for `mfx_app`), `backup_runs`, `incident_runbooks`.

Known limit: the API still connects as the database owner and *switches* to `mfx_app`; code that
could run arbitrary SQL could switch back. A separate non-superuser login for the API (migrations
run by another user) is the next step and needs a new secret on the server.

## Encryption at rest of sensitive sync payloads

- `user_accounts` payloads (credentials, personal data) are stored AES-256-GCM encrypted in the
  sync log and current state; every stored exchange response (v1 and v2: they contain delivered
  payloads and conflict rows) is encrypted too. Key: `SYNC_PAYLOAD_ENCRYPTION_KEY`.
- The device's `payload_hash` (SHA-256 of the plaintext) is checked and stored as before; delivery
  decrypts, so devices receive byte-identical payloads and their hash check passes (exchange,
  snapshot, conflicts, idempotent replay).
- Each value is bound to its row (tenant, entity / device, key) as authenticated data.
- Rows written before this release are encrypted once at the next startup (`sync_data_sealed_at_rest`
  in the log).
- Losing the key makes these stored values unreadable (devices keep their own copies). It is in
  `.env`, which the backup sends off-site encrypted; keep it in the password manager too. Rotation
  is not implemented yet: changing the key makes the API refuse the old values with an explicit
  error naming both key ids. The vendor-console TOTP secrets are sealed with a subkey derived from
  this key (HKDF label `maintafox/vendor-totp/v1`): a rotation must re-encrypt them too
  (`deploy/VENDOR_AUTH.md`).

## Tests

`node scripts/tenant-isolation.integration.mjs` (part of `test:all`).

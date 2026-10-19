# Phase 4 deploy checklist (vendor console and control API)

One deploy carries all of Phase 4. Details and per-item rollback: `deploy/VENDOR_AUTH.md` (4.1),
`CONSOLE_ACTIONS.md` (4.2), `OPERATORS.md` (4.3), `BILLING.md` (4.4), `SYNC_OPERATIONS.md` (4.5),
`CI.md` "Contracts shared with the desktop" (4.6), `CONSOLE_LANGUAGES.md` and `AUDIT_LEDGER.md` (4.7),
`CONSOLE_REDESIGN.md` (new console layout).

> **NEW MIGRATION `016_admin_recovery_codes`** (administrator recovery codes, new table only): see
> `CONSOLE_ACTIONS.md` "Administrator recovery code". Rollback adds version 16 to the list below.

## Before

- CI green on the commit being deployed (all jobs, including `e2e`; the `Secret scan` job also
  scans other branches of the repository).
- Backup taken and checked (`deploy/BACKUP_AND_RESTORE.md`).
- The owner has an authenticator app on their phone and is available right after the deploy.

## Deploy

1. **Migrations** run automatically at API start, in order: `011_vendor_auth`, `012_console_actions`,
   `013_vendor_operators`, `014_billing_reconciliation`, `015_sync_resync_requests`, `016_admin_recovery_codes`. All additive
   (new columns and tables; every existing operator becomes owner).
2. **Settings:** none new. `docker-compose.yml` now also passes `BACKUP_LOCAL_RETENTION_DAYS` (already
   in `.env` for the backup service) to the API, for the System health page. TOTP secrets are sealed with a subkey of `SYNC_PAYLOAD_ENCRYPTION_KEY`
   (HKDF label `maintafox/vendor-totp/v1`): rotating that key also needs every operator to enrol again.
3. **Images:** rebuild and restart `api` and `vendor-console`. The API image carries
   `shared/step-up-actions.v1.json`, `shared/sync-entity-registry.v2.json` and
   `shared/audit-action-categories.v1.json`; it does not start without them.
4. **Right after**: the owner signs in → enrols the authenticator → saves the 10 recovery codes.
   Until then, whoever knows the password first could enrol (no reset code exists for a first
   enrolment). Then: Audit & evidence shows `mfa_enrolled` and `login_success` ("Console sign-in").
5. **Checks:** the Overview shows the four key figures and what needs attention; System health shows
   the last backup and restore test; Settings and team lists the owner as Owner; Machines → "Policy refresh" on a live device
   shows "Refresh pending" and clears after its next licence check; Sync operations → Device
   timeline lists recent syncs; Billing lists a customer's licence; language selector → Français.

Desktops need nothing: every new answer they may get (`401 policy_refresh_required`,
`400 invalid_checkpoint_token` after a resynchronisation request, extra fields) is one they already
handle. Console tabs open before the deploy are signed out.

## Rollback

The API refuses to start on a database with a migration it does not know. Before starting the
previous images, un-record the Phase 4 migrations (their columns and tables can stay; the previous
API ignores them):

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM schema_migrations WHERE version IN (11, 12, 13, 14, 15, 16)"
```

Then start the previous `api` and `vendor-console` images. Consequences: operators sign in with the
password alone again and every operator has full access; a released slot stays refused until the
device re-activates; an open resynchronisation request is ignored. Re-deploying Phase 4 later
re-applies the migrations: first drop what they created (the statements are in each item's doc).

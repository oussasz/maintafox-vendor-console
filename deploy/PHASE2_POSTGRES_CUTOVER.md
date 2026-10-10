# Phase 2.1 cutover: control-API data from SQLite to Postgres

This runbook moves the live control API (tenants, licences, activations, users, audit ledger,
support, payments, edition catalog) from the SQLite file `control-plane.db` to the Postgres
database that already holds the sync data, and turns on sync protocol v2.

- Expected downtime of the API: about 5 minutes (the data is small).
- Desktops keep working: they speak sync v1, which is unchanged on the wire, and their
  activation tokens are copied with the activations (same `JWT_SECRET`).
- Everything below runs on the VPS in `/opt/maintafox-vendor-console` (compose project
  `maintafox-vendor-console`). Commands assume `bash` as `root`.

## 0. What changes

| Item | Before | After |
|---|---|---|
| Control-plane data | SQLite `/data/control-plane.db` (volume `*_control_api_data`) | Postgres (same database as sync, `DATABASE_URL`) |
| Schema | created ad hoc at boot | versioned migrations `api/migrations/001..004`, table `schema_migrations` |
| Sync | v1 only, SQLite fallback possible | v1 unchanged + v2 (`deploy/SYNC_PROTOCOL_V2.md`); no SQLite fallback |
| Required env | ... | adds `SYNC_CHECKPOINT_SECRET`, `SYNC_INGRESS_RETENTION_DAYS`, `SYNC_IDEMPOTENCY_RETENTION_DAYS`, `SYNC_RETENTION_INTERVAL_MINUTES`; `DATA_DIR` is no longer read |

The SQLite file is only **read** by the import (opened read-only). It stays in its volume as the
rollback copy.

## 1. Prepare (API still running, no downtime)

1. Upload and extract the release into `/opt/maintafox-vendor-console.new` and copy the current
   `.env` into it, as in the usual deploy pattern.
2. Add the new settings to the new `.env` (generate the secret on the server, never reuse one):

   ```bash
   cd /opt/maintafox-vendor-console.new
   printf '\nSYNC_CHECKPOINT_SECRET=%s\nSYNC_INGRESS_RETENTION_DAYS=90\nSYNC_IDEMPOTENCY_RETENTION_DAYS=14\nSYNC_RETENTION_INTERVAL_MINUTES=60\n' "$(openssl rand -hex 32)" >> .env
   grep -c '^SYNC_' .env   # expect 4
   ```

3. Build the new API image without starting it:

   ```bash
   docker compose -p maintafox-vendor-console --env-file .env build api
   ```

## 2. Back up (start of the downtime)

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ); B=/opt/backups/$TS; mkdir -p "$B"
cd /opt/maintafox-vendor-console            # the CURRENT (old) folder
docker compose -p maintafox-vendor-console stop api     # no more writes to SQLite
# SQLite file (copied out of the volume, with its WAL/SHM files if present)
docker run --rm -v maintafox-vendor-console_control_api_data:/data -v "$B":/backup alpine \
  sh -c 'mkdir -p /backup/control_api_data && cp -a /data/. /backup/control_api_data/ && ls -la /backup/control_api_data'
# Postgres (custom format, restorable with pg_restore)
docker exec maintafox-sync-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$B/postgres.dump"
sha256sum "$B"/control_api_data/* "$B/postgres.dump" | tee "$B/SHA256SUMS"
ls -la "$B"
```

Check that `postgres.dump` is not empty and that `control-plane.db` is listed before you continue.

## 3. Import (API stopped)

Run the import from the **new** image. `docker compose run` gives it `DATABASE_URL` and the
`/data` volume. Postgres must be running (it is; only `api` was stopped). Do not run the dry run
while the old API is still serving: the dry run applies the schema migrations (including the
one-time sync state backfill), and sync rows the old API writes afterwards would not be in it.

1. Dry run: everything is checked and copied, then rolled back.

   ```bash
   cd /opt/maintafox-vendor-console.new
   docker compose -p maintafox-vendor-console --env-file .env run --rm --no-deps api \
     node dist/tools/migrate-sqlite-to-postgres.js --sqlite /data/control-plane.db --dry-run
   ```

   Expect `"status": "dry_run_ok_rolled_back"`, every table's `copied_rows` equal to its
   `source_rows`, and `"audit_chain"` with `"status": "ok"` for both `source` and `target`.

   If it reports `refused`, read the message; nothing was copied. Typical cases:
   - `SQLite holds sync fallback data`: only if the API once ran without `DATABASE_URL`. Live
     sync data is in Postgres already; add `--discard-sqlite-sync-fallback` after checking the
     counts it prints.
   - `columns unknown to the Postgres schema` / `tables this import does not know`: stop and
     report it; do not force anything.
   - `audit hash chain is already invalid`: the SQLite ledger was altered; stop and investigate.

2. Real import (same command without `--dry-run`):

   ```bash
   docker compose -p maintafox-vendor-console --env-file .env run --rm --no-deps api \
     node dist/tools/migrate-sqlite-to-postgres.js --sqlite /data/control-plane.db | tee "$B/import-report.json"
   ```

   Expect `"status": "imported"`. A second run is refused (`refusing to run twice`).

## 4. Start the new API

```bash
cd /opt && mv maintafox-vendor-console maintafox-vendor-console.prev && mv maintafox-vendor-console.new maintafox-vendor-console
cd /opt/maintafox-vendor-console
docker compose -p maintafox-vendor-console --env-file .env up -d api
docker compose -p maintafox-vendor-console --env-file .env up -d --force-recreate edge
docker compose -p maintafox-vendor-console logs --tail 50 api
```

The log must show `schema_migrations_ready` and `control_api_listening`, and no `FATAL`.

## 5. Verify

1. `docker compose -p maintafox-vendor-console exec api wget -qO- http://127.0.0.1:3000/health` → `"status":"ok"`.
2. Console: log in with the existing operator account (do **not** test the login rate limit from
   the office IP). Tenants, licences and the Machines page show the same data as before.
3. Audit ledger: `GET /api/v1/audit/ledger/verify-chain` (console session) →
   `{"status":"ok","checked_count":N}` with N equal to `audit_chain.target.checked_count` in the
   import report.
4. Row counts in Postgres match the report:

   ```bash
   docker exec maintafox-sync-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
     SELECT (SELECT count(*) FROM tenants) tenants, (SELECT count(*) FROM license_keys) licences,
            (SELECT count(*) FROM machine_activations) activations, (SELECT count(*) FROM audit_records) audit,
            (SELECT count(*) FROM users) users, (SELECT max(version) FROM schema_migrations) schema_version;"'
   ```

5. Desktops: within a minute the logs show `sync_exchange` lines with `"protocol_version":"v1"`
   for the activated machines (`docker compose -p maintafox-vendor-console logs api | grep '"sync_exchange"' | tail`).
6. Sync state was backfilled from the existing log: `SELECT count(*) FROM sync_entity_state;` is
   not 0 if any sync data existed.

## 6. Rollback

Pick the first case that applies.

**A. The import was refused or failed (step 3).** No control-plane rows were copied. Start the
old API again (if the dry run had already applied the migrations, run the "moving forward again"
SQL below before the next attempt):

```bash
cd /opt/maintafox-vendor-console        # still the old folder at this point
docker compose -p maintafox-vendor-console --env-file .env up -d api
```

**B. The new API is running but must be abandoned.** The SQLite file is unchanged, so the old
release works as before. Operator changes made in the new API (licences, revocations, ...) are
not in SQLite: list them first from the Postgres audit ledger
(`SELECT sequence, occurred_at_rfc3339, action_code, scope_tenant_id FROM audit_records WHERE sequence > <N from the import report> ORDER BY sequence;`)
and re-enter them in the old console afterwards.

```bash
cd /opt && mv maintafox-vendor-console maintafox-vendor-console.failed && mv maintafox-vendor-console.prev maintafox-vendor-console
cd /opt/maintafox-vendor-console
docker compose -p maintafox-vendor-console --env-file .env up -d --build api
docker compose -p maintafox-vendor-console --env-file .env up -d --force-recreate edge
```

The extra Postgres tables and columns are ignored by the old API (its v1 sync inserts name their
columns; the new columns have defaults).

**C. Postgres itself is damaged.** Restore the dump taken in step 2, then continue with case B:

```bash
docker exec -i maintafox-sync-postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < "$B/postgres.dump"
```

**Moving forward again after case B.** The old API kept writing sync v1 rows to Postgres but not
to the v2 current state, and the control-plane tables still hold the first import. Before
repeating steps 2-5, reset the control-plane copy and refresh the current state:

```sql
BEGIN;
TRUNCATE control_plane_sqlite_import, payment_orders, idempotency_keys, cohort_update_policy_history,
  tenant_update_policy_history, cohort_update_policies, incident_runbooks, offline_ticket_reconciliation,
  diagnostic_bundle_artifacts, diagnostic_bundles, support_ticket_interventions, support_tickets,
  audit_records, machine_activations, license_keys, tenants, edition_catalog, users;
INSERT INTO sync_entity_state (tenant_id, entity_type, entity_sync_id, row_version, operation, payload_raw,
  payload_json, payload_hash, deleted, owner_user_sync_id, origin_machine_fingerprint, last_ingress_id, updated_at)
SELECT DISTINCT ON (tenant_id, entity_type, entity_sync_id)
  tenant_id, entity_type, entity_sync_id, row_version, operation, payload_json, mfx_try_jsonb(payload_json),
  payload_hash, operation = 'delete', owner_user_sync_id, machine_fingerprint, id, received_at_rfc3339::timestamptz
FROM sync_mirror_ingress
ORDER BY tenant_id, entity_type, entity_sync_id, id DESC
ON CONFLICT (tenant_id, entity_type, entity_sync_id) DO UPDATE SET
  row_version = EXCLUDED.row_version, operation = EXCLUDED.operation, payload_raw = EXCLUDED.payload_raw,
  payload_json = EXCLUDED.payload_json, payload_hash = EXCLUDED.payload_hash, deleted = EXCLUDED.deleted,
  owner_user_sync_id = EXCLUDED.owner_user_sync_id,
  origin_machine_fingerprint = EXCLUDED.origin_machine_fingerprint, last_ingress_id = EXCLUDED.last_ingress_id,
  updated_at = EXCLUDED.updated_at
WHERE sync_entity_state.last_ingress_id < EXCLUDED.last_ingress_id;
COMMIT;
```

## 7. After the cutover

- Keep `/opt/backups/$TS` and the `*_control_api_data` volume (the SQLite file) for at least 30
  days. Do not remove the volume from compose before that.
- The desktop v2 client (Phase 2.2/2.3) can be rolled out at any time after this; v1 and v2
  devices can be mixed.
- Changing `SYNC_CHECKPOINT_SECRET` later makes every v2 device bootstrap again (snapshot).
  Treat it like the other secrets.

## Known limits

- The import refuses unknown tables or columns instead of guessing. Only the tenants table has
  a known legacy shape; its extra columns are kept in `tenants.legacy_attributes_json`.
- Log compaction ignores activated devices that have never synced. A v1 device that is
  activated but has never synced, and syncs for the first time after compaction, does not
  receive the compacted history (v2 devices bootstrap with a snapshot and are not affected).

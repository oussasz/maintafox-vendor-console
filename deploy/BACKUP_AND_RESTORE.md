# Backups and restore (Phase 3.5)

> **Plain statement:** until an off-site bucket is configured (`BACKUP_OFFSITE_MODE=s3`), every
> backup lives **on the same VPS disk** as the database. That protects against mistakes (a bad
> migration, a deleted tenant, a corrupted table) but **not** against losing the server or its
> disk. The owner must choose and pay for an off-site bucket (section 6).

## 1. What is backed up

| What | How | Where | Kept |
|---|---|---|---|
| Postgres (all control-plane + sync data) | `pg_dump -Fc` every night (`BACKUP_DAILY_AT_UTC`) | volume `backup_data` → `/backups/pg_dump/<db>-<ts>.dump` + `.sha256` | `BACKUP_LOCAL_RETENTION_DAYS` |
| Postgres physical copy | `pg_basebackup` (tar.gz) every night | `/backups/base/<ts>/base.tar.gz` | same; the newest is always kept |
| Postgres changes between nights | continuous WAL archiving (`archive_command` → `deploy/backup/wal-archive.sh`), a segment at least every `PG_WAL_ARCHIVE_TIMEOUT_SECONDS` | volume `pg_wal_archive` (`*.gz`) | back to the oldest kept base backup |
| Tenant media (MinIO) | object **versioning** on the bucket (overwrite/delete keeps the old version) | MinIO itself | old versions `MINIO_NONCURRENT_VERSION_RETENTION_DAYS` |
| Everything above + `.env` | off-site copy, each object encrypted with `age` to the owner's public key | any S3-compatible bucket (`BACKUP_OFFSITE_*`) | the bucket's lifecycle rule (never deleted by the server) |

Every nightly run and every drill writes one row in `backup_runs` (status, off-site status, dump
name/size/sha256, a readable detail). The scheduler runs a **restore drill** on day
`BACKUP_DRILL_DAY_OF_MONTH`: the newest dump is restored into a scratch database, verified (every
table's row count against the dump, the schema migrations, the audit hash chain), then dropped.

Recovery points: on this server, at most `PG_WAL_ARCHIVE_TIMEOUT_SECONDS` of data (15 min with
900). Off-site, at most one day (WAL is uploaded with the nightly run).

## 2. Components

- `deploy/backup/` — `backup.sh` (nightly), `restore.sh` (restore one dump into a new DB and
  verify), `restore-drill.sh`, `restore-physical.sh` (prepare a data directory for point-in-time
  recovery), `scheduler.sh` (container entry point), `wal-archive.sh` / `wal-restore.sh`
  (Postgres archive/restore commands), `pg_hba.conf` (adds replication access for `pg_basebackup`).
- `api/src/tools/verify-restored-database.ts`, `api/src/tools/backup-offsite.ts`.
- Compose: service `backup` (image `maintafox-backup:local`, built from `api/Dockerfile` target
  `backup`), one-shot `pg-wal-archive-init`, Postgres `command:` with the archive settings,
  `minio-init` turning on versioning, volumes `pg_wal_archive` and `backup_data`.
- Migration `006_backup_runs.sql`.

## 3. Applying it on the VPS (main session, after the owner says "deploy")

New `.env` lines (values to use now):

```
PG_WAL_ARCHIVE_TIMEOUT_SECONDS=900
BACKUP_DAILY_AT_UTC=02:30
BACKUP_DRILL_DAY_OF_MONTH=1
BACKUP_LOCAL_RETENTION_DAYS=14
MINIO_NONCURRENT_VERSION_RETENTION_DAYS=30
BACKUP_OFFSITE_MODE=disabled
```

Steps (on top of the usual release swap: back up first, `git archive`, build, swap):

1. Build: `docker compose build api backup` (the backup image shares the API build stages).
2. `docker compose up -d` — this recreates `postgres` (new `command:`; a restart of a few
   seconds), runs `pg-wal-archive-init` and `minio-init`, starts `backup`.
3. Check archiving works:
   `docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select pg_switch_wal()"`, then
   `... -c "select archived_count, failed_count, last_failed_wal from pg_stat_archiver"` →
   `archived_count >= 1`, `failed_count = 0`.
4. Check MinIO versioning: `docker compose logs minio-init` ends with `... versioning is enabled`.
5. Run a backup and a drill now instead of waiting for the night:
   `docker compose exec backup sh /opt/maintafox-backup/backup.sh` then
   `docker compose exec backup sh /opt/maintafox-backup/restore-drill.sh` → the drill prints a
   JSON report with `"ok": true`; both rows are in `backup_runs`.
6. `docker compose logs backup` shows `scheduler started ...` and `next backup in ... s`.

**Rollback:** restore the previous `docker-compose.yml` (the old release folder) and
`docker compose up -d postgres minio-init` → Postgres runs without archiving and with the image's
own `pg_hba.conf` again (nothing in the data directory was changed). `docker compose rm -sf backup`.
The new volumes can stay (or `docker volume rm maintafox-vendor-console_pg_wal_archive
maintafox-vendor-console_backup_data` once no longer wanted). Migration 006 only adds a table; an
older API refuses to start on a database that has it ("database is newer than the code"), so a
code rollback past this release needs `DELETE FROM schema_migrations WHERE version = 6; DROP TABLE backup_runs;`
(after copying anything you want to keep from it). MinIO versioning can be suspended with
`mc version suspend local/<bucket>`.

**Risk to watch on step 2:** the `hba_file` replaces the data directory's `pg_hba.conf` with the
same rules the postgres:16 image writes (plus replication). If the API cannot connect after step 2,
roll back as above and compare `cat $PGDATA/pg_hba.conf` in the container with
`deploy/backup/pg_hba.conf`.

## 4. Restoring

All commands run in the backup container: `docker compose exec backup sh` (PG* variables are set).

### 4.1 A table or tenant was damaged — restore a dump next to the live database

```sh
ls /backups/pg_dump/
sh /opt/maintafox-backup/restore.sh /backups/pg_dump/<file>.dump maintafox_restore_<yyyymmdd>
```

This never touches the live database: it creates a new one and verifies it. Copy the rows you need
from it (or, after stopping the API, rename databases). Drop it afterwards with
`dropdb maintafox_restore_<yyyymmdd>`.

### 4.2 Disaster: the database volume is lost — point-in-time recovery

1. `docker compose stop api backup postgres`
2. Keep the damaged volume aside (`docker volume create ...` a new one rather than deleting).
3. Prepare the new data directory from a base backup + the WAL archive (optionally a target time
   just before the incident):

   ```sh
   docker compose run --rm --no-deps -v <new volume>:/restore-data backup \
     sh /opt/maintafox-backup/restore-physical.sh /backups/base/<ts> /restore-data/pgdata \
        /mfx-backup/wal-restore.sh "2026-10-12 08:30:00+00"
   ```
4. Point the postgres service at the new volume, start it; Postgres replays the archive, then
   promotes. `docker compose logs postgres` shows `archive recovery complete`.
5. Start `api` and `backup`; run `restore-drill.sh` to verify, and take a fresh backup.

### 4.3 The whole server is lost — from off-site

On a new server with this repository and the owner's age **private** key (`owner.key`):

```sh
node dist/tools/backup-offsite.js list --key-prefix pg_dump      # newest dump name
node dist/tools/backup-offsite.js fetch --key pg_dump/<file>.dump --out /backups/<file>.dump.age
node dist/tools/backup-offsite.js fetch --key pg_dump/<file>.dump.sha256 --out /backups/<file>.dump.sha256.age
node dist/tools/backup-offsite.js fetch --key env/<ts>.env --out /tmp/env.age
age --decrypt --identity owner.key --output .env /tmp/env.age
AGE_IDENTITY_FILE=owner.key sh /opt/maintafox-backup/restore.sh /backups/<file>.dump.age maintafox_sync
```

Media objects are under `media/<object key>.age` (decrypt each and put it back in the bucket under
the same key). Base backups and WAL (`base/`, `wal/`) allow the same point-in-time recovery as 4.2.

## 5. Tests

- `pnpm --filter maintafox-control-api run test:backup-drill` — needs the PostgreSQL 16 programs
  on PATH. Real cluster with the production archive settings; real API writes data; backup →
  restore drill (counts, migrations, audit chain) → corrupted dump refused → existing database
  refused → tampered audit ledger detected → point-in-time recovery to the end of the archive and to
  a time before the last insert.
- `pnpm --filter maintafox-control-api run test:backup-offsite` — needs an S3-compatible server
  (`OFFSITE_TEST_S3_ENDPOINT/_ACCESS_KEY/_SECRET_KEY`) and `age`. Runs in CI against MinIO.

## 6. Off-site bucket: the owner's decision

Any S3-compatible provider works; no provider is hard-coded. Pick one in a **different
location/company than the VPS** (the VPS is at OVH). Rough prices (check the provider's page; our
data is a few GB, so all of these cost a few euros a month at most):

| Provider | Approx. price | Notes |
|---|---|---|
| Backblaze B2 | ≈ $6 / TB / month (≈ $0.006/GB), first 10 GB free | Cheapest; US or EU (Amsterdam) region. Supports object lock. |
| Scaleway Object Storage (Paris/Amsterdam/Warsaw) | ≈ €0.015 / GB / month | EU company and EU data. |
| Hetzner Object Storage (Germany/Finland) | ≈ €5 / month flat (1 TB included) | Simple flat price, EU. |

Setup once the owner has an account:
1. Create a **private** bucket. Add a lifecycle rule that deletes objects after e.g. 90 days (the
   server never deletes off-site). If the provider offers object lock / versioning, turn it on.
2. Create an access key limited to that bucket with **write + list + read** but **no delete**.
3. On the owner's own computer (not the VPS): `age-keygen -o owner.key`. Keep `owner.key` in a
   password manager and on paper/USB; it is the only way to read the off-site copies. The printed
   `public key: age1...` goes into `BACKUP_AGE_RECIPIENT`.
4. Fill `BACKUP_OFFSITE_*` in `.env`, set `BACKUP_OFFSITE_MODE=s3`, `docker compose up -d backup`,
   then run `backup.sh` by hand and check `backup_runs.offsite_status = 'uploaded'`.

Independently of the bucket: keep a copy of `.env` in the password manager. Without
`ENTITLEMENT_SIGNING_PRIVATE_KEY`, `JWT_SECRET` and `SYNC_CHECKPOINT_SECRET` a restored server
cannot sign licences or accept the devices already in the field.

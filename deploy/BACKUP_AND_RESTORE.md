# Backups and restore (Phase 3.5, encryption at rest added 2026-10-12)

> **Plain statement.** Every backup is kept on our own infrastructure: the VPS (OVH, Roubaix,
> France) and, optionally, a machine on the owner's premises in Algeria that pulls a copy every
> night (§8). No third-party cloud is used (`BACKUP_OFFSITE_MODE=disabled`).
> With `BACKUP_LOCAL_ENCRYPTION=required` every backup file is **encrypted** to the owner's key.
> The private key is **not** on the server: only the owner, with the key saved in a password
> manager, can open a backup. **If that key is lost, every backup is unreadable, for everyone.**
> Until the on-premise pull (§8) runs, the backups share the VPS disk with the database: they
> protect against mistakes (a bad migration, a deleted tenant, a corrupted table) but **not**
> against losing the server or its disk.

## 1. What is backed up

| What | How | Where (on the VPS) | Kept |
|---|---|---|---|
| Postgres (all control-plane + sync data) | `pg_dump -Fc` every night (`BACKUP_DAILY_AT_UTC`), **restored into a scratch database and verified before it is stored** | volume `backup_data` → `/backups/pg_dump/<db>-<ts>.dump.age` + `.dump.sha256.age` | `BACKUP_LOCAL_RETENTION_DAYS` |
| Postgres physical copy | `pg_basebackup` (tar.gz) every night | `/backups/base/<ts>/base.tar.gz.age` (+ `backup_manifest.age`, `start-wal`) | same; the newest is always kept |
| Postgres changes between nights | continuous WAL archiving (`archive_command` → `deploy/backup/wal-archive.sh`), a segment at least every `PG_WAL_ARCHIVE_TIMEOUT_SECONDS` | volume `pg_wal_archive` (`<segment>.gz.age` + `.gz.age.sha256`) | back to the oldest kept base backup |
| Tenant media (MinIO) | object **versioning** on the bucket (overwrite/delete keeps the old version) | MinIO itself | old versions `MINIO_NONCURRENT_VERSION_RETENTION_DAYS` |
| A list of every encrypted file and its SHA-256 | written by each nightly run | `/backups/SHA256SUMS` | current |

`.age` = encrypted with [age](https://age-encryption.org) to `BACKUP_AGE_RECIPIENT` (§7). With
`BACKUP_LOCAL_ENCRYPTION=disabled` the same files exist without `.age` (plaintext), as before.

Not encrypted, on purpose, because they contain no data: `start-wal` (the name of the first WAL
file a base backup needs, read by the retention without the key), `<segment>.gz.age.sha256` (the
SHA-256 of a WAL segment, so a retried archive can be recognised without the key), and
`SHA256SUMS` (hashes of the encrypted files).

Every nightly run and every drill writes one row in `backup_runs` (status, off-site status, dump
name/size/sha256, a readable detail that says whether the files are encrypted at rest). The
scheduler runs a **restore drill** on day `BACKUP_DRILL_DAY_OF_MONTH`: it takes a fresh dump,
restores it into a scratch database, verifies it (every table's row count against the dump, the
schema migrations, the audit hash chain), then drops it and deletes the dump.

Recovery points: at most `PG_WAL_ARCHIVE_TIMEOUT_SECONDS` of data (15 min with 900). The
on-premise copy (§8) is at most one day behind.

**Where plaintext exists, and for how long.** A dump or base backup exists unencrypted only in
`BACKUP_WORK_DIR` (`/backup-work`, its own volume `backup_work`, mode 700) while it is verified and
encrypted; it is deleted at the end of the run. The work directory is emptied at the **start** of
every run too, so a crash mid-run cannot leave plaintext behind beyond the next run. WAL is piped
from gzip straight into age: it is never written unencrypted. Do not start `backup.sh` or
`restore-drill.sh` by hand while the other is running (each empties the work directory).

## 2. Components

- `deploy/backup/` — `backup.sh` (nightly), `restore.sh` (restore one dump into a new DB and
  verify; decrypts `.age` with the owner's key), `restore-drill.sh`, `restore-physical.sh` (prepare
  a data directory for point-in-time recovery), `scheduler.sh` (container entry point),
  `wal-archive.sh` / `wal-restore.sh` (Postgres archive/restore commands), `keygen.sh` (one-time
  key creation, §7.2), `lib.sh`, `pg_hba.conf` (adds replication access for `pg_basebackup`).
- `deploy/postgres/Dockerfile` — the postgres service image: `postgres:16-alpine` + `age`.
- `deploy/backup-pull/` — optional read-only SFTP access for the on-premise copy (§8).
- `api/src/tools/verify-restored-database.ts`, `api/src/tools/backup-offsite.ts`.
- Compose: service `backup` (image `maintafox-backup:local`, built from `api/Dockerfile` target
  `backup`), one-shot `pg-wal-archive-init`, Postgres (image `maintafox-postgres:local`) with the
  archive settings, `minio-init` turning on versioning, volumes `pg_wal_archive`, `backup_data`,
  `backup_work`.
- Migration `006_backup_runs.sql`.

## 3. Deploying encryption at rest (main session, after the owner says "deploy")

Starting point: Phase 3 is live (43cdc6a), backups are plaintext. Order matters: **the key comes
first**, then the switch.

1. **Release** as usual (back up, `git archive`, swap). Build the images:
   `docker compose build postgres api backup` (postgres = the cached `postgres:16-alpine` + age;
   no server version change).
2. **Owner creates the key** (§7.2), on the VPS, from the project folder:
   ```sh
   docker compose run --rm --no-deps -v "$PWD/.env:/run/maintafox/env-rw" backup \
     sh /opt/maintafox-backup/keygen.sh /run/maintafox/env-rw /dev/shm
   ```
   The owner saves the printed key in the password manager and types the confirmation. Check:
   `grep '^BACKUP_AGE_RECIPIENT=age1' .env` prints one line.
3. **Switch on** in `.env`: `BACKUP_LOCAL_ENCRYPTION=required` (new required variable; the
   compose file refuses to start without it).
4. `docker compose up -d` — recreates `postgres` (new image and environment; a restart of a few
   seconds) and `backup` (new volume `backup_work`).
5. **Check** (in this order):
   - WAL is archived encrypted: `docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select pg_switch_wal()"`,
     then `... -c "select archived_count, failed_count, last_archived_wal, last_failed_wal from pg_stat_archiver"`
     → `failed_count` unchanged, and `docker compose exec backup ls /wal-archive | tail -3` shows `...gz.age`.
   - Run the nightly now: `docker compose exec backup sh /opt/maintafox-backup/backup.sh` →
     the log ends with `status=succeeded`; the detail starts with
     `Encrypted N plaintext backup files left by an earlier release and deleted the plaintext.`
   - Nothing plaintext is left:
     `docker compose exec backup sh -c 'find /backups /wal-archive /backup-work -type f ! -name "*.age" ! -name start-wal ! -name "*.gz.age.sha256" ! -name SHA256SUMS'`
     prints nothing; `ls -l /backups/pg_dump` shows `-rw-------` files owned by `70`.
   - Drill: `docker compose exec backup sh /opt/maintafox-backup/restore-drill.sh` → JSON with
     `"ok": true`.
   - `docker compose logs backup | grep 'encrypted at rest to age1'` (the scheduler confirms the mode).
6. **Owner proves the key works** (once, on their own computer, §4.4): download the newest dump
   and decrypt it. Until this is done, nobody has proven that the saved key opens the backups.

**Rollback** (any step):
- Before step 4: nothing changed on the server; remove the `BACKUP_LOCAL_ENCRYPTION` line.
- After step 4: set `BACKUP_LOCAL_ENCRYPTION=disabled` and `docker compose up -d postgres backup`
  → new backups are plaintext again; the encrypted ones stay encrypted (restoring them needs the
  key). Going back to the previous release's `docker-compose.yml` (image `postgres:16-alpine`
  again) also works: `wal-restore.sh` of the previous release does not read `.gz.age`, so do a
  **full plaintext backup right after** such a rollback (`backup.sh`) and keep the owner's key for
  the encrypted files. The volume `backup_work` can be removed once unused
  (`docker volume rm maintafox-vendor-console_backup_work`).
- If WAL archiving fails after step 4 (`failed_count` rising): `docker compose logs postgres | grep wal-archive`
  shows why (usually an empty or wrong `BACKUP_AGE_RECIPIENT`). Postgres keeps the WAL and retries:
  no data is lost, but the disk fills if it lasts days. Fix `.env` or roll back as above.

**Risks to watch:** the postgres container restarts in step 4 (seconds of API errors). The first
encrypted nightly encrypts every existing file once (minutes for GBs; the WAL archive is the
largest part).

## 4. Restoring

All commands run in the backup container: `docker compose exec backup sh` (PG* variables set).
**Encrypted backups need the owner's private key**, which is never kept on the server. For a
restore the owner puts it on the server **in memory only**, and removes it afterwards:

```sh
# on the VPS host, as root: memory-backed, readable by the postgres/backup uid (70)
install -m 400 -o 70 -g 70 /dev/null /dev/shm/owner.key
cat > /dev/shm/owner.key          # paste the AGE-SECRET-KEY-1... line, Enter, Ctrl+D
# ... restore (below) ...
shred -u /dev/shm/owner.key       # afterwards, always
```

and mounts it into the container for that one command:
`docker compose run --rm --no-deps -v /dev/shm/owner.key:/run/restore-key/owner.key:ro -e AGE_IDENTITY_FILE=/run/restore-key/owner.key backup sh`.

### 4.1 A table or tenant was damaged — restore a dump next to the live database

```sh
ls /backups/pg_dump/
sh /opt/maintafox-backup/restore.sh /backups/pg_dump/<file>.dump.age maintafox_restore_<yyyymmdd>
```

This never touches the live database: it creates a new one and verifies it. Without the key it
stops with `... is encrypted: set AGE_IDENTITY_FILE ...`; with a wrong key, `... it is not the
private key these backups were encrypted to`. Copy the rows you need from the new database (or,
after stopping the API, rename databases). Drop it afterwards with `dropdb maintafox_restore_<yyyymmdd>`.

### 4.2 Disaster: the database volume is lost — point-in-time recovery

1. `docker compose stop api backup postgres`
2. Keep the damaged volume aside (`docker volume create ...` a new one rather than deleting).
3. Put the key in memory (above). Prepare the new data directory from a base backup + the WAL
   archive (optionally a target time just before the incident):
   ```sh
   docker compose run --rm --no-deps -v <new volume>:/restore-data \
     -v /dev/shm/owner.key:/run/restore-key/owner.key:ro -e AGE_IDENTITY_FILE=/run/restore-key/owner.key \
     backup sh /opt/maintafox-backup/restore-physical.sh /backups/base/<ts> /restore-data/pgdata \
        /mfx-backup/wal-restore.sh "2026-10-12 08:30:00+00"
   ```
4. Point the postgres service at the new volume and start it **with the key**, so
   `restore_command` (`wal-restore.sh`) can decrypt the archived WAL. A one-off override file:
   ```yaml
   # restore-key.override.yml (delete after the restore)
   services:
     postgres:
       environment:
         AGE_IDENTITY_FILE: /run/restore-key/owner.key
       volumes:
         - /dev/shm/owner.key:/run/restore-key/owner.key:ro
   ```
   `docker compose -f docker-compose.yml -f restore-key.override.yml up -d postgres`.
   Postgres replays the archive, then promotes: `docker compose logs postgres` shows
   `archive recovery complete`. Without the key, recovery **stops** with
   `wal-restore: ... is encrypted: set AGE_IDENTITY_FILE ...` (it never promotes a database that
   is missing data).
5. `docker compose up -d postgres` (without the override: the key is no longer mounted),
   `shred -u /dev/shm/owner.key`, delete `restore-key.override.yml`. Start `api` and `backup`; run
   `restore-drill.sh`, and take a fresh backup.

### 4.3 The whole server is lost — from the on-premise copy

On a new server with this repository and the owner's private key: copy the on-premise folder
(`backups/` and `wal/`, §8) to the new server's `backup_data` and `pg_wal_archive` volumes, then
follow 4.1 (newest dump) or 4.2 (base backup + WAL). The `.env` secrets are not in the backups:
keep a copy of `.env` in the password manager (without `ENTITLEMENT_SIGNING_PRIVATE_KEY`,
`JWT_SECRET`, `SYNC_CHECKPOINT_SECRET` and `SYNC_PAYLOAD_ENCRYPTION_KEY` a restored server cannot
sign licences, accept the devices in the field or read the encrypted sync data).

### 4.4 Checking a backup on the owner's own computer (no server needed)

Install age (Windows: `winget install FiloSottile.age`; macOS: `brew install age`), save the key
from the password manager to a file `owner.key`, then for any downloaded `.age` file:

```sh
age --decrypt --identity owner.key --output check.dump maintafox-<ts>.dump.age
```

Success = a `check.dump` file appears (a PostgreSQL dump); delete it and `owner.key` afterwards.
A wrong key prints `no identity matched any of the recipients`.

## 5. Tests

- `pnpm --filter maintafox-control-api run test:backup-drill` — needs the PostgreSQL 16 programs
  and `age` on PATH. Real cluster with the production archive settings; real API writes data;
  plaintext backups (previous release) → switch to `required` (refused without a recipient, WAL
  too) → plaintext migrated and deleted, every file `.age`, 600/700, `SHA256SUMS` correct, stale
  plaintext in the work directory removed → restore drill with a fresh dump → encrypted dump
  restored with the key, clear errors without / with a wrong key → corrupted dump refused →
  existing database refused → tampered audit ledger detected → point-in-time recovery from the
  encrypted base backup and encrypted WAL (to the end, and to a time before the last insert) →
  without the key the base backup is refused and the server stops recovery.
- `pnpm --filter maintafox-control-api run test:backup-keygen` — `keygen.sh` with real age:
  refuses an existing key, no change without the typed confirmation, recipient saved and the
  private key wiped after it, and the printed key opens what is encrypted to the saved recipient.
- `bash deploy/backup-pull/ci-test.sh` (CI job "backup-pull") — §8.
- `pnpm --filter maintafox-control-api run test:backup-offsite` — needs an S3-compatible server
  and `age`; also checks that locally encrypted files are uploaded as they are.

## 6. Off-site copy to a provider bucket (not used)

The owner keeps backups on our own infrastructure only (decision of 2026-10-12, Algerian Law 18-07
on personal data), so `BACKUP_OFFSITE_MODE=disabled`. The S3 code path (`backup-offsite.ts`,
`BACKUP_OFFSITE_*`) stays available and tested for an S3-compatible server we would run ourselves;
it uploads only age-encrypted objects and never deletes off-site.

## 7. Encryption at rest

### 7.1 How it works

- `BACKUP_LOCAL_ENCRYPTION=required|disabled` (no default) is read by the backup container and by
  Postgres' `archive_command`. In `required` mode both refuse to run without a valid
  `BACKUP_AGE_RECIPIENT` (`age1...`): no backup is ever written unencrypted by mistake.
- age public-key encryption (X25519 + ChaCha20-Poly1305): the server holds only the **public**
  key, which can encrypt but never decrypt. A stolen disk, volume or backup file is unreadable
  without the owner's private key.
- Files are mode 600 and directories 700, owned by uid:gid `70:70` (`BACKUP_FILES_OWNER`).
- The nightly run cannot decrypt what it wrote (no key), so it proves each dump **before**
  encrypting it (scratch restore + verification), and checks each encrypted file structurally
  (age header, size). Proof that the owner's saved key opens the files is §4.4.

### 7.2 Creating the key (once, `keygen.sh`)

The command is in §3 step 2. It prints the private key **once**, asks the owner to save it in a
password manager (and a second copy on paper or USB in a safe), and asks to type the **last 6
characters of the key as saved**. Only after a matching answer does it write
`BACKUP_AGE_RECIPIENT=<public key>` into `.env` and erase the private key (it only ever existed in
memory, `/dev/shm`, and is overwritten before deletion). Without a confirmation nothing is written
and the key is discarded. It refuses to run if `.env` already has a recipient.

### 7.3 Switching it on or off

`BACKUP_LOCAL_ENCRYPTION=required` then `docker compose up -d postgres backup`; the next nightly
run encrypts the plaintext left by earlier runs (dumps, base backups, WAL) and deletes it.
`disabled` goes back to plaintext for new files (§3 rollback).

### 7.4 Replacing the key (rotation) or a lost key

- **Lost key**: every file encrypted to it is unreadable. Create a new key at once (remove the
  `BACKUP_AGE_RECIPIENT` line from `.env`, run `keygen.sh`, `docker compose up -d postgres backup`)
  and run `backup.sh` by hand: from then on backups are readable again. The old files expire with
  the retention.
- **Rotation** (key possibly exposed): same steps. Keep the old key until the last file encrypted
  to it has expired (`BACKUP_LOCAL_RETENTION_DAYS`, plus `KeepDays` on the on-premise machine).

## 8. On-premise copy (read-only pull to a machine in Algeria)

`deploy/backup-pull/README.md`: an SFTP-only, read-only, key-only account in its own container,
that sees only the encrypted backup files, and a Windows PowerShell script (Task Scheduler,
nightly) that downloads new files, verifies each SHA-256 against `SHA256SUMS` and keeps them
`KeepDays` days. The on-premise machine never holds anything readable without the owner's key.

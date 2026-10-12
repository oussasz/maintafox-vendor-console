# Object storage: Garage (tenant media, diagnostic bundles)

Why Garage and what it replaces: [`docs/deploy/OBJECT_STORAGE_DECISION.md`](../docs/deploy/OBJECT_STORAGE_DECISION.md).

## 1. What runs

| Piece | What it is |
|---|---|
| `object-store` | Garage v2.4.1 (`dxflrs/garage`, pinned by digest in `docker-compose.yml`), one node, config `deploy/object-storage/garage.toml`. S3 API on `http://object-store:3900`, **inside the compose network only** (no port on the host). |
| `object-store-check` | One-shot before the API starts (`api/src/tools/object-store-check.ts`). It checks that the bucket exists and that a presigned PUT and then a presigned GET give back the same bytes. If either fails, the API does not start. |
| Volumes | `object_store_meta` (Garage metadata, SQLite, plus 2 snapshots) and `object_store_data` (data blocks). |
| Nightly media copy | `backup` service, step `media` (`api/src/tools/media-backup.ts`). See §3. |

Settings in `.env`. All are required and none has a default.

| Variable | Value |
|---|---|
| `S3_ENDPOINT` | `http://object-store:3900` |
| `S3_REGION` | `garage` (must equal `s3_region` in `garage.toml`) |
| `S3_ACCESS_KEY` | `GK` + `openssl rand -hex 12` |
| `S3_SECRET_KEY` | `openssl rand -hex 32` |
| `S3_BUCKET` | `maintafox-tenant-media` |
| `S3_FORCE_PATH_STYLE` | `true` |
| `DEPLOYMENT_ENV` | `prod`. This is the first part of every media key: **never change it** once media exist. |
| `GARAGE_RPC_SECRET` | `openssl rand -hex 32` |
| `MEDIA_BACKUP_REMOVED_RETENTION_DAYS` | `30` |

Garage creates the key and the bucket from these values on its **first** start. On every later
start it checks them and **refuses to start** if `S3_ACCESS_KEY` or `S3_SECRET_KEY` changed. To
rotate the key, first create the new key with the `garage key` commands, then change `.env`.

## 2. Day to day

```bash
docker compose logs object-store-check        # last start: {"ok":true,...} or one FAILED line
docker compose exec object-store /garage status
docker compose exec object-store /garage bucket info maintafox-tenant-media   # objects, size
docker system df -v | grep object_store       # disk used by the volumes
```

The ops dashboard's object storage probe (`HEAD` on the bucket) shows the same thing from the API.
When the bucket is missing, the API answers `503 object_storage_bucket_missing`; when the store is
down, it answers `503 object_storage_unavailable`. It never creates an empty bucket on its own.

**Disk.** Each media file is stored twice on the VPS: once in Garage and once as an encrypted copy
in `/backups/media`. Copies of removed media are kept as well, for
`MEDIA_BACKUP_REMOVED_RETENTION_DAYS`. Keep free space of at least 3× the media size.

## 3. Protection of media (replaces MinIO versioning)

Garage keeps only the current content of each key. Every night, `backup.sh` runs
`media-backup.js backup`:

- Every object is copied to `/backups/media/current/<key>+<etag>.age`, encrypted to the owner's
  key (`BACKUP_LOCAL_ENCRYPTION=required`).
- An object that was **deleted or overwritten** since the last night has its last copy moved to
  `/backups/media/removed/<night>/` and kept `MEDIA_BACKUP_REMOVED_RETENTION_DAYS` days.
- Every copy is listed in `SHA256SUMS`, so the on-premise pull downloads it
  (`BACKUP_AND_RESTORE.md` §8).
- The run record (`backup_runs.detail`) says how many objects there are, how many were copied, and
  how many were removed or overwritten.

**Restore** needs the owner's private key, which never stays on the server. Mount it read-only for
the duration of the command:

```bash
# One night's removed copies (or media/current for everything) back into the bucket; objects
# already in the bucket are skipped unless --replace.
docker compose run --rm -v /root/owner.key:/run/owner.key:ro backup \
  node /app/api/dist/tools/media-backup.js restore \
  --source /backups/media/removed/20261012T023000Z --identity /run/owner.key
rm /root/owner.key
```

After losing the server: copy the pulled `backups/media/current` folder to the new server, mount it
(`-v /path/to/current:/restore:ro`) and run the same command with `--source /restore`.

## 4. Migration from MinIO (one time)

The copy tool is `api/src/tools/object-store-migrate.ts`, run through
`deploy/object-storage/migration.compose.yml`. It **only reads** MinIO, so the old data stays as it
was, and that is what makes rollback possible. Its `verify` step reads every object in full on both
sides and compares size and SHA-256. It writes a report to `./object-store-migration/` and fails on
any difference.

**Expected downtime: about 20–30 minutes** for a few GB. That is 15 minutes of waiting (see 4.3),
plus the last copy, a full verification (it reads everything twice) and the restart. During it,
desktops cannot sync or upload media. They keep working offline and catch up afterwards.

**Presigned URLs.** A URL issued by the old API is signed with MinIO's key and stops working once
Garage serves the bucket. The sequence below makes sure no such URL is still valid at the switch.
The API is stopped, and then we wait the full URL lifetime (15 minutes, `PRESIGNED_URL_TTL_SECONDS`)
before the last copy. After the restart, every URL a desktop receives is new. A desktop whose upload
or download failed during the window has to ask for a fresh URL (`presign-put` / `presign-get`) and
retry. **Not verified from here:** whether the desktop app retries this way on its own. If it does
not, the affected media upload again only when the desktop next syncs that record.

Commands, from the checkout directory on the VPS (`M` is a shortcut):

```bash
M="docker compose -f docker-compose.yml -f deploy/object-storage/migration.compose.yml"
```

**4.1 Prepare (no downtime).**

1. `df -h /` and `docker system df -v | grep minio`. Free space must be at least 3× the size of the
   MinIO volume.
2. `cp .env .env.before-garage-$(date +%Y%m%d)` and keep this copy until §5 is over.
3. Write down the current values:
   `docker inspect maintafox-control-api --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(S3_BUCKET|DEPLOYMENT_ENV)='`.
4. Edit `.env`:
   - Rename `MINIO_ROOT_USER` to `MIGRATE_SOURCE_S3_ACCESS_KEY` and `MINIO_ROOT_PASSWORD` to
     `MIGRATE_SOURCE_S3_SECRET_KEY`.
   - Add `MIGRATE_SOURCE_S3_ENDPOINT=http://minio:9000`, `MIGRATE_SOURCE_S3_REGION=us-east-1`, and
     `MIGRATE_SOURCE_S3_BUCKET=<the S3_BUCKET written down>`.
   - Set the §1 settings. `S3_BUCKET` and `DEPLOYMENT_ENV` must equal the values written down.
     `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `GARAGE_RPC_SECRET` are new.
   - Delete `MINIO_NONCURRENT_VERSION_RETENTION_DAYS` and add
     `MEDIA_BACKUP_REMOVED_RETENTION_DAYS=30`.
5. Get the new release, then `docker compose build api backup`. The running containers keep the
   old code.
6. `docker compose up -d object-store`. This starts Garage alone, which creates the key and the
   bucket. Then run `docker compose exec object-store /garage status`.

**4.2 Rehearsal and first copy (no downtime, MinIO still live).**

```bash
$M --profile migration run --rm object-store-migrate inventory
$M --profile migration run --rm object-store-migrate copy
$M --profile migration run --rm object-store-migrate verify --report /reports/verify-pass1.json
```

`inventory` shows MinIO's object count, its size, and how many **old versions and delete markers**
it holds. Those old versions are **not** copied, because Garage has no versions. They stay readable
in the kept MinIO volume until the end of the rollback window (§5). `verify` may list differences
here, because MinIO is still being written to. That is expected at this stage.

**4.3 Switch (downtime starts).**

```bash
docker compose stop api backup
sleep 900                     # every presigned URL issued by the old API has expired
$M --profile migration run --rm object-store-migrate copy
$M --profile migration run --rm object-store-migrate verify --report /reports/verify-final.json
```

The last line must say `"ok":true`, with `identical` equal to the MinIO object count. **If it does
not, stop here and roll back (§5.1).**

**4.4 Start on Garage.**

```bash
docker stop maintafox-minio && docker rm maintafox-minio maintafox-minio-init   # containers only, the volume stays
docker compose up -d
docker compose logs object-store-check        # {"ok":true,...}
curl -s https://api.maintafox.systems/health
docker compose exec backup sh /opt/maintafox-backup/backup.sh    # first media copy now, not tonight
```

The run record of that backup must contain `Media: <N> objects`. Keep the `object-store-migration/`
reports with the deploy notes. Downtime ends at `docker compose up -d`.

## 5. Rollback

**5.1 Before 4.4 (MinIO never stopped).**

```bash
cp .env.before-garage-YYYYMMDD .env
git checkout <previous release>
docker compose up -d --build
docker rm -f maintafox-object-store
```

Nothing was written to MinIO by the migration.

**5.2 After 4.4 (Garage served the bucket).** Media uploaded since the switch exist only in Garage:
copy them back first.

```bash
docker compose stop api backup
$M --profile rollback up -d minio-source       # old MinIO from the image cache, on its volume
$M --profile rollback run --rm object-store-migrate-back copy
$M --profile rollback run --rm object-store-migrate-back verify --report /reports/rollback-verify.json
docker rm -f maintafox-minio-source
cp .env.before-garage-YYYYMMDD .env
git checkout <previous release>
docker compose up -d --build --remove-orphans
```

`only_on_destination` in the rollback report lists objects that were deleted in Garage after the
switch but still exist in MinIO. They are reported, never deleted.

**5.3 End of the rollback window** (`MEDIA_BACKUP_REMOVED_RETENTION_DAYS` days after 4.4, once all
is well). Remove the `MIGRATE_SOURCE_*` lines from `.env`. Then remove the MinIO volume
(`docker volume rm <project>_sync_minio_data`) and the image (`docker image rm
minio/minio:RELEASE.2025-01-20T14-49-07Z minio/mc:RELEASE.2025-01-17T23-25-50Z`). Until that day,
**do not run `docker image prune -a`** (the MinIO image cannot be downloaded again), and do not
delete `sync_minio_data`.

## 6. Known limits

- **One copy on one disk.** Garage runs with `replication_factor = 1`. Protection against losing
  the disk comes from the nightly encrypted copy and the on-premise pull, not from Garage.
- **No versioning.** A change and its undo within the same day are not kept (§3).
- **Presigned URLs carry the endpoint the API is configured with** (`http://object-store:3900`,
  internal). This was already true with MinIO (`http://minio:9000`): a desktop **outside the
  server** cannot reach such a URL, and nginx does not route to the object store. Making media
  upload work from desktops needs a public S3 endpoint: a separate signing endpoint setting plus
  an nginx/TLS route. That change was not made here, and it is listed as a follow-up.

#!/bin/sh
# Nightly backup (deploy/BACKUP_AND_RESTORE.md). Run by scheduler.sh, or by hand:
#   docker compose exec backup sh /opt/maintafox-backup/backup.sh
#
# 1. pg_dump (custom format) of the database  -> $BACKUP_DIR/pg_dump/<db>-<ts>.dump (+ .sha256)
# 2. pg_basebackup (tar, gzip, WAL from the archive) -> $BACKUP_DIR/base/<ts>/
#    Together with the continuous WAL archive ($MFX_WAL_ARCHIVE_DIR, written by Postgres through
#    wal-archive.sh) this allows point-in-time recovery between nightly runs.
# 3. Local retention: dumps and base backups older than BACKUP_LOCAL_RETENTION_DAYS are deleted
#    (the newest base backup is always kept), then WAL older than the oldest kept base backup.
# 4. Off-site (BACKUP_OFFSITE_MODE=s3): dump, base backup, new WAL files, new media objects and
#    the .env file are encrypted with age and uploaded (api/src/tools/backup-offsite.ts).
#    BACKUP_OFFSITE_MODE=disabled keeps local copies only and says so in every run record.
# 5. One row in backup_runs (read by the ops metrics), whatever the outcome.
set -eu
. "$(dirname "$0")/lib.sh"

require_env BACKUP_DIR MFX_WAL_ARCHIVE_DIR MFX_API_DIR BACKUP_LOCAL_RETENTION_DAYS BACKUP_OFFSITE_MODE \
  PGHOST PGUSER PGDATABASE
require_positive_int BACKUP_LOCAL_RETENTION_DAYS "$BACKUP_LOCAL_RETENTION_DAYS"
case "$BACKUP_OFFSITE_MODE" in
  disabled | s3) ;;
  *) die "BACKUP_OFFSITE_MODE must be 'disabled' or 's3', got '$BACKUP_OFFSITE_MODE'" ;;
esac
if [ "$BACKUP_OFFSITE_MODE" = s3 ]; then
  require_env BACKUP_ENV_FILE
  [ -f "$BACKUP_ENV_FILE" ] || die "BACKUP_ENV_FILE $BACKUP_ENV_FILE does not exist"
fi

started=$(utc_now)
ts=$(date -u +%Y%m%dT%H%M%SZ)
dump_dir="$BACKUP_DIR/pg_dump"
base_dir="$BACKUP_DIR/base"
mkdir -p "$dump_dir" "$base_dir"
dump="$dump_dir/$PGDATABASE-$ts.dump"

status=failed
offsite=disabled
step=start
dump_name=
dump_bytes=
dump_sha=
summary=

finish() {
  rc=$?
  if [ "$rc" -eq 0 ]; then
    detail="$summary"
  else
    detail="failed at step '$step' (exit $rc). $summary"
  fi
  if ! record_run nightly "$status" "$offsite" "$started" "$dump_name" "$dump_bytes" "$dump_sha" "$detail"; then
    log "could not record this run in backup_runs"
    rc=1
  fi
  log "nightly backup: status=$status offsite=$offsite $detail"
  exit "$rc"
}
trap finish EXIT

step=pg_dump
log "pg_dump of $PGDATABASE -> $dump"
pg_dump --format=custom --compress=6 --file="$dump.partial" "$PGDATABASE"
mv "$dump.partial" "$dump"
dump_name=$(basename "$dump")
dump_sha=$(sha256_of "$dump")
dump_bytes=$(wc -c < "$dump" | tr -d ' ')
printf '%s  %s\n' "$dump_sha" "$dump_name" > "$dump.sha256"

step=pg_basebackup
log "base backup -> $base_dir/$ts"
pg_basebackup --pgdata="$base_dir/$ts.partial" --format=tar --gzip --wal-method=none \
  --checkpoint=fast --label="maintafox-$ts" --no-password
mv "$base_dir/$ts.partial" "$base_dir/$ts"
status=succeeded
summary="dump $dump_name ($dump_bytes bytes, sha256 $dump_sha); base backup $ts."

step=local_retention
find "$dump_dir" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.sha256' \) \
  -mtime +"$BACKUP_LOCAL_RETENTION_DAYS" -exec rm -f {} +
newest_base=$(ls -1 "$base_dir" | grep -v '\.partial$' | sort | tail -n 1)
for b in $(find "$base_dir" -mindepth 1 -maxdepth 1 -type d -mtime +"$BACKUP_LOCAL_RETENTION_DAYS" | sort); do
  [ "$(basename "$b")" = "$newest_base" ] || rm -rf "$b"
done
oldest_base=$(ls -1 "$base_dir" | grep -v '\.partial$' | sort | head -n 1)
# Through stdin: GNU tar would read "C:/..." (Git Bash on Windows) as a remote host name.
oldest_wal=$(gzip -dc "$base_dir/$oldest_base/base.tar.gz" | tar -xOf - backup_label \
  | sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p')
[ -n "$oldest_wal" ] || die "cannot read the start WAL file of base backup $oldest_base"
pg_archivecleanup -x .gz "$MFX_WAL_ARCHIVE_DIR" "$oldest_wal"
wal_files=$(find "$MFX_WAL_ARCHIVE_DIR" -maxdepth 1 -type f -name '*.gz' | wc -l | tr -d ' ')
summary="$summary Local copies kept $BACKUP_LOCAL_RETENTION_DAYS days; $wal_files WAL files archived since base backup $oldest_base."

step=offsite
if [ "$BACKUP_OFFSITE_MODE" = disabled ]; then
  summary="$summary OFF-SITE COPY DISABLED: backups exist only on this server."
  log "off-site copy is disabled (BACKUP_OFFSITE_MODE=disabled): backups exist only on this server"
else
  offsite=failed
  offsite_tool() {
    node "$MFX_API_DIR/dist/tools/backup-offsite.js" "$@"
  }
  offsite_tool push-file --file "$dump" --key "pg_dump/$dump_name"
  offsite_tool push-file --file "$dump.sha256" --key "pg_dump/$dump_name.sha256"
  offsite_tool push-dir --dir "$base_dir/$ts" --key-prefix "base/$ts"
  offsite_tool push-dir --dir "$MFX_WAL_ARCHIVE_DIR" --key-prefix wal
  offsite_tool push-media
  offsite_tool push-file --file "$BACKUP_ENV_FILE" --key "env/$ts.env"
  offsite=uploaded
  summary="$summary Off-site copy uploaded (age-encrypted)."
fi
step=done

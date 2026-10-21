#!/bin/sh
# Nightly backup (deploy/BACKUP_AND_RESTORE.md). Run by scheduler.sh, or by hand:
#   docker compose exec backup sh /opt/maintafox-backup/backup.sh
#
# Plaintext exists only in the private work directory BACKUP_WORK_DIR (its own volume, mode 700),
# emptied at the start of every run and removed at the end of it.
#
# 0. BACKUP_LOCAL_ENCRYPTION=required: plaintext backups left by earlier releases are encrypted,
#    checked, and the plaintext deleted (dumps, base backups, WAL archive).
# 1. pg_dump (custom format) of the database into the work directory.
# 2. Verified BEFORE it is stored: restored into a scratch database (mfx_nightly_verify_<ts>) and
#    checked by restore.sh (row counts against the dump, migrations, audit hash chain), then the
#    scratch database is dropped. A dump that does not restore fails the run.
# 3. Stored as $BACKUP_DIR/pg_dump/<db>-<ts>.dump.age (+ .dump.sha256.age, the plaintext SHA-256),
#    encrypted to BACKUP_AGE_RECIPIENT; or .dump + .dump.sha256 when encryption is disabled.
# 4. pg_basebackup (tar, gzip, WAL from the archive) -> $BACKUP_DIR/base/<ts>/ (*.age when
#    encrypted) + start-wal (the name of the first WAL file it needs: retention reads it without
#    the private key). Together with the continuous WAL archive ($MFX_WAL_ARCHIVE_DIR, written by
#    Postgres through wal-archive.sh) this allows point-in-time recovery between nightly runs.
# 4b. Media: every object of the tenant media bucket is copied to $BACKUP_DIR/media/current/
#    (*.age when encrypted); objects deleted or overwritten in the bucket since the last run keep
#    their copy in media/removed/<ts>/ for MEDIA_BACKUP_REMOVED_RETENTION_DAYS days
#    (api/src/tools/media-backup.ts; the object store has no versioning, this replaces it).
# 5. Local retention: dumps and base backups older than BACKUP_LOCAL_RETENTION_DAYS (by the time
#    in their name) are deleted (the newest base backup is always kept), then WAL older than the
#    oldest kept base backup.
# 6. Encrypted mode: $BACKUP_DIR/SHA256SUMS lists the SHA-256 of every encrypted file (read by the
#    read-only pull, deploy/backup-pull/). Everything is owned by BACKUP_FILES_OWNER, files 600,
#    directories 700.
# 7. Off-site (BACKUP_OFFSITE_MODE=s3): dump, base backup, new WAL files, new media objects and
#    the .env file are uploaded age-encrypted (api/src/tools/backup-offsite.ts).
#    BACKUP_OFFSITE_MODE=disabled keeps local copies only and says so in every run record.
# 8. One row in backup_runs (read by the ops metrics), whatever the outcome.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"

require_env BACKUP_DIR BACKUP_WORK_DIR BACKUP_FILES_OWNER MFX_WAL_ARCHIVE_DIR MFX_API_DIR \
  BACKUP_LOCAL_RETENTION_DAYS BACKUP_OFFSITE_MODE PGHOST PGUSER PGDATABASE MEDIA_BACKUP_REMOVED_RETENTION_DAYS
require_positive_int BACKUP_LOCAL_RETENTION_DAYS "$BACKUP_LOCAL_RETENTION_DAYS"
require_positive_int MEDIA_BACKUP_REMOVED_RETENTION_DAYS "$MEDIA_BACKUP_REMOVED_RETENTION_DAYS"
printf '%s' "$BACKUP_FILES_OWNER" | grep -Eq '^[0-9]+:[0-9]+$' \
  || die "BACKUP_FILES_OWNER must be uid:gid (numbers), got '$BACKUP_FILES_OWNER'"
case "$BACKUP_OFFSITE_MODE" in
  disabled | s3) ;;
  *) die "BACKUP_OFFSITE_MODE must be 'disabled' or 's3', got '$BACKUP_OFFSITE_MODE'" ;;
esac
if [ "$BACKUP_OFFSITE_MODE" = s3 ]; then
  require_env BACKUP_ENV_FILE
  [ -f "$BACKUP_ENV_FILE" ] || die "BACKUP_ENV_FILE $BACKUP_ENV_FILE does not exist"
fi
encrypt=no
if local_encryption_required; then encrypt=yes; fi

started=$(utc_now)
ts=$(date -u +%Y%m%dT%H%M%SZ)
dump_dir="$BACKUP_DIR/pg_dump"
base_dir="$BACKUP_DIR/base"
umask 077
reset_work_dir
work="$BACKUP_WORK_DIR/nightly-$ts"
private_dir "$BACKUP_DIR" "$dump_dir" "$base_dir" "$work"
verify_db="mfx_nightly_verify_$(date -u +%Y%m%d%H%M%S)"

status=failed
offsite=disabled
step=start
dump_name=
dump_bytes=
dump_sha=
summary=

finish() {
  rc=$?
  dropdb --if-exists --force "$verify_db" || log "could not drop scratch database $verify_db"
  rm -rf "$work"
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

# store PLAIN DEST_WITHOUT_AGE : the plaintext leaves the work directory only encrypted (or moved
# as is when encryption is disabled).
store() {
  if [ "$encrypt" = yes ]; then
    encrypt_to "$1" "$2.age"
    rm -f "$1"
  else
    mv "$1" "$2"
  fi
}

if [ "$encrypt" = yes ]; then
  step=encrypt_existing_plaintext
  migrated=0
  warnings=
  for f in "$dump_dir"/*.dump; do
    [ -f "$f" ] || continue
    if [ -f "$f.sha256" ] && [ "$(cut -d' ' -f1 "$f.sha256")" != "$(sha256_of "$f")" ]; then
      warnings="$warnings $(basename "$f") did not match its .sha256 (encrypted anyway, as found)."
    fi
    encrypt_to "$f" "$f.age"
    if [ -f "$f.sha256" ]; then
      encrypt_to "$f.sha256" "$f.sha256.age"
    fi
    rm -f "$f" "$f.sha256"
    migrated=$((migrated + 1))
  done
  for b in "$base_dir"/*; do
    [ -d "$b" ] || continue
    case "$b" in *.partial) continue ;; esac
    if [ -f "$b/base.tar.gz" ] && [ ! -f "$b/start-wal" ]; then
      start=$(base_start_wal_from_tar "$b/base.tar.gz")
      [ -n "$start" ] || die "cannot read the start WAL file of base backup $(basename "$b")"
      printf '%s\n' "$start" > "$b/start-wal"
    fi
    for f in "$b"/*; do
      case "$f" in *.age | */start-wal) continue ;; esac
      [ -f "$f" ] || continue
      encrypt_to "$f" "$f.age"
      rm -f "$f"
      migrated=$((migrated + 1))
    done
  done
  for f in "$MFX_WAL_ARCHIVE_DIR"/*.gz; do
    [ -f "$f" ] || continue
    # The SHA-256 of the original segment, for wal-archive.sh's retry check.
    printf '%s  %s\n' "$(gzip -dc "$f" | sha256sum | cut -d' ' -f1)" "$(basename "$f" .gz)" > "$f.age.sha256"
    encrypt_to "$f" "$f.age"
    rm -f "$f"
    migrated=$((migrated + 1))
  done
  if [ "$migrated" -gt 0 ]; then
    summary="Encrypted $migrated plaintext backup files left by an earlier release and deleted the plaintext.$warnings"
    log "$summary"
  fi
fi

step=pg_dump
plain_dump="$work/$PGDATABASE-$ts.dump"
log "pg_dump of $PGDATABASE (work directory)"
pg_dump --format=custom --compress=6 --file="$plain_dump" "$PGDATABASE"
dump_sha=$(sha256_of "$plain_dump")
dump_bytes=$(wc -c < "$plain_dump" | tr -d ' ')

step=verify_restore
log "verifying the dump: restore into scratch database $verify_db"
sh "$here/restore.sh" "$plain_dump" "$verify_db" > "$work/verify.json"
dropdb --force "$verify_db"
verified_tables=$(grep -o '"table"' "$work/verify.json" | wc -l | tr -d ' ')

step=store_dump
printf '%s  %s\n' "$dump_sha" "$PGDATABASE-$ts.dump" > "$work/$PGDATABASE-$ts.dump.sha256"
store "$plain_dump" "$dump_dir/$PGDATABASE-$ts.dump"
store "$work/$PGDATABASE-$ts.dump.sha256" "$dump_dir/$PGDATABASE-$ts.dump.sha256"
if [ "$encrypt" = yes ]; then
  dump_name="$PGDATABASE-$ts.dump.age"
  sums_name="$PGDATABASE-$ts.dump.sha256.age"
else
  dump_name="$PGDATABASE-$ts.dump"
  sums_name="$PGDATABASE-$ts.dump.sha256"
fi

step=pg_basebackup
log "base backup $ts (work directory)"
pg_basebackup --pgdata="$work/base" --format=tar --gzip --wal-method=none \
  --checkpoint=fast --label="maintafox-$ts" --no-password
start=$(base_start_wal_from_tar "$work/base/base.tar.gz")
[ -n "$start" ] || die "cannot read the start WAL file of the new base backup"
private_dir "$base_dir/$ts.partial"
printf '%s\n' "$start" > "$base_dir/$ts.partial/start-wal"
for f in "$work/base"/*; do
  store "$f" "$base_dir/$ts.partial/$(basename "$f")"
done
mv "$base_dir/$ts.partial" "$base_dir/$ts"

step=media
log "media copy: tenant media bucket -> $BACKUP_DIR/media"
# A failed media copy (object store down, ...) must not cost the database its retention, its
# SHA256SUMS entry and its off-site copy: it is recorded, the database steps go on, and the run is
# marked failed at the end.
media_failed=
if media_json=$(node "$MFX_API_DIR/dist/tools/media-backup.js" backup --run-ts "$ts"); then
  media_field() {
    printf '%s' "$media_json" | sed -n "s/.*\"$1\":\([0-9]*\).*/\1/p"
  }
  media_summary="Media: $(media_field objects) objects ($(media_field bytes) bytes) in the bucket, $(media_field copied) newly copied into the backups; $(media_field removed) deleted and $(media_field superseded) overwritten objects kept $MEDIA_BACKUP_REMOVED_RETENTION_DAYS days."
else
  media_failed=$?
  media_summary="MEDIA COPY FAILED (exit $media_failed): no media copied tonight; the database backup went on."
  log "media copy failed (exit $media_failed); continuing with the database steps"
fi
status=succeeded
if [ "$encrypt" = yes ]; then
  at_rest="encrypted at rest (age)"
else
  at_rest="NOT ENCRYPTED at rest (BACKUP_LOCAL_ENCRYPTION=disabled)"
fi
summary="${summary:+$summary }Dump $dump_name ($dump_bytes bytes, sha256 $dump_sha) restored into a scratch database and verified ($verified_tables tables) before it was stored; base backup $ts; $at_rest. $media_summary"

step=local_retention
cutoff=$(ts_number "$(date -u -d "@$(($(date -u +%s) - BACKUP_LOCAL_RETENTION_DAYS * 86400))" +%Y%m%dT%H%M%SZ)")
for f in "$dump_dir"/*; do
  [ -f "$f" ] || continue
  fts=$(basename "$f" | sed -n 's/.*-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump.*$/\1/p')
  if [ -n "$fts" ] && [ "$(ts_number "$fts")" -lt "$cutoff" ]; then rm -f "$f"; fi
done
bases=$(find "$base_dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' | sed 's|.*/||' | sort)
newest_base=$(printf '%s\n' "$bases" | tail -n 1)
for b in $bases; do
  if [ "$b" != "$newest_base" ] && [ "$(ts_number "$b")" -lt "$cutoff" ]; then rm -rf "${base_dir:?}/$b"; fi
done
oldest_base=$(find "$base_dir" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T[0-9]*Z' | sed 's|.*/||' | sort | head -n 1)
if [ -f "$base_dir/$oldest_base/start-wal" ]; then
  oldest_wal=$(cat "$base_dir/$oldest_base/start-wal")
else
  oldest_wal=$(base_start_wal_from_tar "$base_dir/$oldest_base/base.tar.gz")
fi
printf '%s' "$oldest_wal" | grep -Eq '^[0-9A-F]{24}$' || die "cannot read the start WAL file of base backup $oldest_base"
# Both forms: encrypted (.gz.age) and plaintext from before encryption was enabled.
pg_archivecleanup -x .gz.age "$MFX_WAL_ARCHIVE_DIR" "$oldest_wal"
pg_archivecleanup -x .gz "$MFX_WAL_ARCHIVE_DIR" "$oldest_wal"
for s in "$MFX_WAL_ARCHIVE_DIR"/*.gz.age.sha256; do
  [ -f "$s" ] || continue
  [ -f "${s%.sha256}" ] || rm -f "$s"
done
wal_files=$(find "$MFX_WAL_ARCHIVE_DIR" -maxdepth 1 -type f \( -name '*.gz' -o -name '*.gz.age' \) | wc -l | tr -d ' ')
summary="$summary Local copies kept $BACKUP_LOCAL_RETENTION_DAYS days; $wal_files WAL files archived since base backup $oldest_base."

step=permissions
if [ "$encrypt" = yes ]; then
  # SHA-256 of every encrypted file as the pull client sees it (backups/... and wal/...). Files
  # never change once written, so known hashes are reused from the previous manifest.
  manifest="$BACKUP_DIR/SHA256SUMS"
  previous="$work/previous-sums"
  if [ -f "$manifest" ]; then cp "$manifest" "$previous"; else : > "$previous"; fi
  {
    (cd "$BACKUP_DIR" && find pg_dump base media -type f -name '*.age' | sed 's|^|backups/|')
    (cd "$MFX_WAL_ARCHIVE_DIR" && find . -maxdepth 1 -type f -name '*.age' | sed 's|^\./|wal/|')
  } | sort > "$work/files"
  # FILENAME, not NR == FNR: the previous manifest is empty on the first run.
  awk -v prev="$previous" \
    'FILENAME == prev { known[$2] = $1; next } ($1 in known) { print known[$1] "  " $1; next } { print "?  " $1 }' \
    "$previous" "$work/files" > "$work/sums"
  while read -r hash rel; do
    if [ "$hash" = "?" ]; then
      case "$rel" in
        backups/*) hash=$(sha256_of "$BACKUP_DIR/${rel#backups/}") ;;
        wal/*) hash=$(sha256_of "$MFX_WAL_ARCHIVE_DIR/${rel#wal/}") ;;
      esac
    fi
    printf '%s  %s\n' "$hash" "$rel"
  done < "$work/sums" > "$manifest.partial"
  [ "$(wc -l < "$manifest.partial" | tr -d ' ')" = "$(wc -l < "$work/files" | tr -d ' ')" ] \
    || die "SHA256SUMS does not list every encrypted file"
  mv "$manifest.partial" "$manifest"
fi
own_private "$BACKUP_FILES_OWNER" "$BACKUP_DIR" "$MFX_WAL_ARCHIVE_DIR"

step=offsite
if [ "$BACKUP_OFFSITE_MODE" = disabled ]; then
  summary="$summary OFF-SITE COPY DISABLED: backups exist only on this server."
  log "off-site copy is disabled (BACKUP_OFFSITE_MODE=disabled): backups exist only on this server"
else
  offsite=failed
  offsite_tool() {
    node "$MFX_API_DIR/dist/tools/backup-offsite.js" "$@"
  }
  # Files already encrypted here (*.age) are uploaded as they are (same recipient).
  offsite_tool push-file --file "$dump_dir/$dump_name" --key "pg_dump/$PGDATABASE-$ts.dump"
  offsite_tool push-file --file "$dump_dir/$sums_name" --key "pg_dump/$PGDATABASE-$ts.dump.sha256"
  offsite_tool push-dir --dir "$base_dir/$ts" --key-prefix "base/$ts"
  offsite_tool push-dir --dir "$MFX_WAL_ARCHIVE_DIR" --key-prefix wal
  offsite_tool push-file --file "$BACKUP_ENV_FILE" --key "env/$ts.env"
  if [ -z "$media_failed" ]; then
    offsite_tool push-media
    summary="$summary Off-site copy uploaded (age-encrypted)."
  else
    summary="$summary Off-site copy uploaded (age-encrypted) without media (the media copy failed)."
  fi
  offsite=uploaded
fi
if [ -n "$media_failed" ]; then
  # Everything else is stored; the run is still a failure so the dashboard and alerts show it.
  status=failed
  step=media
  exit "$media_failed"
fi
step=done

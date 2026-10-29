#!/bin/sh
# Restore drill (monthly from scheduler.sh, or by hand):
#   docker compose exec backup sh /opt/maintafox-backup/restore-drill.sh
# The stored backups are encrypted to the owner's key, which is not on this server; so the drill
# proves the restore path with a FRESH dump instead: pg_dump into the private work directory,
# restore into a scratch database (mfx_restore_drill_<ts>) and verify it with restore.sh (row
# counts, migrations, audit chain), then drop the scratch database, delete the plaintext dump, and
# record the result in backup_runs (kind 'restore_drill'). Restoring a stored encrypted backup
# needs the owner's key: deploy/BACKUP_AND_RESTORE.md §4.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"

require_env BACKUP_WORK_DIR MFX_API_DIR PGHOST PGUSER PGDATABASE

started=$(utc_now)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="mfx_restore_drill_$(date -u +%Y%m%d%H%M%S)"
umask 077
reset_work_dir
work="$BACKUP_WORK_DIR/drill-$stamp"
private_dir "$work"
status=failed
dump_name=
dump_bytes=
dump_sha=
report=

finish() {
  rc=$?
  dropdb --if-exists --force "$target" || log "could not drop scratch database $target"
  rm -rf "$work"
  if [ "$rc" -eq 0 ]; then
    detail="took a fresh dump $dump_name, restored it into a scratch database and verified it, then discarded both: $report"
  else
    detail="restore drill FAILED (exit $rc) for ${dump_name:-no dump}: $report"
  fi
  if ! record_run restore_drill "$status" not_applicable "$started" "$dump_name" "$dump_bytes" "$dump_sha" "$detail"; then
    log "could not record this drill in backup_runs"
    rc=1
  fi
  log "restore drill: status=$status"
  exit "$rc"
}
trap finish EXIT

dump="$work/$PGDATABASE-$stamp.dump"
log "restore drill: fresh pg_dump of $PGDATABASE (work directory)"
pg_dump --format=custom --compress=6 --file="$dump" "$PGDATABASE"
dump_name=$(basename "$dump")
dump_bytes=$(wc -c < "$dump" | tr -d ' ')
dump_sha=$(sha256_of "$dump")

log "restore drill with $dump_name into $target"
out="$work/report.json"
if sh "$here/restore.sh" "$dump" "$target" > "$out"; then
  status=succeeded
fi
# Stored on one line in backup_runs.detail; the full report is also printed to the log.
report=$(tr -d '\n' < "$out" | sed 's/  */ /g')
cat "$out"
[ "$status" = succeeded ]

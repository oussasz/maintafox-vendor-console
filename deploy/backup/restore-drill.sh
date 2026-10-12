#!/bin/sh
# Restore drill (monthly from scheduler.sh, or by hand):
#   docker compose exec backup sh /opt/maintafox-backup/restore-drill.sh
# Restores the newest local dump into a scratch database (mfx_restore_drill_<ts>) on the same
# server, verifies it with restore.sh (row counts, migrations, audit chain), drops the scratch
# database again, and records the result in backup_runs (kind 'restore_drill').
set -eu
. "$(dirname "$0")/lib.sh"

require_env BACKUP_DIR MFX_API_DIR PGHOST PGUSER PGDATABASE

started=$(utc_now)
target="mfx_restore_drill_$(date -u +%Y%m%d%H%M%S)"
status=failed
dump_name=
dump_bytes=
dump_sha=
report=

finish() {
  rc=$?
  dropdb --if-exists --force "$target" || log "could not drop scratch database $target"
  if [ "$rc" -eq 0 ]; then
    detail="restored $dump_name into a scratch database and verified it: $report"
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

dump=$(find "$BACKUP_DIR/pg_dump" -maxdepth 1 -type f -name '*.dump' 2>/dev/null | sort | tail -n 1)
[ -n "$dump" ] || die "no dump in $BACKUP_DIR/pg_dump to drill with"
dump_name=$(basename "$dump")
dump_bytes=$(wc -c < "$dump" | tr -d ' ')
dump_sha=$(sha256_of "$dump")

log "restore drill with $dump_name into $target"
out=$(mktemp)
if sh "$(dirname "$0")/restore.sh" "$dump" "$target" > "$out"; then
  status=succeeded
fi
# Stored on one line in backup_runs.detail; the full report is also printed to the log.
report=$(tr -d '\n' < "$out" | sed 's/  */ /g')
cat "$out"
rm -f "$out"
[ "$status" = succeeded ]

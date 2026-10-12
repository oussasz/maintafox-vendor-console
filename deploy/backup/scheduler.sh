#!/bin/sh
# Entry point of the backup container: runs backup.sh every day at BACKUP_DAILY_AT_UTC (HH:MM,
# UTC) and restore-drill.sh after the backup on day BACKUP_DRILL_DAY_OF_MONTH of each month.
# A failed run is logged and recorded in backup_runs; the scheduler keeps going.
set -eu
here=$(dirname "$0")
. "$here/lib.sh"

require_env BACKUP_DAILY_AT_UTC BACKUP_DRILL_DAY_OF_MONTH
printf '%s' "$BACKUP_DAILY_AT_UTC" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' \
  || die "BACKUP_DAILY_AT_UTC must be HH:MM (UTC), got '$BACKUP_DAILY_AT_UTC'"
require_positive_int BACKUP_DRILL_DAY_OF_MONTH "$BACKUP_DRILL_DAY_OF_MONTH"
[ "$BACKUP_DRILL_DAY_OF_MONTH" -le 28 ] || die "BACKUP_DRILL_DAY_OF_MONTH must be 1..28 (every month has it)"

trap 'log "scheduler stopping"; exit 0' TERM INT
log "scheduler started: nightly backup at $BACKUP_DAILY_AT_UTC UTC, restore drill on day $BACKUP_DRILL_DAY_OF_MONTH of each month"

while :; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_DAILY_AT_UTC" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  log "next backup in $((next - now)) s"
  # Background sleep + wait so a stop signal is handled at once.
  sleep $((next - now)) &
  wait $!
  sh "$here/backup.sh" || log "nightly backup failed (recorded in backup_runs)"
  if [ "$(date -u +%d | sed 's/^0//')" -eq "$BACKUP_DRILL_DAY_OF_MONTH" ]; then
    sh "$here/restore-drill.sh" || log "restore drill failed (recorded in backup_runs)"
  fi
done

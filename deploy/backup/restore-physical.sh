#!/bin/sh
# Prepares a Postgres data directory from a base backup plus the WAL archive, for a
# point-in-time recovery (deploy/BACKUP_AND_RESTORE.md, "Disaster: the database volume is lost"):
#
#   sh restore-physical.sh <base backup dir> <new data dir> <wal-restore.sh path as the server sees it> \
#      [recovery target time, e.g. "2026-10-12 08:30:00+00"]
#
# The new data directory must not exist (or be empty). Start Postgres on it with
# MFX_WAL_ARCHIVE_DIR pointing at the WAL archive: it replays the archived WAL up to the target
# time (or to the end of the archive), then promotes and accepts connections.
set -eu
. "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] || [ $# -eq 4 ] || die "usage: restore-physical.sh <base backup dir> <new data dir> <wal-restore.sh path> [target time]"
base=$1
pgdata=$2
restore_script=$3
target_time=${4:-}

[ -f "$base/base.tar.gz" ] || die "$base/base.tar.gz not found (expected a pg_basebackup --format=tar --gzip directory)"
if [ -d "$pgdata" ] && [ -n "$(ls -A "$pgdata")" ]; then
  die "$pgdata is not empty: refusing to overwrite a data directory"
fi
mkdir -p "$pgdata"
# Through stdin: GNU tar would read "C:/..." (Git Bash on Windows) as a remote host name.
gzip -dc "$base/base.tar.gz" | tar -xf - -C "$pgdata"
chmod 700 "$pgdata"
touch "$pgdata/recovery.signal"
{
  echo ""
  echo "# Added by restore-physical.sh: replay the WAL archive, then promote."
  echo "restore_command = 'sh \"$restore_script\" \"%f\" \"%p\"'"
  echo "recovery_target_action = 'promote'"
  if [ -n "$target_time" ]; then
    echo "recovery_target_time = '$target_time'"
  fi
} >> "$pgdata/postgresql.auto.conf"
log "data directory $pgdata prepared from $(basename "$base")${target_time:+, recovery target $target_time}"

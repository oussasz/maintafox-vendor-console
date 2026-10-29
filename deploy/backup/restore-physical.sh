#!/bin/sh
# Prepares a Postgres data directory from a base backup plus the WAL archive, for a
# point-in-time recovery (deploy/BACKUP_AND_RESTORE.md, "Disaster: the database volume is lost"):
#
#   sh restore-physical.sh <base backup dir> <new data dir> <wal-restore.sh path as the server sees it> \
#      [recovery target time, e.g. "2026-10-12 08:30:00+00"]
#
# An encrypted base backup (base.tar.gz.age) is decrypted with the owner's private key
# (AGE_IDENTITY_FILE, mounted only for the restore). The new data directory must not exist (or be
# empty). Start Postgres on it with MFX_WAL_ARCHIVE_DIR pointing at the WAL archive and, when the
# archive is encrypted, AGE_IDENTITY_FILE in the server environment too (wal-restore.sh): it
# replays the archived WAL up to the target time (or to the end of the archive), then promotes and
# accepts connections.
set -eu
. "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] || [ $# -eq 4 ] || die "usage: restore-physical.sh <base backup dir> <new data dir> <wal-restore.sh path> [target time]"
base=$1
pgdata=$2
restore_script=$3
target_time=${4:-}

if [ -f "$base/base.tar.gz.age" ]; then
  [ -n "${AGE_IDENTITY_FILE:-}" ] \
    || die "$base is encrypted: set AGE_IDENTITY_FILE to the file holding the owner's private key (AGE-SECRET-KEY-1...). It is not on this server by design; see deploy/BACKUP_AND_RESTORE.md §4.2."
  [ -r "$AGE_IDENTITY_FILE" ] || die "AGE_IDENTITY_FILE $AGE_IDENTITY_FILE does not exist or is not readable"
elif [ ! -f "$base/base.tar.gz" ]; then
  die "$base/base.tar.gz(.age) not found (expected a pg_basebackup --format=tar --gzip directory)"
fi
if [ -d "$pgdata" ] && [ -n "$(ls -A "$pgdata")" ]; then
  die "$pgdata is not empty: refusing to overwrite a data directory"
fi
mkdir -p "$pgdata"
chmod 700 "$pgdata"
# Through stdin: GNU tar would read "C:/..." (Git Bash on Windows) as a remote host name.
if [ -f "$base/base.tar.gz.age" ]; then
  # POSIX sh has no pipefail: age's exit status is written to a file outside the data directory.
  status_file=$(mktemp)
  extracted=yes
  (age --decrypt --identity "$AGE_IDENTITY_FILE" "$base/base.tar.gz.age"; echo $? > "$status_file") \
    | gzip -dc | tar -xf - -C "$pgdata" || extracted=no
  age_status=$(cat "$status_file")
  rm -f "$status_file"
  [ "$age_status" = 0 ] \
    || die "cannot decrypt $base/base.tar.gz.age with AGE_IDENTITY_FILE=$AGE_IDENTITY_FILE: it is not the private key these backups were encrypted to"
  [ "$extracted" = yes ] || die "extracting the decrypted base backup into $pgdata failed"
else
  gzip -dc "$base/base.tar.gz" | tar -xf - -C "$pgdata"
fi
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

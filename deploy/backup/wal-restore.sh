#!/bin/sh
# Postgres restore_command during point-in-time recovery (written by restore-physical.sh):
#   restore_command = 'sh <path>/wal-restore.sh "%f" "%p"'
# Exit 1 when the file is not in the archive: Postgres treats that as the end of the archived WAL,
# which is the normal way recovery finishes.
#
# Encrypted segments (<name>.gz.age) need the owner's private key, mounted only for the restore:
# AGE_IDENTITY_FILE in the server's environment (deploy/BACKUP_AND_RESTORE.md §4.2). A missing key
# or a failed decryption exits 255: Postgres treats an exit status above 125 as fatal and stops the
# recovery, instead of mistaking it for the end of the archive and promoting a database that is
# missing data.
set -eu

name=$1
dest=$2
dir=${MFX_WAL_ARCHIVE_DIR:?MFX_WAL_ARCHIVE_DIR must be set for the postgres server}

fatal() {
  echo "wal-restore: $*" >&2
  exit 255
}

if [ -f "$dir/$name.gz.age" ]; then
  [ -n "${AGE_IDENTITY_FILE:-}" ] \
    || fatal "$name is encrypted: set AGE_IDENTITY_FILE (the owner's private key file) in the server environment for the restore"
  [ -r "$AGE_IDENTITY_FILE" ] || fatal "AGE_IDENTITY_FILE $AGE_IDENTITY_FILE is not readable by the server"
  age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$dest.gz" "$dir/$name.gz.age" \
    || fatal "cannot decrypt $name.gz.age with $AGE_IDENTITY_FILE (wrong key?)"
  gzip -dc "$dest.gz" > "$dest" || fatal "$name.gz.age does not contain a valid gzip stream"
  rm -f "$dest.gz"
  exit 0
fi

[ -f "$dir/$name.gz" ] || exit 1
gzip -dc "$dir/$name.gz" > "$dest"

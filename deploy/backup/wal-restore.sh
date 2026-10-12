#!/bin/sh
# Postgres restore_command during point-in-time recovery (written by restore-physical.sh):
#   restore_command = 'sh <path>/wal-restore.sh "%f" "%p"'
# Exits non-zero when the file is not in the archive: Postgres treats that as the end of the
# archived WAL, which is the normal way recovery finishes.
set -eu

name=$1
dest=$2
dir=${MFX_WAL_ARCHIVE_DIR:?MFX_WAL_ARCHIVE_DIR must be set for the postgres server}
src="$dir/$name.gz"

[ -f "$src" ] || exit 1
gzip -dc "$src" > "$dest"

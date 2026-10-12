#!/bin/sh
# Postgres archive_command (docker-compose.yml):
#   archive_command = 'sh /mfx-backup/wal-archive.sh "%p" "%f"'
# Copies one finished WAL segment (or .history / .backup file) into $MFX_WAL_ARCHIVE_DIR, gzip-
# compressed, atomically (temp file + rename). Exit 0 only when the file is safely archived:
# Postgres keeps the segment and retries otherwise.
set -eu

src=$1
name=$2
dir=${MFX_WAL_ARCHIVE_DIR:?MFX_WAL_ARCHIVE_DIR must be set for the postgres server}
dest="$dir/$name.gz"

if [ -f "$dest" ]; then
  # A retry after a crash between our rename and Postgres' own bookkeeping: identical content is
  # already archived. Different content must never be overwritten.
  if gzip -dc "$dest" | cmp -s - "$src"; then
    exit 0
  fi
  echo "wal-archive: $dest already exists with different content" >&2
  exit 1
fi

gzip -c "$src" > "$dest.tmp"
# Flush to disk before the rename makes the file visible as archived.
sync
mv "$dest.tmp" "$dest"

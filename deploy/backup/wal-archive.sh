#!/bin/sh
# Postgres archive_command (docker-compose.yml):
#   archive_command = 'sh /mfx-backup/wal-archive.sh "%p" "%f"'
# Copies one finished WAL segment (or .history / .backup file) into $MFX_WAL_ARCHIVE_DIR, gzip-
# compressed, atomically (temp file + rename). Exit 0 only when the file is safely archived:
# Postgres keeps the segment and retries otherwise.
#
# BACKUP_LOCAL_ENCRYPTION (server environment, no default):
#   required -> <name>.gz.age, gzip piped straight into age (BACKUP_AGE_RECIPIENT): the WAL never
#               exists unencrypted in the archive. <name>.gz.age.sha256 holds the SHA-256 of the
#               original segment, so a retry can be recognised without the private key.
#   disabled -> <name>.gz (plaintext), as before.
set -eu
umask 077

src=$1
name=$2
dir=${MFX_WAL_ARCHIVE_DIR:?MFX_WAL_ARCHIVE_DIR must be set for the postgres server}
mode=${BACKUP_LOCAL_ENCRYPTION:?BACKUP_LOCAL_ENCRYPTION must be set for the postgres server (required or disabled)}
plain="$dir/$name.gz"
sealed="$dir/$name.gz.age"

fail() {
  echo "wal-archive: $*" >&2
  exit 1
}

# A retry after a crash between our rename and Postgres' own bookkeeping: identical content is
# already archived (in either form). Different content must never be overwritten.
if [ -f "$plain" ]; then
  gzip -dc "$plain" | cmp -s - "$src" && exit 0
  fail "$plain already exists with different content"
fi
if [ -f "$sealed" ]; then
  sha=$(sha256sum < "$src" | cut -d' ' -f1)
  [ -f "$sealed.sha256" ] && [ "$(cut -d' ' -f1 "$sealed.sha256")" = "$sha" ] && exit 0
  fail "$sealed already exists with different or unknown content"
fi

case "$mode" in
  disabled)
    gzip -c "$src" > "$plain.tmp"
    # Flush to disk before the rename makes the file visible as archived.
    sync
    mv "$plain.tmp" "$plain"
    ;;
  required)
    recipient=${BACKUP_AGE_RECIPIENT:-}
    printf '%s' "$recipient" | grep -Eq '^age1[0-9a-z]{58}$' \
      || fail "BACKUP_LOCAL_ENCRYPTION=required but BACKUP_AGE_RECIPIENT is not an age public key: refusing to archive unencrypted WAL"
    sha=$(sha256sum < "$src" | cut -d' ' -f1)
    # POSIX sh has no pipefail: gzip's exit status is written to a file next to the output.
    (gzip -c "$src"; echo $? > "$sealed.gzip-status") | age --encrypt --recipient "$recipient" --output "$sealed.tmp"
    [ "$(cat "$sealed.gzip-status")" = 0 ] || fail "gzip of $src failed"
    rm -f "$sealed.gzip-status"
    [ "$(head -c 21 "$sealed.tmp")" = "age-encryption.org/v1" ] || fail "age produced no encrypted file for $name"
    printf '%s  %s\n' "$sha" "$name" > "$sealed.sha256.tmp"
    sync
    mv "$sealed.sha256.tmp" "$sealed.sha256"
    mv "$sealed.tmp" "$sealed"
    ;;
  *)
    fail "BACKUP_LOCAL_ENCRYPTION must be 'required' or 'disabled', got '$mode'"
    ;;
esac

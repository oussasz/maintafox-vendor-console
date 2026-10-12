#!/bin/sh
# Restores one pg_dump file into a NEW database and verifies it (deploy/BACKUP_AND_RESTORE.md):
#   sh restore.sh <dump file (.dump, or .dump.age: encrypted locally or off-site)> <new database name>
#
# - An .age file is decrypted first with the owner's private key (AGE_IDENTITY_FILE), which is
#   never kept on the server: mount it only for the restore (deploy/BACKUP_AND_RESTORE.md §4).
#   The decrypted dump lives in a private directory under BACKUP_WORK_DIR, removed on exit.
# - The dump's .sha256 file (.sha256.age when encrypted), when present next to it, must match.
# - The target database must not exist: this script never overwrites a database.
# - After pg_restore, verify-restored-database checks every table's row count against the counts
#   read from the dump itself, the schema migrations, and the audit hash chain. Exit 0 only if all
#   pass; the JSON report is printed on stdout.
set -eu
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: restore.sh <dump file> <new database name>"
src=$1
target=$2
require_env MFX_API_DIR BACKUP_WORK_DIR PGHOST PGUSER
[ -f "$src" ] || die "dump file $src does not exist"
printf '%s' "$target" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' \
  || die "database name '$target' must match [a-z_][a-z0-9_]* (max 63 chars)"

private_dir "$BACKUP_WORK_DIR"
work=$(mktemp -d "$BACKUP_WORK_DIR/restore.XXXXXX")
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

# decrypt SRC OUT : with the owner's key, or a clear refusal.
decrypt() {
  age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$2" "$1" \
    || die "cannot decrypt $1 with AGE_IDENTITY_FILE=$AGE_IDENTITY_FILE: it is not the private key these backups were encrypted to"
}

dump=$src
case "$src" in
  *.age)
    [ -n "${AGE_IDENTITY_FILE:-}" ] \
      || die "$src is encrypted: set AGE_IDENTITY_FILE to the file holding the owner's private key (AGE-SECRET-KEY-1...). It is not on this server by design; see deploy/BACKUP_AND_RESTORE.md §4."
    [ -r "$AGE_IDENTITY_FILE" ] || die "AGE_IDENTITY_FILE $AGE_IDENTITY_FILE does not exist or is not readable"
    dump="$work/$(basename "$src" .age)"
    log "decrypting $src"
    decrypt "$src" "$dump"
    sums="${src%.age}.sha256.age"
    if [ -f "$sums" ]; then
      decrypt "$sums" "$work/expected.sha256"
    fi
    ;;
  *)
    if [ -f "$src.sha256" ]; then
      cp "$src.sha256" "$work/expected.sha256"
    fi
    ;;
esac
if [ -f "$work/expected.sha256" ]; then
  expected=$(cut -d' ' -f1 "$work/expected.sha256")
  actual=$(sha256_of "$dump")
  [ "$expected" = "$actual" ] || die "checksum mismatch: dump is $actual, its .sha256 file says $expected"
  log "checksum ok ($actual)"
else
  log "no .sha256 file next to the dump: checksum not checked"
fi

dump_row_counts "$dump" > "$work/expected-counts"
[ -s "$work/expected-counts" ] || die "no table data found in $dump"

exists=$(psql --no-psqlrc -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")
[ -z "$exists" ] || die "database $target already exists; choose a new name (this script never overwrites)"

# The API runs every transaction as the role mfx_app (migration 007). Roles are not part of a
# dump: create it on this server when it is missing, so the dump's GRANTs to it restore.
psql --no-psqlrc -v ON_ERROR_STOP=1 -d postgres -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfx_app') THEN
    CREATE ROLE mfx_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;
SQL

log "creating database $target and restoring $(basename "$src")"
createdb "$target"
pg_restore --dbname="$target" --no-owner --exit-on-error --single-transaction "$dump"

log "verifying $target"
node "$MFX_API_DIR/dist/tools/verify-restored-database.js" --database "$target" \
  --expected-counts "$work/expected-counts"

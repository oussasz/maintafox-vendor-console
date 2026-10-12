#!/bin/sh
# Restores one pg_dump file into a NEW database and verifies it (deploy/BACKUP_AND_RESTORE.md):
#   sh restore.sh <dump file (.dump, or .dump.age from off-site)> <new database name>
#
# - An .age file is decrypted first with the owner's private key (AGE_IDENTITY_FILE).
# - The dump's .sha256 file, when present next to it, must match.
# - The target database must not exist: this script never overwrites a database.
# - After pg_restore, verify-restored-database checks every table's row count against the counts
#   read from the dump itself, the schema migrations, and the audit hash chain. Exit 0 only if all
#   pass; the JSON report is printed on stdout.
set -eu
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: restore.sh <dump file> <new database name>"
src=$1
target=$2
require_env MFX_API_DIR PGHOST PGUSER
[ -f "$src" ] || die "dump file $src does not exist"
printf '%s' "$target" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$' \
  || die "database name '$target' must match [a-z_][a-z0-9_]* (max 63 chars)"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

dump=$src
case "$src" in
  *.age)
    require_env AGE_IDENTITY_FILE
    dump="$work/$(basename "$src" .age)"
    log "decrypting $src"
    age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$dump" "$src"
    sums="${src%.age}.sha256.age"
    if [ -f "$sums" ]; then
      age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$work/expected.sha256" "$sums"
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

log "creating database $target and restoring $(basename "$src")"
createdb "$target"
pg_restore --dbname="$target" --no-owner --no-privileges --exit-on-error --single-transaction "$dump"

log "verifying $target"
node "$MFX_API_DIR/dist/tools/verify-restored-database.js" --database "$target" \
  --expected-counts "$work/expected-counts"

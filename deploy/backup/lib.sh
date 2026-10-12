# Shared helpers for the backup scripts (POSIX sh: busybox ash in the container, Git Bash on Windows).
# Sourced, not executed.

log() {
  printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

# require_env NAME... : every variable must be set and non-empty (no hidden defaults).
require_env() {
  for name in "$@"; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || die "environment variable $name is required (see deploy/BACKUP_AND_RESTORE.md)"
  done
}

require_positive_int() {
  case "$2" in
    '' | *[!0-9]*) die "$1 must be a positive integer, got '$2'" ;;
  esac
  [ "$2" -ge 1 ] || die "$1 must be >= 1, got '$2'"
}

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# From stdin: with a file name argument GNU sha256sum prefixes '\' when the name has a backslash.
sha256_of() {
  sha256sum < "$1" | cut -d' ' -f1
}

# record_run KIND STATUS OFFSITE_STATUS STARTED_AT DUMP_FILE DUMP_BYTES DUMP_SHA256 DETAIL
# Appends one row to backup_runs in the live database (PG* variables). Empty dump fields = NULL.
record_run() {
  psql --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -v kind="$1" -v status="$2" -v offsite="$3" -v started="$4" \
    -v dump_file="$5" -v dump_bytes="$6" -v dump_sha="$7" -v detail="$8" <<'SQL'
INSERT INTO backup_runs (kind, status, offsite_status, started_at, finished_at, dump_file, dump_bytes, dump_sha256, detail)
VALUES (:'kind', :'status', :'offsite', :'started'::timestamptz, now(),
        NULLIF(:'dump_file', ''), NULLIF(:'dump_bytes', '')::bigint, NULLIF(:'dump_sha', ''), :'detail');
SQL
}

# Prints `schema.table rowcount` for every table data section of a custom-format dump, read from
# the dump itself (COPY blocks), so the restore can be checked against what was actually dumped.
dump_row_counts() {
  pg_restore --data-only --file=- "$1" | awk '
    inblk && $0 == "\\." { print table " " n; inblk = 0; next }
    inblk { n++; next }
    /^COPY / { table = $2; n = 0; inblk = 1 }
  '
}

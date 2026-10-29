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

# ---- Encryption at rest of the local backups (deploy/BACKUP_AND_RESTORE.md §7) ----------------
# BACKUP_LOCAL_ENCRYPTION=required: every artifact is written age-encrypted to BACKUP_AGE_RECIPIENT
# (the owner's public key); the private key never lives on this server. disabled: plaintext, as
# before. There is no default: the variable must say which.
AGE_HEADER='age-encryption.org/v1'

# local_encryption_required : exit status 0 = required (and usable), 1 = disabled; dies otherwise.
local_encryption_required() {
  require_env BACKUP_LOCAL_ENCRYPTION
  case "$BACKUP_LOCAL_ENCRYPTION" in
    required)
      [ -n "${BACKUP_AGE_RECIPIENT:-}" ] \
        || die "BACKUP_LOCAL_ENCRYPTION=required but BACKUP_AGE_RECIPIENT is empty: run keygen.sh first (deploy/BACKUP_AND_RESTORE.md §7.2); refusing to write unencrypted backups"
      printf '%s' "$BACKUP_AGE_RECIPIENT" | grep -Eq '^age1[0-9a-z]{58}$' \
        || die "BACKUP_AGE_RECIPIENT must be an age public key (age1...), got '$BACKUP_AGE_RECIPIENT'"
      command -v age > /dev/null || die "the age program is required for BACKUP_LOCAL_ENCRYPTION=required"
      return 0
      ;;
    disabled) return 1 ;;
    *) die "BACKUP_LOCAL_ENCRYPTION must be 'required' or 'disabled', got '$BACKUP_LOCAL_ENCRYPTION'" ;;
  esac
}

# private_dir DIR... : create (if needed) with mode 700.
private_dir() {
  for d in "$@"; do
    mkdir -p "$d"
    chmod 700 "$d"
  done
}

# is_age_file FILE : the file starts with the age v1 header.
is_age_file() {
  [ "$(head -c ${#AGE_HEADER} "$1")" = "$AGE_HEADER" ]
}

# encrypt_to PLAIN DEST : age-encrypts PLAIN to DEST (mode 600, written as DEST.partial then
# renamed, PLAIN's modification time kept). Without the private key the result cannot be decrypted
# here, so it is checked structurally: age exit 0, the age header, and a ciphertext longer than
# the plaintext (age adds a 16-byte nonce plus a 16-byte tag per 64 KiB chunk).
encrypt_to() {
  (umask 077 && age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$2.partial" "$1")
  chmod 600 "$2.partial"
  is_age_file "$2.partial" || die "encrypting $1 produced no age file"
  plain_bytes=$(wc -c < "$1" | tr -d ' ')
  cipher_bytes=$(wc -c < "$2.partial" | tr -d ' ')
  [ "$cipher_bytes" -gt "$((plain_bytes + 16))" ] || die "encrypted $2 is too short ($cipher_bytes bytes for $plain_bytes)"
  touch -r "$1" "$2.partial"
  mv "$2.partial" "$2"
}

# reset_work_dir : the private scratch directory (its own volume) where plaintext exists only
# while a run needs it. Emptied at the start of every run, so a crash mid-run cannot leave
# plaintext behind past the next run. The scheduler never runs two jobs at once; do not start a
# manual backup.sh or restore-drill.sh while another one is running.
reset_work_dir() {
  require_env BACKUP_WORK_DIR
  case "$BACKUP_WORK_DIR" in
    / | /backups | /wal-archive) die "BACKUP_WORK_DIR must be a dedicated directory, got '$BACKUP_WORK_DIR'" ;;
  esac
  private_dir "$BACKUP_WORK_DIR"
  find "$BACKUP_WORK_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

# base_start_wal_from_tar BASE_TAR_GZ : the first WAL file a base backup needs (its backup_label).
base_start_wal_from_tar() {
  # Through stdin: GNU tar would read "C:/..." (Git Bash on Windows) as a remote host name.
  gzip -dc "$1" | tar -xOf - backup_label \
    | sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p'
}

# ts_number 20261012T023000Z -> 20261012023000 (comparable with -lt).
ts_number() {
  printf '%s' "$1" | tr -d 'TZ'
}

# own_private OWNER PATH... : chown -R to OWNER (uid:gid), directories 700, files 600.
own_private() {
  owner=$1
  shift
  for p in "$@"; do
    chown -R "$owner" "$p"
    find "$p" -type d -exec chmod 700 {} +
    find "$p" -type f -exec chmod 600 {} +
  done
}

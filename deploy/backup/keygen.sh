#!/bin/sh
# One-time creation of the owner's backup key pair (deploy/BACKUP_AND_RESTORE.md §7.2). The owner
# runs it ONCE on the VPS, in the backup image (which has age), from the project folder:
#
#   docker compose run --rm --no-deps -v "$PWD/.env:/run/maintafox/env-rw" backup \
#     sh /opt/maintafox-backup/keygen.sh /run/maintafox/env-rw /dev/shm
#
# 1. Creates an age key pair. The private key is written only to a memory-backed directory (the
#    second argument; /dev/shm in the container) and checked with an encrypt/decrypt round trip.
# 2. Prints the private key ONCE, with instructions to save it in a password manager.
# 3. Waits for a typed confirmation: the last 6 characters of the key as saved. Until it matches,
#    nothing is changed.
# 4. Then: writes BACKUP_AGE_RECIPIENT=<public key> into the .env file (first argument), overwrites
#    the private key file with zeros and deletes it. The private key then exists nowhere on the
#    server. Without a confirmation (Ctrl+C, end of input) the key is wiped and .env is unchanged:
#    no backup is ever encrypted to a key the owner has not saved.
#
# Refuses to run when .env already has a BACKUP_AGE_RECIPIENT value (backups are already encrypted
# to that key; replacing it is a deliberate key rotation, §7.4).
set -eu
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: keygen.sh <.env file to update> <memory-backed directory for the temporary private key, e.g. /dev/shm>"
env_file=$1
mem_dir=$2
[ -f "$env_file" ] && [ -w "$env_file" ] || die "$env_file is not a writable file (mount the project's .env read-write, see the usage above)"
[ -d "$mem_dir" ] && [ -w "$mem_dir" ] || die "$mem_dir is not a writable directory"
command -v age > /dev/null && command -v age-keygen > /dev/null || die "age and age-keygen are required"
existing=$(sed -n 's/^BACKUP_AGE_RECIPIENT=//p' "$env_file" | tail -n 1)
[ -z "$existing" ] \
  || die "BACKUP_AGE_RECIPIENT is already set in $env_file ($existing). Backups are already encrypted to that key. To replace it, read deploy/BACKUP_AND_RESTORE.md §7.4 first."

umask 077
keyfile=$(mktemp "$mem_dir/mfx-backup-key.XXXXXX")
wipe() {
  if [ -f "$keyfile" ]; then
    size=$(wc -c < "$keyfile" | tr -d ' ')
    head -c "$size" /dev/zero > "$keyfile"
    rm -f "$keyfile"
  fi
}
trap wipe EXIT
trap 'wipe; echo; echo "Cancelled: nothing was changed and the key was discarded." >&2; exit 130' INT TERM HUP

age-keygen > "$keyfile" 2> /dev/null
recipient=$(age-keygen -y "$keyfile")
secret=$(grep '^AGE-SECRET-KEY-1' "$keyfile")
printf '%s' "$recipient" | grep -Eq '^age1[0-9a-z]{58}$' || die "age-keygen produced no valid public key"
probe="maintafox backup key check $(date -u +%s)"
[ "$(printf '%s' "$probe" | age --encrypt --recipient "$recipient" | age --decrypt --identity "$keyfile")" = "$probe" ] \
  || die "the new key pair failed its encrypt/decrypt check; nothing was changed"
last6=$(printf '%s' "$secret" | tail -c 6)

cat <<EOF

==================================================================================================
 MAINTAFOX BACKUP PRIVATE KEY - shown ONCE. Save it now.
==================================================================================================

$secret

 1. Copy the whole line above (it starts with AGE-SECRET-KEY-1) into your password manager, as a
    new entry named "Maintafox backup private key".
 2. Keep a second copy away from this server (printed on paper or on a USB stick in a safe).

 Every backup on this server will be encrypted so that ONLY this key can open it. The key will be
 deleted from the server in a moment. If you lose it, the backups cannot be read by anyone,
 including Maintafox: they become useless.

 (Public key, not secret, saved in .env: $recipient)
==================================================================================================

EOF

while :; do
  printf 'To confirm you saved it, type the LAST 6 characters of the key as saved in your password manager: '
  if ! read -r answer; then
    echo
    echo "No confirmation: nothing was changed and the key was discarded. Run this again when ready." >&2
    exit 1
  fi
  [ "$answer" = "$last6" ] && break
  echo "That does not match. Check the saved copy (it must be the full line) and try again, or press Ctrl+C to cancel without changing anything."
done

# .env is bind-mounted: rewrite it in place (same file), never replace it.
if grep -q '^BACKUP_AGE_RECIPIENT=' "$env_file"; then
  content=$(sed "s|^BACKUP_AGE_RECIPIENT=.*$|BACKUP_AGE_RECIPIENT=$recipient|" "$env_file")
  printf '%s\n' "$content" > "$env_file"
else
  if [ -s "$env_file" ] && [ -n "$(tail -c 1 "$env_file")" ]; then
    printf '\n' >> "$env_file"
  fi
  printf 'BACKUP_AGE_RECIPIENT=%s\n' "$recipient" >> "$env_file"
fi
wipe
[ ! -e "$keyfile" ] || die "could not delete the temporary key file $keyfile"

cat <<EOF

Confirmed. BACKUP_AGE_RECIPIENT is saved in .env and the private key was wiped from this server.
Clear this terminal's scrollback now (close the window, or run: clear && printf '\033[3J').

Next (deploy/BACKUP_AND_RESTORE.md §7.3): set BACKUP_LOCAL_ENCRYPTION=required in .env, then
  docker compose up -d postgres backup
EOF

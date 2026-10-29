#!/bin/sh
# Starts sshd for the read-only backup pull. The host key is created once and kept in its own
# volume, so the fingerprint the on-premise machine trusts never changes.
set -eu

keys=/etc/ssh/authorized_keys/mfxpull
[ -s "$keys" ] || { echo "backup-pull: no public key mounted at $keys (BACKUP_PULL_AUTHORIZED_KEYS)" >&2; exit 1; }
grep -Eq '^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) ' "$keys" \
  || { echo "backup-pull: $keys holds no SSH public key" >&2; exit 1; }

hostkey=/etc/ssh/hostkeys/ssh_host_ed25519_key
if [ ! -f "$hostkey" ]; then
  ssh-keygen -q -t ed25519 -N '' -C maintafox-backup-pull -f "$hostkey"
fi
echo "backup-pull: host key fingerprint (compare it on the on-premise machine):"
ssh-keygen -l -f "$hostkey.pub"
exec /usr/sbin/sshd -D -e

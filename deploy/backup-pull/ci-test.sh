#!/bin/bash
# End-to-end test of the read-only backup pull (CI job "backup-pull"; needs docker, pwsh, age,
# ssh/sftp and passwordless sudo). Builds the real image, serves encrypted test files exactly as the
# backup container leaves them (owner 70:70, files 600, directories 700, SHA256SUMS), then runs
# the real Pull-MaintafoxBackups.ps1 against it and checks:
#   1. every file is downloaded and matches its SHA-256; nothing that is not *.age is fetched
#   2. a second run downloads nothing new
#   3. the account is read-only (upload, delete, rename refused), SFTP-only (no shell, no command),
#      key-only (a different key is refused)
#   4. a file whose content no longer matches the manifest makes the pull fail and is not kept
#   5. retention: a file the server no longer lists is deleted once older than KeepDays
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
image=maintafox-backup-pull:ci
name=mfx-backup-pull-ci
port=22222
cleanup() {
  docker rm -f "$name" > /dev/null 2>&1 || true
  sudo rm -rf "$root"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; docker logs "$name" >&2 || true; exit 1; }

docker build -t "$image" "$here"

# Server side: what the backup container writes.
srv="$root/server"
mkdir -p "$srv/backups/pg_dump" "$srv/backups/base/20261012T023000Z" "$srv/wal" "$root/keys" "$root/dest"
age-keygen -o "$root/owner.key" 2> /dev/null
recipient=$(age-keygen -y "$root/owner.key")
enc() { head -c "$2" /dev/urandom | age -r "$recipient" -o "$1"; }
enc "$srv/backups/pg_dump/maintafox-20261012T023000Z.dump.age" 200000
enc "$srv/backups/pg_dump/maintafox-20261012T023000Z.dump.sha256.age" 100
enc "$srv/backups/base/20261012T023000Z/base.tar.gz.age" 300000
echo 000000010000000000000003 > "$srv/backups/base/20261012T023000Z/start-wal"
enc "$srv/wal/000000010000000000000003.gz.age" 50000
enc "$srv/wal/000000010000000000000004.gz.age" 50000
echo "deadbeef  000000010000000000000004" > "$srv/wal/000000010000000000000004.gz.age.sha256"
manifest() {
  (cd "$srv" && find backups wal -type f -name '*.age' | sort | while read -r f; do
    printf '%s  %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"
  done) > "$srv/backups/SHA256SUMS"
}
manifest
sudo chown -R 70:70 "$srv"
sudo find "$srv" -type d -exec chmod 700 {} +
sudo find "$srv" -type f -exec chmod 600 {} +

ssh-keygen -q -t ed25519 -N '' -f "$root/keys/pull_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$root/keys/other_ed25519"
cp "$root/keys/pull_ed25519.pub" "$root/authorized_keys"
chmod 644 "$root/authorized_keys"
# sshd (StrictModes) accepts it only when owned by root or by the account, as on the VPS.
sudo chown root:root "$root/authorized_keys"

docker run -d --name "$name" -p "127.0.0.1:$port:2222" \
  -v "$srv/backups:/pull/backups:ro" -v "$srv/wal:/pull/wal:ro" \
  -v "$root/authorized_keys:/etc/ssh/authorized_keys/mfxpull:ro" "$image" > /dev/null
for _ in $(seq 1 30); do
  ssh-keyscan -p "$port" -t ed25519 127.0.0.1 > "$root/keys/known_hosts" 2> /dev/null && [ -s "$root/keys/known_hosts" ] && break
  sleep 1
done
[ -s "$root/keys/known_hosts" ] || fail "sshd did not start"
docker logs "$name" 2>&1 | grep -q 'host key fingerprint' || fail "no host key fingerprint in the logs"

pull() {
  pwsh -NoProfile -File "$here/Pull-MaintafoxBackups.ps1" -ServerHost 127.0.0.1 -Port "$port" -User mfxpull \
    -IdentityFile "$root/keys/pull_ed25519" -KnownHostsFile "$root/keys/known_hosts" \
    -Destination "$root/dest" -KeepDays 30
}
sftp_as() { # KEY, batch on stdin
  sftp -b - -P "$port" -i "$1" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$root/keys/known_hosts" mfxpull@127.0.0.1
}

# 1. Full pull.
pull > "$root/run1.log" || { cat "$root/run1.log"; fail "first pull failed"; }
grep -q '5 files listed by the server, 5 downloaded and verified, 0 already here' "$root/run1.log" || { cat "$root/run1.log"; fail "first pull summary"; }
for f in backups/pg_dump/maintafox-20261012T023000Z.dump.age backups/base/20261012T023000Z/base.tar.gz.age wal/000000010000000000000004.gz.age; do
  [ "$(sudo cat "$srv/$f" | sha256sum | cut -d' ' -f1)" = "$(sha256sum < "$root/dest/$f" | cut -d' ' -f1)" ] || fail "$f differs"
done
[ ! -e "$root/dest/backups/base/20261012T023000Z/start-wal" ] || fail "a non-encrypted file was downloaded"
[ ! -e "$root/dest/wal/000000010000000000000004.gz.age.sha256" ] || fail "a non-encrypted file was downloaded"
[ ! -e "$root/dest/.incoming" ] || fail "staging folder left behind"
age -d -i "$root/owner.key" -o /dev/null "$root/dest/backups/base/20261012T023000Z/base.tar.gz.age" || fail "downloaded file does not decrypt with the owner key"

# 2. Nothing new the second time.
pull > "$root/run2.log" || { cat "$root/run2.log"; fail "second pull failed"; }
grep -q '0 downloaded and verified, 5 already here' "$root/run2.log" || { cat "$root/run2.log"; fail "second pull re-downloaded"; }

# 3. Read-only, SFTP-only, key-only.
echo "probe" > "$root/probe.txt"
if printf 'put %s backups/probe.txt\n' "$root/probe.txt" | sftp_as "$root/keys/pull_ed25519" > /dev/null 2>&1; then fail "upload accepted"; fi
if printf 'rm wal/000000010000000000000003.gz.age\n' | sftp_as "$root/keys/pull_ed25519" > /dev/null 2>&1; then fail "delete accepted"; fi
if printf 'rename wal/000000010000000000000003.gz.age wal/x.age\n' | sftp_as "$root/keys/pull_ed25519" > /dev/null 2>&1; then fail "rename accepted"; fi
if printf 'ls\n' | sftp_as "$root/keys/other_ed25519" > /dev/null 2>&1; then fail "a key that is not authorized was accepted"; fi
out=$(ssh -p "$port" -i "$root/keys/pull_ed25519" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$root/keys/known_hosts" mfxpull@127.0.0.1 'id; cat /etc/passwd' < /dev/null 2>&1 || true)
case "$out" in *uid=*|*root:*) fail "a command ran: $out" ;; esac
if ssh -p "$port" -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/keys/known_hosts" mfxpull@127.0.0.1 true < /dev/null 2> /dev/null; then
  fail "password login accepted"
fi
listing=$(printf 'ls /\n' | sftp_as "$root/keys/pull_ed25519" 2>&1)
case "$listing" in *etc*|*usr*) fail "the account sees outside its chroot: $listing" ;; esac
[ "$(sudo find "$srv" -name probe.txt | wc -l)" = 0 ] || fail "a file was written on the server"

# 4. Tampered file (server copy changed, manifest not): the pull fails and keeps nothing of it.
victim=wal/000000010000000000000003.gz.age
sudo rm -f "$root/dest/$victim"
head -c 50000 /dev/urandom | sudo tee "$srv/$victim" > /dev/null
if pull > "$root/run3.log"; then cat "$root/run3.log"; fail "a file that does not match the manifest was accepted"; fi
grep -q "SHA-256 mismatch, not kept: $victim" "$root/run3.log" || { cat "$root/run3.log"; fail "mismatch not reported"; }
[ ! -e "$root/dest/$victim" ] || fail "the mismatching file was kept"

# 5. Retention: drop files from the server and the manifest; old enough -> deleted locally.
gone=wal/000000010000000000000004.gz.age
sudo rm -f "$srv/$victim" "$srv/$gone" "$srv/$gone.sha256"
sudo chown -R "$(id -u):$(id -g)" "$srv"
manifest
sudo chown -R 70:70 "$srv"
sudo find "$srv" -type f -exec chmod 600 {} +
touch -d '40 days ago' "$root/dest/$gone"
pull > "$root/run4.log" || { cat "$root/run4.log"; fail "pull after retention change failed"; }
[ ! -e "$root/dest/$gone" ] || fail "an old file the server no longer lists was kept"
[ -e "$root/dest/backups/pg_dump/maintafox-20261012T023000Z.dump.age" ] || fail "a listed file was deleted"
grep -q '1 deleted' "$root/run4.log" || { cat "$root/run4.log"; fail "retention summary"; }

echo "backup-pull ci-test: OK (download + SHA-256, idempotent, read-only/SFTP-only/key-only, tamper refused, retention)"

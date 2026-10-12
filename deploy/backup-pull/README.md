# On-premise copy of the encrypted backups (read-only pull)

A machine on the owner's premises (Windows 10/11, in Algeria) downloads the **encrypted** backups
from the VPS every night. The VPS cannot reach into that machine; the machine can only read from
the VPS:

- **Server side** (`compose.yml`, `Dockerfile`, `sshd_config`): a small container with an SFTP
  server and one account, `mfxpull`. SSH key only (no password), SFTP only (no shell, no command, no
  forwarding), **read-only** (the SFTP server refuses every write, rename and delete, and the
  volumes are mounted read-only), chrooted to `/pull`, which contains only `backups/` (the
  `backup_data` volume) and `wal/` (the `pg_wal_archive` volume). Those hold only `*.age` files
  (encrypted to the owner's key), the `SHA256SUMS` list and two kinds of tiny plaintext marker
  files with no data in them (`start-wal`, `*.gz.age.sha256`), which the pull ignores.
- **Machine side** (`Pull-MaintafoxBackups.ps1`): downloads the files that are new, checks each
  SHA-256 against `SHA256SUMS`, keeps a file only if it matches, and deletes files the server no
  longer has once they are older than `KeepDays` days. Every run is logged in `pull.log`.

Requires `BACKUP_LOCAL_ENCRYPTION=required` on the VPS (BACKUP_AND_RESTORE.md §7): the pull only
accepts `*.age` files listed in `SHA256SUMS`, which only the encrypted mode writes.

Nothing on the on-premise machine can open the backups. To restore, the owner uses the private key
from the password manager (BACKUP_AND_RESTORE.md §4.3, §4.4).

## 1. On the on-premise machine: a dedicated SSH key

PowerShell **as Administrator**:

```powershell
New-Item -ItemType Directory -Force C:\MaintafoxBackups\keys, D:\MaintafoxBackups\data
Copy-Item .\Pull-MaintafoxBackups.ps1 C:\MaintafoxBackups\
ssh-keygen -t ed25519 -N '""' -C maintafox-backup-pull -f C:\MaintafoxBackups\keys\pull_ed25519
# The task runs as SYSTEM: only SYSTEM and Administrators may read the private key
# (the OpenSSH client refuses a key other users can read).
icacls C:\MaintafoxBackups\keys\pull_ed25519 /inheritance:r /grant:r "SYSTEM:R" "Administrators:R"
Get-Content C:\MaintafoxBackups\keys\pull_ed25519.pub
```

The key has no passphrase because it runs unattended; it can only **read encrypted files**, so
losing it exposes nothing readable. If the machine is lost or stolen, remove the line from
`authorized_keys` on the VPS (step 2).

Choose drive `D:` (or any disk with room for `BACKUP_LOCAL_RETENTION_DAYS` + `KeepDays` days of
backups; a few GB today).

## 2. On the VPS: enable the pull service (main session, after the owner says "deploy")

```sh
mkdir -p /root/maintafox-backup-pull
# paste the ONE line printed by Get-Content above (starts with ssh-ed25519)
nano /root/maintafox-backup-pull/authorized_keys
# a public key: readable by all (sshd reads it as the pull user), owned by root (sshd refuses it otherwise)
chown root:root /root/maintafox-backup-pull/authorized_keys
chmod 644 /root/maintafox-backup-pull/authorized_keys
```

`.env` (in the project folder):

```
COMPOSE_FILE=docker-compose.yml:deploy/backup-pull/compose.yml
BACKUP_PULL_PORT=2222
BACKUP_PULL_AUTHORIZED_KEYS=/root/maintafox-backup-pull/authorized_keys
```

```sh
docker compose build backup-pull
docker compose up -d backup-pull
docker compose logs backup-pull     # prints the host key fingerprint: SHA256:....
```

Firewall: open `BACKUP_PULL_PORT` (TCP) **only to the on-premise machine's public IP** if it is
fixed (`ufw allow from <ip> to any port 2222 proto tcp`); otherwise to all, the account being
key-only and read-only (`ufw allow 2222/tcp`).

**Rollback:** remove the three lines from `.env`, `docker compose rm -sf backup-pull`,
`ufw delete allow ...`. The backup files are not touched (read-only mounts).

## 3. On the on-premise machine: trust the server and run once

```powershell
ssh-keyscan -p 2222 -t ed25519 api.maintafox.systems | Out-File -Encoding ascii C:\MaintafoxBackups\keys\known_hosts
ssh-keygen -l -f C:\MaintafoxBackups\keys\known_hosts
```

The fingerprint printed must be **exactly** the one from `docker compose logs backup-pull`. If not,
stop: something is between the machine and the VPS.

First run by hand (the first one downloads everything):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\MaintafoxBackups\Pull-MaintafoxBackups.ps1 `
  -ServerHost api.maintafox.systems -Port 2222 -User mfxpull `
  -IdentityFile C:\MaintafoxBackups\keys\pull_ed25519 -KnownHostsFile C:\MaintafoxBackups\keys\known_hosts `
  -Destination D:\MaintafoxBackups\data -KeepDays 30
```

It ends with `pull OK: N files listed by the server, N downloaded and verified, ...`.

## 4. Every night: Task Scheduler

PowerShell **as Administrator** (05:00 local time = after the VPS backup at 02:30 UTC; adjust if
`BACKUP_DAILY_AT_UTC` changes):

```powershell
$arguments = '-NoProfile -ExecutionPolicy Bypass -File C:\MaintafoxBackups\Pull-MaintafoxBackups.ps1 ' +
  '-ServerHost api.maintafox.systems -Port 2222 -User mfxpull ' +
  '-IdentityFile C:\MaintafoxBackups\keys\pull_ed25519 -KnownHostsFile C:\MaintafoxBackups\keys\known_hosts ' +
  '-Destination D:\MaintafoxBackups\data -KeepDays 30'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At 05:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'Maintafox backup pull' -Action $action -Trigger $trigger -Settings $settings `
  -User 'SYSTEM' -RunLevel Highest
Start-ScheduledTask -TaskName 'Maintafox backup pull'
```

`-StartWhenAvailable` runs a missed pull as soon as the machine is on again; a failed run is retried
3 times, 30 minutes apart.

**Checking it works** (once a week is enough):
- Task Scheduler → *Maintafox backup pull* → *Last Run Result* = `0x0` (success). `0x1` = the pull
  failed: read the last lines of `D:\MaintafoxBackups\data\pull.log`.
- `pull.log` has one `pull OK` line per day.

**Rollback / stop:** `Unregister-ScheduledTask -TaskName 'Maintafox backup pull' -Confirm:$false`.
The downloaded files stay (they are encrypted).

## 5. What the script guarantees

- Only lines of `SHA256SUMS` that name an `*.age` file under `backups/pg_dump/`,
  `backups/base/<timestamp>/` or `wal/` are accepted; any other line makes the run fail (nothing
  from outside those folders, no `..`).
- A file is put in place only after its SHA-256 matches the server's list; a mismatch fails the run
  (exit code 1) and the bad download is deleted.
- A file already here with the right SHA-256 is not downloaded again.
- Retention: files the server still lists are always kept; a file the server no longer has is
  deleted once its local copy is older than `KeepDays` days.
- Leftovers of an interrupted run (`.incoming`) are deleted at the start of the next run.

Tested end to end in CI (`ci-test.sh`, job "backup-pull"): the real container and the real script
(under PowerShell 7 on Linux): download and verify, nothing re-downloaded, upload/delete/rename,
other keys, passwords and commands refused, the account cannot see outside its folder, a tampered
file refused, retention.

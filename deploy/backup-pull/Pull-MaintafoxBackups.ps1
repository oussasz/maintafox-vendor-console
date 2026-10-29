<#
.SYNOPSIS
  Downloads the ENCRYPTED Maintafox backups from the VPS to this machine (on-premise copy).

.DESCRIPTION
  Read-only pull over SFTP with a dedicated SSH key (deploy/backup-pull/README.md):
    1. Downloads the server's manifest (backups/SHA256SUMS: one SHA-256 per encrypted file).
    2. Downloads every listed file that is missing here or differs, into a staging folder.
    3. Verifies the SHA-256 of every downloaded file against the manifest; only then moves it into
       place. A mismatch stops the run with an error (exit code 1) and keeps nothing of that file.
    4. Retention: a file the server no longer lists is deleted here once it is older than KeepDays
       days. Files the server still lists are always kept.
  Only *.age files (age-encrypted to the owner's key) are accepted; the manifest is refused if it
  names anything else. Nothing here can decrypt them: that needs the owner's private key.
  Every run appends to <Destination>\pull.log. Works with Windows PowerShell 5.1 and PowerShell 7,
  using the OpenSSH client (sftp.exe) built into Windows 10/11.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\MaintafoxBackups\Pull-MaintafoxBackups.ps1 `
    -ServerHost api.maintafox.systems -Port 2222 -User mfxpull `
    -IdentityFile C:\MaintafoxBackups\keys\pull_ed25519 -KnownHostsFile C:\MaintafoxBackups\keys\known_hosts `
    -Destination D:\MaintafoxBackups\data -KeepDays 30
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [Parameter(Mandatory = $true)][ValidateRange(1, 65535)][int]$Port,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$IdentityFile,
  [Parameter(Mandatory = $true)][string]$KnownHostsFile,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][ValidateRange(1, 3650)][int]$KeepDays
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# A manifest line: 64 hex characters, two spaces, a relative path of an encrypted file in one of
# the places the server offers. No "..", no absolute path, nothing but *.age. Media copies
# (backups/media/..., api/src/tools/media-backup.ts) keep the object key's path: every segment
# starts with a letter, digit, '_', '-' or '%', so '.' and '..' segments cannot match.
$EntryPattern = '^([0-9a-f]{64})  ((backups/pg_dump|backups/base/[0-9]{8}T[0-9]{6}Z|wal)/[A-Za-z0-9._-]+\.age|backups/media/(current|removed/[0-9]{8}T[0-9]{6}Z)(/[A-Za-z0-9_%-][A-Za-z0-9._%+-]*)+\.age)$'
$ManifestRemote = 'backups/SHA256SUMS'

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Write-Output $line
  Add-Content -LiteralPath (Join-Path $Destination 'pull.log') -Value $line -Encoding UTF8
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# sftp batch paths: forward slashes, double quotes (paths contain no quotes: the pattern forbids it
# on the remote side, and the local folders are the operator's own).
function Format-SftpPath([string]$Path) {
  return '"' + ($Path -replace '\\', '/') + '"'
}

function Invoke-SftpBatch([string[]]$Commands) {
  $batch = Join-Path $staging 'batch.txt'
  [System.IO.File]::WriteAllLines($batch, $Commands)
  $sftpArgs = @(
    '-b', $batch,
    '-P', "$Port",
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$KnownHostsFile",
    '-o', 'ConnectTimeout=30',
    "$User@$ServerHost"
  )
  # Windows PowerShell 5.1 turns every stderr line of a native program into an error record, which
  # 'Stop' would throw on even when sftp succeeds: the exit code decides, stderr is only reported.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $sftp @sftpArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previous
  }
  Remove-Item -LiteralPath $batch -Force
  if ($code -ne 0) {
    throw "sftp failed (exit $code): $($output -join ' | ')"
  }
}

foreach ($file in @($IdentityFile, $KnownHostsFile)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "$file does not exist" }
}
$sftpCommand = Get-Command sftp -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $sftpCommand) {
  throw 'sftp (the OpenSSH client) is not installed: Settings > System > Optional features > OpenSSH Client'
}
$sftp = @($sftpCommand)[0].Source
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$staging = Join-Path $Destination '.incoming'

try {
  # Leftovers of an interrupted run are never trusted.
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  $manifestLocal = Join-Path $staging 'SHA256SUMS'
  Invoke-SftpBatch @("get $(Format-SftpPath $ManifestRemote) $(Format-SftpPath $manifestLocal)")
  $entries = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($manifestLocal)) {
    if ($line -eq '') { continue }
    $m = [regex]::Match($line, $EntryPattern)
    if (-not $m.Success) { throw "the server manifest has an unexpected line, refusing it: '$line'" }
    $entries[$m.Groups[2].Value] = $m.Groups[1].Value
  }
  if ($entries.Count -eq 0) { throw 'the server manifest lists no encrypted file' }

  $wanted = @()
  foreach ($rel in ($entries.Keys | Sort-Object)) {
    $local = Join-Path $Destination ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if ((Test-Path -LiteralPath $local -PathType Leaf) -and ((Get-Sha256 $local) -eq $entries[$rel])) { continue }
    $wanted += $rel
  }

  $downloaded = 0
  if ($wanted.Count -gt 0) {
    $commands = @()
    foreach ($rel in $wanted) {
      $target = Join-Path $staging ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      $commands += "get $(Format-SftpPath $rel) $(Format-SftpPath $target)"
    }
    Invoke-SftpBatch $commands
    $bad = @()
    foreach ($rel in $wanted) {
      $part = [System.IO.Path]::DirectorySeparatorChar
      $source = Join-Path $staging ($rel -replace '/', $part)
      if ((Get-Sha256 $source) -ne $entries[$rel]) { $bad += $rel; continue }
      $final = Join-Path $Destination ($rel -replace '/', $part)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $final) | Out-Null
      Move-Item -LiteralPath $source -Destination $final -Force
      $downloaded += 1
    }
    if ($bad.Count -gt 0) {
      throw "SHA-256 mismatch, not kept: $($bad -join ', ')"
    }
  }
  Copy-Item -LiteralPath $manifestLocal -Destination (Join-Path $Destination 'SHA256SUMS') -Force

  # Retention: only files the server no longer lists, once older than KeepDays.
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  $deleted = 0
  foreach ($top in @('backups', 'wal')) {
    $root = Join-Path $Destination $top
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
      $rel = $file.FullName.Substring($Destination.Length).TrimStart('\', '/') -replace '\\', '/'
      if ($entries.ContainsKey($rel)) { continue }
      if ($file.LastWriteTime -lt $cutoff) {
        Remove-Item -LiteralPath $file.FullName -Force
        $deleted += 1
      }
    }
    Get-ChildItem -LiteralPath $root -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending |
      Where-Object { @(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0 } |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
  }

  Write-Log ("pull OK: {0} files listed by the server, {1} downloaded and verified, {2} already here, {3} deleted (older than {4} days and no longer on the server)" -f `
      $entries.Count, $downloaded, ($entries.Count - $wanted.Count), $deleted, $KeepDays)
  Remove-Item -LiteralPath $staging -Recurse -Force
  exit 0
}
catch {
  Write-Log "pull FAILED: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  exit 1
}

# Desktop releases and updates (master plan Phase 5)

How a desktop build reaches customers' machines, and what the server does at each step.

```
GitHub release workflow (desktop repo, .github/workflows/release.yml)
  build NSIS installer + updater signature (.sig) -> Authenticode signing (when a certificate exists)
  POST /api/v1/release-uploads            (publisher key)  -> presigned PUT URLs
  PUT installer to object storage
  POST /api/v1/release-uploads/:id/complete                -> server re-reads the file: size, SHA-256,
                                                              updater signature (RELEASE_UPDATER_PUBLIC_KEY)
  => release is a DRAFT in the console (offered to nobody)
Console > Updates > Releases (operator, step-up)
  Publish to Internal -> Pilot -> Stable with a rollout %   (rings only widen)
  Recall                                                   (never offered again)
Desktop (every 2 h and on demand)
  GET /api/v1/updates/windows/x86_64/<its version>   (device token)
  204 = nothing; 200 = Tauri update JSON + `maintafox` {kind upgrade|rollback, mandatory, notes FR/EN}
```

## Rules the manifest applies (`api/src/releases/update-manifest.ts`)

- **Rings:** a device follows its licence's channel (internal, pilot or stable). A release published
  to a ring reaches that ring and every inner ring (stable reaches pilot and internal too).
- **Rollout %:** applies to the release's widest ring. Each device has a fixed bucket per release,
  so raising the percentage only adds devices.
- **Pause** (Updates > Rollouts, per channel + cohort): nothing is offered. A desktop whose database
  update failed can still ask for the version it came from (header `X-Maintafox-Rollback-To`).
- **Recall:** catalog recall (all customers) or cohort recall (Phase 4.2, one channel + cohort). A
  recalled version is never offered. Devices running it are offered the newest other release they
  may have, even an older one: that is the rollback to the previous signed installer.
- **Minimum version** (Updates > Forced updates): a device under the floor gets a mandatory offer
  that ignores the rollout percentage. Pause and recall still win.
- The desktop checks the manifest again right before downloading, so a recall or pause stops
  installs from the next check.

## Server configuration

| Variable | Value |
|---|---|
| `RELEASE_UPDATER_PUBLIC_KEY` | The desktop updater **public** key: the content of `src-tauri/updater/maintafox-updater.pub` in the desktop repo (written by `scripts/release/setup-updater-key.ps1`). Public, not a secret. Unset: the API starts, logs a warning, and `complete` answers 503 `updater_public_key_not_configured`. Invalid: the API refuses to start. |

Object storage: releases use the existing media bucket under `<DEPLOYMENT_ENV>/releases/<version>/...`.
Presigned URLs must be reachable from GitHub Actions (upload) and from customers' desktops
(download), so they need the public object-storage endpoint (branch `claude/media-public-endpoint`,
`S3_PUBLIC_ENDPOINT` + the `media.maintafox.systems` nginx route). **That route caps a request at
32 MB, but an installer is larger: raise `client_max_body_size` for release objects (for example a
`location` matching `/<bucket>/<env>/releases/` with 1 GB) when both branches are deployed.** Until
the public endpoint is deployed, the upload step of the release workflow fails (the URL points to
the internal `minio:9000`); nothing is registered half-way.

## Release workflow key (one-time setup)

1. Console > Updates > Releases > Release workflow keys > Create (name e.g. "GitHub Actions").
   Confirm with your authenticator code. Copy the token shown once.
2. On your computer, in the desktop repository folder:
   `gh secret set MAINTAFOX_RELEASE_PUBLISHER_TOKEN` and paste the token when asked.
3. To replace it: create a new key, set the secret again, then revoke the old key.

A publisher key can only upload and register drafts. Publishing to customers always needs an
operator with `rollout.manage` and a step-up code.

## Deploy checklist (server part)

1. Backup first (as every deploy): `/opt/backups/<timestamp>/` with `.env` and a `pg_dump`.
2. Deploy the API and console images from this branch (`docker compose up -d --build`).
   Migration `016_release_catalog.sql` runs at start: new tables `app_releases`,
   `app_release_artifacts`, `release_publisher_keys` and the function `mfx_update_candidates`. It
   changes no existing table.
3. Add `RELEASE_UPDATER_PUBLIC_KEY=<public key>` to `.env` once the owner has created the key, then
   `docker compose up -d control-api`.
4. Check: `GET /health` is OK; Console > Updates shows the Releases tab; the API log has no
   `RELEASE_UPDATER_PUBLIC_KEY is not set` warning (when set).
5. With the public object-storage endpoint deployed: raise the body limit for release objects (see
   above), run the release workflow once, and check that the draft appears in the console.

**Rollback:** redeploy the previous images. Migration 016 only adds objects, so the previous API
works with them in place; to remove them as well, restore the `pg_dump` from step 1. Desktops that
already installed a newer release keep it (use Recall to move them back once the catalog is up).

## Audit

Every step is in the audit ledger (category `release`): `release_upload_declared`,
`release_registered`, `release_publish`, `release_recall`, `release_notes_edited`,
`release_publisher_key_create`, `release_publisher_key_revoke`.

## Tests

`api/scripts/update-manifest.integration.mjs` (`pnpm --filter maintafox-control-api run
test:update-manifest`, CI job "Object storage"): the whole chain against real Postgres and an
S3 server, including a real `tauri signer` signature vector.

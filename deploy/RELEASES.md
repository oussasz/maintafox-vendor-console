# Desktop releases and updates (master plan Phase 5)

How a desktop build reaches customers' machines, and what the server does at each step.

```
GitHub release workflow (desktop repo, .github/workflows/release.yml)
  build NSIS installer + updater signature (.sig) -> Authenticode signing (when a certificate exists)
  POST /api/v1/release-uploads            (publisher key)  -> presigned PUT URLs (15 minutes)
  PUT installer to object storage                          (upload key: never served)
  POST /api/v1/release-uploads/:id/complete                -> server COPIES each upload to a server-only
                                                              key and verifies the copy: size, SHA-256,
                                                              updater signature (RELEASE_UPDATER_PUBLIC_KEY),
                                                              signed file name = declared file name
  => release is a DRAFT in the console (offered to nobody)
Console > Updates > Releases (operator, step-up)
  Publish to Internal -> Pilot -> Stable with a rollout %   (rings only widen)
  Recall                                                   (never offered again)
Desktop (every 2 h and on demand)
  GET /api/v1/updates/windows/x86_64/<its version>   (device token)
  204 = nothing; 200 = Tauri update JSON + `maintafox` object (below)
```

## The manifest response (agreed with the desktop, `src-tauri/src/updater/mod.rs`)

Tauri v2 fills the endpoint template `/api/v1/updates/{{target}}/{{arch}}/{{current_version}}` with
`target` = `windows` and `arch` = `x86_64` on the desktop's only platform. The release workflow
registers its installer under exactly those two values, and the route looks them up as sent (no
aliases such as `win64` or `x64`). `current_version` must be `MAJOR.MINOR.PATCH[-pre]` (for example
`1.2.0` or `0.4.0-dev`); anything else is `400 invalid_update_request` (see "Forced updates").

`204` means nothing to install. `200` is Tauri's dynamic-update JSON (`version`, `notes`, `pub_date`,
`url`, `signature`) plus:

| `maintafox` field | Value |
|---|---|
| `release_id` | Catalog release id (string, always present). The desktop journals it for rollback and audit and refuses an answer without it. |
| `kind` | `upgrade` or `rollback`. |
| `mandatory` | `true` when the PC must install it. |
| `mandatory_reason` | `forced_update_floor` (policy "required", PC below the minimum version), `emergency` (policy "emergency"), `rollback_requested` (header `X-Maintafox-Rollback-To`), `recalled_version` (the PC runs a recalled version); `null` when not mandatory. |
| `min_version` | The effective minimum version when the forced-update policy makes the offer mandatory (as the operator typed it, e.g. `1.0`; `null` under "emergency" with no minimum); `null` otherwise. |
| `notes_en`, `notes_fr` | Release notes in both languages. |
| `mandatory_message` | The operator's own reason text for a forced update, or `null`. Extra field: the desktop ignores unknown fields. |

## Rules the manifest applies (`api/src/releases/update-manifest.ts`)

- **Rings:** a device follows its licence's channel (internal, pilot or stable). A release published
  to a ring reaches that ring and every inner ring (stable reaches pilot and internal too).
- **Rollout %:** applies to the release's widest ring. Each device has a fixed bucket per release,
  so raising the percentage only adds devices.
- **Pause** (Updates > Rollouts, per channel + cohort): nothing is offered, except an explicit
  rollback (below).
- **Rollback target.** A PC can only ever go back to ONE release: the newest release below the
  version it runs that (1) its ring sees (same rule as upgrades; the rollout percentage does not
  apply), (2) is not recalled (catalog or its cohort), and (3) passes the forced-update policy as
  the PC's next version, i.e. policy refresh would not block it (under "emergency" nothing passes).
  The desktop installs any version the server offers, so these checks are the only gate: a stable
  PC can never be sent an internal-only build, and no PC is sent back below a minimum version.
- **Explicit rollback** (a desktop whose database update failed asks for the version it came from,
  header `X-Maintafox-Rollback-To`, also while paused): granted only when the header names exactly
  the rollback target. Anything else is `409 rollback_target_not_allowed` with
  `requested_version`, `allowed_version` (the target, or `null` when there is none) and a message;
  the server never substitutes another version.
- **Recall:** catalog recall (all customers) or cohort recall (Phase 4.2, one channel + cohort). A
  recalled version is never offered. A PC running it is offered a newer release when one is
  available to it, otherwise its rollback target (`mandatory_reason` `recalled_version`). When there
  is no rollback target (everything below is on another ring, recalled, or under the floor), the
  answer is 204: the PC stays where it is. **The operator must then publish a fixed release.** If
  the floor also blocks the recalled version itself, policy refresh keeps that PC blocked until
  the fixed release is installed; that is intended.
- **Forced updates** (Updates > Forced updates, tenant or cohort policy): when the policy requires
  this PC to update, the offer is mandatory and ignores the rollout percentage. Pause and recall
  still win. "Requires" is decided by `api/src/app/force-update.ts` (`resolveForceUpdatePolicy`),
  the same function activation and policy refresh use (review R4-S2), with the URL's current
  version in the role of policy refresh's `app_version`: so the manifest's `mandatory` is policy
  refresh's `force_update_required` for the same tenant and version. Strict parsing: a pre-release
  is below its release (`1.0.0-dev` < `1.0.0`), "emergency" always requires, a "required" policy
  with no readable minimum blocks every PC, and a minimum typed loosely by an operator (`1.0`,
  `v2`) keeps its exact meaning. A version the strict check cannot read is refused with 400
  (policy refresh blocks it), never answered "up to date". The manifest's own version ordering
  (SemVer, `compareVersions`) is only used to pick a release; `api/scripts/force-update-policy.mjs`
  checks it never contradicts the floor check. When the policy requires an update but the catalog
  has nothing newer for this PC, the answer is 204 and policy refresh keeps blocking the PC:
  publish a release at or above the minimum.
- The desktop checks the manifest again right before downloading, so a recall or pause stops
  installs from the next check.

## Server configuration

| Variable | Value |
|---|---|
| `RELEASE_UPDATER_PUBLIC_KEY` | The desktop updater **public** key: the one-line content of `src-tauri/updater/maintafox-updater.pub` in the desktop repo (written once by the owner with `scripts/release/setup-updater-key.ps1`). Public, not a secret. Unset: the API starts, logs a warning, and `complete` answers 503 `updater_public_key_not_configured`. Invalid: the API refuses to start. |

**It must be the same minisign key the desktop compiles in.** The desktop embeds
`maintafox-updater.pub` and only installs an update whose signature that key verifies; the release
workflow signs with the matching private key, which exists only in the desktop repository's GitHub
secret `TAURI_SIGNING_PRIVATE_KEY`. The server checks every uploaded installer against
`RELEASE_UPDATER_PUBLIC_KEY` so that a release the desktop would reject never reaches the catalog.
If the two keys differ, every upload is refused (`updater_signature_invalid`, `key_mismatch`).

**It is not a release publisher key.** The keys under Console > Updates > Releases > Release
workflow keys (`mfxrp_...`, GitHub secret `MAINTAFOX_RELEASE_PUBLISHER_TOKEN`) are upload
credentials for CI: they let the workflow talk to this API. They sign nothing and have nothing to do
with the updater key.

## What `complete` guarantees

- **Devices only download what was verified.** The release workflow uploads to
  `<DEPLOYMENT_ENV>/releases/...` (its presigned PUT is valid 15 minutes). `complete` makes a
  server-side copy (S3 CopyObject) under `<DEPLOYMENT_ENV>/release-artifacts/.../<random>/<file>`,
  a prefix no publisher is ever given a PUT for, and verifies that copy. The catalog stores the
  copy's key and the manifest presigns downloads for it only, so re-uploading to the upload URL
  after registration changes nothing devices get. CopyObject is a single request (fine up to 5 GB;
  installers are capped at 1 GB) and is supported by MinIO and Garage, the stores this API runs on.
  Upload objects are not deleted (small; clean `<env>/releases/` by hand if needed).
- **The signature is bound to the declared installer.** Besides verifying with the updater key,
  the signature's trusted comment (`file:<name>`, written by `tauri signer sign` and covered by the
  signature) must equal the declared `file_name`; otherwise 422 `updater_signature_file_mismatch`.
- **No race with a re-run.** Registration happens under the same per-version lock as a
  declaration, and only if the state is still "uploading" and every artifact row still has exactly
  the size, SHA-256, signature, file name and upload key that were verified; otherwise 409
  `release_changed_during_verification` and nothing is registered (run the workflow again).

Object storage: releases use the existing media bucket under `<DEPLOYMENT_ENV>/releases/<version>/...`
(uploads) and `<DEPLOYMENT_ENV>/release-artifacts/<version>/...` (verified copies, downloads).
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
   Migration `018_release_catalog.sql` runs at start (after `016_admin_recovery_codes` and
   `017_sync_attachment_archive`): new tables `app_releases`, `app_release_artifacts` (upload key
   and verified served key per installer),
   `release_publisher_keys` and the function `mfx_update_candidates`. It changes no existing table.
   It was numbered 016 before the merge with the base branch: a test database that applied the
   old `016_release_catalog` refuses to start (version 16 is now `016_admin_recovery_codes`);
   recreate that test database. No production database ever had it.
3. Add `RELEASE_UPDATER_PUBLIC_KEY=<public key>` to `.env` once the owner has created the key, then
   `docker compose up -d control-api`.
4. Check: `GET /health` is OK; Console > Updates shows the Releases tab; the API log has no
   `RELEASE_UPDATER_PUBLIC_KEY is not set` warning (when set).
5. With the public object-storage endpoint deployed: raise the body limit for release objects (see
   above), run the release workflow once, and check that the draft appears in the console.

**Rollback:** redeploy the previous images. Migration 018 only adds objects, so the previous API
works with them in place once version 18 is un-recorded in `schema_migrations` (the API refuses to
start on a migration it does not know; same procedure as `PHASE4_DEPLOY.md` "Rollback", with
version 18). To remove the objects as well, restore the `pg_dump` from step 1. Desktops that
already installed a newer release keep it (use Recall to move them back once the catalog is up).

## Audit

Every step is in the audit ledger (category `release`): `release_upload_declared`,
`release_registered`, `release_publish`, `release_recall`, `release_notes_edited`,
`release_publisher_key_create`, `release_publisher_key_revoke`.

## Tests

`api/scripts/update-manifest.integration.mjs` (`pnpm --filter maintafox-control-api run
test:update-manifest`, CI job "Object storage"): the whole chain against real Postgres and an
S3 server, including a real `tauri signer` signature vector.

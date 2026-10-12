# Continuous integration (Phase 3.6)

Workflow: `.github/workflows/ci.yml`, on every push and pull request. All jobs must pass.

| Job | What it runs | Same command locally |
|---|---|---|
| Lint, typecheck, console tests, build | ESLint (console + API + scripts, zero warnings), `tsc` for the console and the API, vitest, `vite build` | `pnpm lint`, `pnpm typecheck`, `pnpm --filter maintafox-control-api run typecheck`, `pnpm test`, `pnpm build` |
| API integration scripts | every script of `test:all` against a `postgres:16-alpine` service container (`TEST_DATABASE_ADMIN_URL`) | `pnpm --filter maintafox-control-api run test:all` (embedded Postgres when the variable is unset) |
| Backup and restore drill | `test:backup-drill` (plaintext → encrypted migration, encrypted restore and PITR with/without the key, nightly media copy from Garage and its encrypted restore) and `test:backup-keygen`, with the Ubuntu PostgreSQL 16 programs, `age` and the pinned Garage image | needs the PostgreSQL 16 programs, `age` and an S3-compatible server (`TEST_S3_*`; see deploy/BACKUP_AND_RESTORE.md §5) |
| Object storage on Garage | the image pinned in `docker-compose.yml` with the production `garage.toml` (`deploy/object-storage/ci-start-garage.sh`): `test:media-presign` (desktop upload/download through presigned URLs, pre-start check), `test:support-bundles`, `test:backup-offsite` (with `age`), `test:object-store-migrate` | `TEST_S3_*` / `OFFSITE_TEST_S3_*` pointing at any S3-compatible server, and `age` |
| Docker images | pulls every image referenced by `docker-compose.yml` (no exception), builds the API image, the backup image (`--target backup`, checks the programs it needs), the postgres image (`deploy/postgres`, checks `age` and PostgreSQL 16) and the console image | `docker build -f api/Dockerfile [--target backup] .`, `docker build deploy/postgres` |
| Read-only backup pull | `deploy/backup-pull/ci-test.sh`: the real SFTP container and the real `Pull-MaintafoxBackups.ps1` under PowerShell 7 (download + SHA-256, idempotent, read-only / SFTP-only / key-only, tampered file refused, retention) | needs docker, pwsh, age, ssh and sudo (Linux) |
| Dependency audit | `pnpm audit --audit-level high` | same |
| Secret scan | gitleaks 8.30.1 over the full git history | `gitleaks git . --redact` |

## Accepted audit advisories

`package.json` → `pnpm.auditConfig.ignoreGhsas`. Each entry must be listed here with its reason
and removed as soon as a fixed version exists.

| Advisory | Package | Why it is accepted |
|---|---|---|
| GHSA-vfj7-8cjw-p6xm (high, stack exhaustion on deeply nested brace patterns) | `braces` ≤ 3.0.3, no fixed version published | Only reached through Tailwind CSS 3 at **build time** (file watching/globbing of the `content` patterns in `tailwind.config.ts`, written by us). No user input ever reaches it; it is not in the API or the shipped console. Re-check when a fixed `braces` or Tailwind 4 migration is available. |

Patched transitive versions are forced with `pnpm.overrides` (proxy-addr, undici 7, postcss,
nanoid 3, browserslist, source-map-js); `vite` was raised to 6.4.4.

## Resolved: MinIO images can no longer be pulled (found and fixed 2026-10-12)

`minio/minio` and `minio/mc` stopped being published (Docker Hub and quay.io refuse anonymous
pulls; the upstream repository is archived). Tenant media moved to **Garage**, official image
pinned by digest (docs/deploy/OBJECT_STORAGE_DECISION.md, deploy/OBJECT_STORAGE.md). The CI pull
check covers every image again. The old MinIO image stays in the VPS cache only for the rollback
window of the migration (deploy/OBJECT_STORAGE.md §5).

## Accepted secret-scan findings

`.gitleaksignore` lists exact finding fingerprints (commit:file:rule:line) with a reason each.
Today: one test-only value (base64 of "too-short") in commit 300ae9c; in commit 7702ed3 the
`.env.example` placeholder for `S3_ACCESS_KEY` and the deliberately wrong secret of the media test.

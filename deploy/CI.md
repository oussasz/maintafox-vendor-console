# Continuous integration (Phase 3.6)

Workflow: `.github/workflows/ci.yml`, on every push and pull request. All jobs must pass.

| Job | What it runs | Same command locally |
|---|---|---|
| Lint, typecheck, console tests, build | ESLint (console + API + scripts, zero warnings), `tsc` for the console and the API, vitest, `vite build` | `pnpm lint`, `pnpm typecheck`, `pnpm --filter maintafox-control-api run typecheck`, `pnpm test`, `pnpm build` |
| API integration scripts | every script of `test:all` against a `postgres:16-alpine` service container (`TEST_DATABASE_ADMIN_URL`) | `pnpm --filter maintafox-control-api run test:all` (embedded Postgres when the variable is unset) |
| Backup and restore drill | `test:backup-drill` with the Ubuntu PostgreSQL 16 programs | needs the PostgreSQL 16 programs on PATH (see deploy/BACKUP_AND_RESTORE.md §5) |
| Off-site backup copy | `test:backup-offsite` against a MinIO container with `age` | needs an S3-compatible server and `age` |
| Docker images | builds the API image, the backup image (`--target backup`, checks the programs it needs) and the console image | `docker build -f api/Dockerfile [--target backup] .` |
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

## Known issue: MinIO images can no longer be pulled (found 2026-10-12)

`minio/minio` and `minio/mc` (the releases in `docker-compose.yml`) are refused by Docker Hub
("repository does not exist") and by `quay.io/minio` ("unauthorized"): MinIO stopped publishing
free container images. The VPS keeps working because both images are in its local Docker cache
(never run `docker image prune -a` there), but **a new or rebuilt server cannot start the media
store**. The CI pull check skips `minio/*` for that reason only. Options for the owner: build the
same MinIO release from source into our own image, use a maintained community build pinned by
digest, or move tenant media to another S3-compatible server (the API only needs S3 + presigned
URLs). The off-site backup test uses Adobe S3Mock, which is enough to prove the S3 calls.

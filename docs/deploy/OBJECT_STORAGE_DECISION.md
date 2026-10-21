# ADR: Replace MinIO with Garage for tenant media (2026-10-12)

**Status:** accepted on branch `claude/replace-minio-78312b`, not deployed.
**Operations, migration, rollback:** [`deploy/OBJECT_STORAGE.md`](../../deploy/OBJECT_STORAGE.md).

## Context

Tenant media (photos, attachments, documents) and diagnostic bundles live in one S3 bucket on the
VPS. Until now that was MinIO (`minio/minio:RELEASE.2025-01-20T14-49-07Z` and `minio/mc`). MinIO
stopped publishing images: Docker Hub and quay.io refuse anonymous pulls. The upstream repository
`github.com/minio/minio` is **archived**: the GitHub API reports `archived: true`, the last push on
2026-04-24 and the last release on 2025-10-15. The VPS still runs MinIO from its local image cache.
A rebuilt or new server cannot start object storage, and CI cannot pull the images either.

What the platform needs from the store. Sources: the code in `api/src/storage/object-store.ts`, the
desktop routes, and the backup tools.

| Need | Used by |
|---|---|
| S3 API, **path-style** URLs (`http://host/bucket/key`), AWS SDK for JavaScript v3 (3.1116) | API, backup tools |
| **Presigned PUT and GET** (SigV4 query auth, 15 min) that desktops call as they are | `/api/v1/sync/media/presign-*`, diagnostic bundles |
| HeadBucket, ListObjectsV2 (paged), GetObject, PutObject, DeleteObject; ETag = MD5 for a single PUT | health probe, bundle verification, backups |
| Protection of overwritten or deleted media for N days. Until now: bucket versioning plus a `NoncurrentVersionExpiration` rule | Phase 3 data protection |
| Small footprint: a 4 GiB VPS shared with Postgres, the API and nginx; the store's cap is 256–512 MB | VPS |
| Reproducible: an official image pinned **by digest**, pullable anonymously | deploy, CI |
| Data on our own infrastructure (no third-party cloud) | owner's requirement |

## Options considered

All facts were checked on 2026-10-12 against the projects' own repositories, registries and docs.
The links are at the end.

| | Licence | Maintained? (latest release) | Image, digest pinnable | Versioning + noncurrent expiry | Footprint / operations | Verdict |
|---|---|---|---|---|---|---|
| **Garage** (Deuxfleurs) | AGPL-3.0 | Yes: v2.4.1, 2026-09-08 (v2.4.0 2026-09-06, v2.3.0 2026-04-16) | `dxflrs/garage:v2.4.1@sha256:9c96caa2…d020` (multi-arch, ~20 MB, `FROM scratch`) | **No versioning.** Lifecycle supports only `Expiration` and `AbortIncompleteMultipartUpload` | One static binary, one TOML file. `--single-node --default-bucket` sets up the node, key and bucket from env vars (since v2.3.0). SQLite metadata. | **Chosen** |
| SeaweedFS | Apache-2.0 | Yes: 4.48, 2026-09-28; releases every week or two | `chrislusf/seaweedfs` | Versioning yes; `NoncurrentVersionExpiration` added in **4.18 (2026-04-02)**, still being fixed | Several roles (master, volume, filer, S3 gateway); much more to run and understand | Rejected: more moving parts, young lifecycle code |
| Ceph RGW | LGPL | Yes (Tentacle 20.2.x) | `quay.io/ceph/ceph` | Yes | Monitors plus OSDs; each OSD alone targets 4 GiB RAM by default (`osd_memory_target`). Does not fit the VPS | Rejected: far too heavy |
| Zenko / Scality CloudServer | Apache-2.0 | Yes: 9.5.0-preview.5, 2026-10-08 | `ghcr.io/scality/cloudserver` (the Docker Hub image is years old) | Versioning yes; lifecycle **expiry is run by Zenko's separate Backbeat service** (not verified in depth) | Node.js server plus a metadata backend; full lifecycle needs the Zenko stack | Rejected: the part we need is not single-container |
| versitygw (Versity) | Apache-2.0 | Yes: v1.8.0, 2026-09-04 | `versity/versitygw:v1.8.0@sha256:30292fc2…2499` | Versioning "experimental" (posix `--versioning-dir`); **no lifecycle** in the posix backend at v1.8.0 | Plain files on disk (nice for backups); a gateway, simple | Rejected: versioning experimental, no expiry |
| RustFS | Apache-2.0 | 1.0.0 GA on **2026-09-16**, 1.0.1 on 2026-10-03 | `rustfs/rustfs:1.0.1@sha256:1803faef…a3c` | Claimed yes | MinIO-like design, GA for under a month | Rejected for now: too new for the only copy of customer data |
| MinIO built from source (AGPL) | AGPL-3.0 | **Upstream archived** (last release 2025-10-15) | We would build and host our own image | Yes (unchanged behaviour) | Same as today, but **we would own all security fixes** of an archived codebase | Rejected: unmaintained |
| MinIO community fork `pgsty/silo` | AGPL-3.0 | Yes: RELEASE.2026-09-16; repository active | `pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb…1a46` | Yes (the MinIO codebase) | Drop-in for today's setup | Rejected: a fork of an archived codebase run by a single small team. Its long-term maintenance is the risk we are leaving MinIO to escape. Best fallback if Garage ever disappoints. |

## Decision

**Garage v2.4.1**, official image `dxflrs/garage`, pinned by digest in `docker-compose.yml`.
Single node, one copy of the data, SQLite metadata, `metadata_fsync` and `data_fsync` on,
metadata snapshots every 6 h. Configuration is in `deploy/object-storage/garage.toml`, with no
secrets in it.

Why Garage:

1. **Maintained, with a stable release line.** It is developed since 2020 by a non-profit
   collective (Deuxfleurs), with regular releases in 2026. We pin a stable release, not a
   development build.
2. **Simplest thing that works on one small server.** One process, one file, no extra services.
   The access key and bucket are created from `.env` on first start, and Garage **refuses to
   start** if they no longer match. The deploy cannot quietly drift.
3. **Every S3 feature the API and the desktops use is supported:** path-style, presigned URLs,
   ListObjectsV2, Head*, ETag = MD5. This is proven in CI against the same pinned image and the
   same `garage.toml` (§ Verification).
4. **Self-hosted and reproducible.** The image is pulled anonymously by digest, so CI and a fresh
   server get the same bytes.

### Versioning: what replaces it (said plainly)

**Garage has no object versioning.** The old protection was "an overwritten or deleted object stays
recoverable for `MINIO_NONCURRENT_VERSION_RETENTION_DAYS` days, inside MinIO". It is replaced by our
own copy in the backups: `api/src/tools/media-backup.ts`, run every night by `backup.sh`.

- Every object is copied into the backup volume (`/backups/media/current/`), **age-encrypted to the
  owner's key** like every other backup file.
- When an object is deleted or overwritten in the bucket, the next night moves its last copy to
  `/backups/media/removed/<night>/` and keeps it `MEDIA_BACKUP_REMOVED_RETENTION_DAYS` days.
- The copies are listed in `SHA256SUMS`, so **the on-premise pull downloads them**. MinIO's
  versions lived only on the VPS disk.
- `media-backup.js restore` puts copies back into the bucket, with the owner's key.

What is weaker than versioning: a change and its undo **within the same day** (before the nightly
run) are not kept. Media keys contain the SHA-256 of the content, so an "overwrite" with different
bytes under the same key does not happen in normal use. What is stronger: the copy is encrypted, is
in the backups, and leaves the server.

The cost is disk space: the media are stored twice on the VPS (bucket plus encrypted copy), plus
the removed copies for N days.

### A client-side fix this switch requires

Since AWS SDK v3.729, `getSignedUrl(PutObject)` adds `x-amz-checksum-crc32=AAAAAA==` (the CRC32 of
an **empty** body) to every presigned PUT URL. MinIO ignored it. Garage verifies it, which would
reject every real upload. The S3 client is now created with
`requestChecksumCalculation: "WHEN_REQUIRED"` (`createS3Client` in `object-store.ts`), and presigned
URLs no longer carry that parameter. Upload integrity is still checked by our own SHA-256
comparisons. Desktops need no change: they call the URL they are given.

## Consequences

- New: services `object-store` (Garage) and `object-store-check`. The check is a one-shot run
  before the API starts. It proves the bucket exists and that a presigned PUT and GET round-trip,
  and fails with one readable line otherwise. `minio` and `minio-init` are removed.
- Settings: `S3_*` keep their names, and all are now required with no defaults. New:
  `S3_REGION=garage` and `GARAGE_RPC_SECRET`. `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` and
  `MINIO_NONCURRENT_VERSION_RETENTION_DAYS` are gone; the replacement is
  `MEDIA_BACKUP_REMOVED_RETENTION_DAYS`. The API no longer creates a missing bucket. It answers
  503 `object_storage_bucket_missing` instead of silently starting an empty bucket.
- One-time migration of every object with full SHA-256 verification, and a rollback path:
  `deploy/OBJECT_STORAGE.md` §4–§5.
- Garage's data format is its own (content-addressed blocks plus a metadata DB). The supported way
  to get data out is the S3 API: `media-backup` and `object-store-migrate` both use it.

## Verification

CI starts the image pinned in `docker-compose.yml` with the production `garage.toml`
(`deploy/object-storage/ci-start-garage.sh`) and runs:

- `test:media-presign`: desktop upload and download through presigned URLs, ETag = MD5, tenant
  isolation, tampered URL refused, missing bucket gives 503, and the pre-start check passes or fails
  as it should.
- `test:support-bundles` and `test:backup-offsite`.
- `test:object-store-migrate`: copy, idempotence, SHA-256 verify, and repair of a changed or
  missing object.
- `test:backup-drill`: the nightly backup copies media, keeps deleted and overwritten objects
  encrypted, and restores them with the owner's key.

The compose pull check now covers every image, with no MinIO exception.

Not verified here: the MinIO-specific inventory of old versions (`ListObjectVersions`). MinIO
cannot be pulled in CI. It runs against the real MinIO in the rehearsal on the server
(`deploy/OBJECT_STORAGE.md` §4).

## Sources (read 2026-10-12)

- Garage S3 compatibility, configuration, quick start (tag v2.4.1):
  `https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.4.1/doc/book/reference-manual/s3-compatibility.md`,
  `.../configuration.md`, `.../doc/book/quick-start/_index.md`. Single-node and default-bucket
  behaviour: `src/garage/server.rs`. Key import rules: `src/model/key_table.rs`. Licence:
  `LICENSE` (AGPL-3.0). Releases: `https://git.deuxfleurs.fr/api/v1/repos/Deuxfleurs/garage/releases`.
- Garage image digest: `registry-1.docker.io/v2/dxflrs/garage/manifests/v2.4.1`
  (`docker-content-digest: sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`,
  a manifest list).
- MinIO archived: `https://api.github.com/repos/minio/minio`.
- SeaweedFS 4.18 release notes (PR #8810, "lifecycle worker: NoncurrentVersionExpiration support"):
  `https://github.com/seaweedfs/seaweedfs/releases/tag/4.18`.
- versitygw v1.8.0: `README.md` (`--versioning-dir`); `backend/backend.go` and
  `backend/posix/posix.go` have no lifecycle methods.
- RustFS, versitygw, CloudServer, silo releases: the GitHub releases API of each repository.
  Docker Hub tag digests: `https://hub.docker.com/v2/repositories/<ns>/<repo>/tags`.
- Ceph memory: `osd_memory_target` default 4 GiB, Ceph documentation "Hardware Recommendations".

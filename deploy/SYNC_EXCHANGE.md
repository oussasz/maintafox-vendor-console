# Sync Exchange (control API)

## What is live

- `POST /api/v1/sync/exchange` with `protocol_version: "v1"` (this document) or `"v2"`
  (**`deploy/SYNC_PROTOCOL_V2.md`**: conflicts, tombstones, signed per-device checkpoints,
  snapshot, per-user scope). v1 is kept for desktops that are not updated yet.
- v1: validation, request idempotency (per tenant), ingress persist, **cross-machine fan-out**,
  checkpoint freeze on permanent rejects. Since Phase 2.1 the v1 exchange is one Postgres
  transaction, its device cursor advances only with the stored response, and a device whose
  recent rows are all its own is no longer starved. v1 writes also update the v2 current state.
- `POST /api/v1/sync/media/presign-put` / `presign-get` — TenantMedia via the S3-compatible object
  store (Garage, `deploy/OBJECT_STORAGE.md`). 503 `object_storage_unavailable` when S3 is not
  configured or unreachable, 503 `object_storage_bucket_missing` when the bucket is gone.
- Store: **Postgres only** (`DATABASE_URL` is required). The SQLite fallback was removed.

Code: `api/src/sync/`, `api/src/storage/object-store.ts`, migrations `api/migrations/`.

## Local verification (no Docker)

```bash
cd api
pnpm run test:sync-exchange-ab   # v1: machine A push -> machine B inbound
pnpm run test:sync-v2            # v2 protocol suite
pnpm run test:all                # every API suite
```

The scripts start a throwaway embedded PostgreSQL 16 (dev dependency `embedded-postgres`), or
use `TEST_DATABASE_ADMIN_URL` (e.g. a docker postgres in CI) when it is set.

## Compose (Postgres + Garage)

1. Copy `.env.example` → `.env` and set `JWT_SECRET`, `SEED_ADMIN_PASSWORD`.
2. `docker compose up -d --build`
3. API receives `DATABASE_URL` pointing at `postgres` and `S3_*` pointing at `object-store`
   (Garage); `object-store-check` must succeed before the API starts.

## Desktop smoke

1. Build desktop with `VITE_ADMIN_API_BASE_URL` → your API base.
2. Two activated machines, same tenant.
3. Mutate on A → sync → confirm on B; Sync Center header should clear after success (not permanent red).

## “Exchange live” criteria

- [x] Peer `inbound_items` non-empty after A pushes
- [x] Checkpoint frozen when `rejected_items` present
- [x] Idempotent replay returns same `server_batch_id`
- [x] Additive `device_class` / `media_manifest` accepted (no 400 from `.strict()` body)
- [x] Media presign routes present (503 when S3 env unset), tested end to end by
      `test:media-presign` against Garage

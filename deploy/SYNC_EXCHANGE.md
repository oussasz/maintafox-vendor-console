# Sync Exchange (control API)

## What is live

- `POST /api/v1/sync/exchange` — validation, request idempotency, ingress persist, **cross-machine fan-out**, checkpoint freeze on permanent rejects.
- `POST /api/v1/sync/media/presign-put` / `presign-get` — TenantMedia via MinIO/S3 (optional).
- Sync store: **Postgres** when `DATABASE_URL` is set; **SQLite** fallback for local `pnpm api:start` without Postgres.

Code: `api/src/sync/`, `api/src/storage/object-store.ts`, migration `api/migrations/001_sync_mirror.sql`.

## Local verification (no Docker)

```bash
cd api
pnpm run build
pnpm run test:sync-exchange-ab
```

Uses SQLite sync fallback. Proves machine A push → machine B inbound.

## Compose (Postgres + MinIO)

1. Copy `.env.example` → `.env` and set `JWT_SECRET`, `SEED_ADMIN_PASSWORD`.
2. `docker compose up -d --build`
3. API receives `DATABASE_URL` pointing at `postgres` and `S3_*` pointing at `minio`.

## Desktop smoke

1. Build desktop with `VITE_ADMIN_API_BASE_URL` → your API base.
2. Two activated machines, same tenant.
3. Mutate on A → sync → confirm on B; Sync Center header should clear after success (not permanent red).

## “Exchange live” criteria

- [x] Peer `inbound_items` non-empty after A pushes
- [x] Checkpoint frozen when `rejected_items` present
- [x] Idempotent replay returns same `server_batch_id`
- [x] Additive `device_class` / `media_manifest` accepted (no 400 from `.strict()` body)
- [x] MinIO presign routes present (503 when S3 env unset)

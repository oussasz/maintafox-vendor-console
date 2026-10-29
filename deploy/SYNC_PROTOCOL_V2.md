# Sync protocol v2 (control API)

Status: **contract frozen for Phase 2.2 / 2.3** (2026-10-10). Changes after this point are additive
only and are recorded in the changelog at the end of this file.

v1 (`deploy/SYNC_EXCHANGE.md`) keeps working unchanged on the same endpoint for desktops that have
not been updated. The server picks the protocol from `protocol_version` in the request body.

## 1. Endpoints

| Method + path | Purpose |
|---|---|
| `POST /api/v1/sync/exchange` | Push outbox items and pull inbound deltas (v1 or v2 by `protocol_version`). |
| `POST /api/v1/sync/snapshot` | v2 only. Paged current state for bootstrap; the last page returns a checkpoint for deltas. |
| `POST /api/v1/sync/media/presign-put` / `presign-get` | Unchanged from v1 (a removed phone: presign-put only, see below). |
| `POST /api/v1/sync/diagnostic-bundles`, `POST /api/v1/sync/diagnostic-bundles/:id/complete` | Support: upload a diagnostic bundle (presigned PUT, verified by size and SHA-256; optional ticket). See `deploy/SUPPORT.md`. |

All routes need the device activation token (`Authorization: Bearer <activation token>`) and go
through the same licence/activation checks as v1 (`401 token_superseded`,
`403 tenant_inactive | license_revoked | license_expired | activation_revoked`).
The device identity is the activation's `(tenant_id, machine_fingerprint)`; nothing in the body can
change it.

### Phones removed by their administrator

A phone removed from the customer's desktop (`POST /api/v1/mobile-devices/:id/revoke`, or
`revoke-person`) gets `403 device_wipe_required` on every route except, for 168 hours
(`WIPE_UPLOAD_WINDOW_HOURS`), these three (POST):

- `/api/v1/sync/exchange`: v2 only, push only (no inbound items, conflicts or user snapshots; the
  checkpoint does not move). Its `media_manifest` is recorded as usual.
- `/api/v1/sync/media/presign-put`: only for a file of its own work: an `object_key` this phone
  reported in a `media_manifest` entry with the same `content_sha256`, whose `media_attachments`
  record this phone pushed, and the key must be `{env}/media/{tenant}/{parent_entity_type}/{parent_entity_sync_id}/{content_sha256}`
  matching the body. Otherwise `403 media_not_from_this_device`. So: exchange first (record +
  manifest), then presign-put. Same limits as any device (15-minute URL, 32 MiB per object at the
  media route). `presign-get` stays refused (`device_wipe_required`).
- `/api/v1/mobile-device/wipe-confirmed`: optional strict body
  `{ "dropped": { "total": <int >= 0>, "by_kind": { "<kind, 1-64 chars>": <int >= 0>, ... at most 32 } } }`
  (what was erased unsent, kept in the `mobile_device_wiped` audit entry); `{}` or no body is
  accepted; anything else is `400 invalid_request` and changes nothing.

`403 activation_revoked` tells a phone to erase without uploading only when it carries the marker:
`{ "error": "activation_revoked", "message": "...", "wipe": "without_upload", "reason": "lost" | "upload_window_closed" }`
(reported lost; or removed by its administrator and past the window or already wiped). That answer
comes before the tenant and licence checks. Every other `activation_revoked` (no activation row, e.g.
after a database restore; a vendor revocation; a released slot) has no `wipe` field: the phone locks
and keeps its data.


## 2. Entity registry

`shared/sync-entity-registry.v2.json` (in this repository) is the allowlist. Each entry is
`{ "entity_type": "...", "scope": "tenant" | "user", "append_only": true | false }`.

- `scope: "tenant"`: delivered to every device of the tenant. `owner_user_sync_id` must be absent
  or `null`.
- `scope: "user"`: `owner_user_sync_id` is required. The item is delivered only to devices whose
  request lists that user in `current_user_sync_ids`.
- An entity type that is not in the registry is rejected per item with `unknown_entity_type`.
- `append_only: true` marks history types (the desktop's `conflict_policy` `append_only`, mirrored
  exactly and checked by `packages/contracts/scripts/sync-registry-drift.mjs`). A `delete` or
  `archive` of such a type is rejected with `operation_not_allowed_for_type` (§3.1), except
  `media_attachments`, whose deletes the desktop replicates by design. Upserts are not refused.
  The flag is required on every entry; adding it to existing entries is an additive change (no
  entry is renamed or removed).
- The file is append-only: entries are never renamed or removed. A new entity type is added to the
  file in the same change that makes the desktop stage it. The desktop keeps a copy and should
  check it in CI against this file.

Seeded from the desktop `SYNC_ENTITY_*` constants (63 types) and appended since, generated from
the desktop registry with its `scripts/sync-allowlist-append.mjs` (229 types in October 2026).
Eight are `user`-scoped: `user_dismissals`, `notifications`, `notification_acknowledgements`,
`notification_preferences`, `report_schedules`, `saved_activity_filters`,
`user_dashboard_layouts` and `user_analytics_dashboard_layouts`; every other type is `tenant`.

## 3. Exchange request (v2)

```jsonc
{
  "protocol_version": "v2",
  "idempotency_key": "string 8..128",          // unique per device per logical request
  "checkpoint_token": "string | null",          // last token received from the server; null = from the beginning
  "current_user_sync_ids": ["user-sync-id"],    // 0..100 users signed in / known on this device
  "device_class": "desktop",                    // "desktop" | "mobile", required in v2
  "tenant_config": {                            // optional; validated and stored
    "tenant_id": "must equal the activation tenant",
    "is_activated": true,
    "company_display_name": "string | null"
  },
  "media_manifest": [                           // optional, 0..1000 entries; validated and stored
    { "entity_sync_id": "…", "content_sha256": "64 hex", "object_key": "{env}/media/{tenant}/…", "byte_size": 0 }
  ],
  "outbox_batch": [                             // 0..1000 items
    {
      "idempotency_key": "string 1..256",       // per item, unique per tenant forever
      "entity_type": "registry type",
      "entity_sync_id": "string 1..256",
      "operation": "create",                    // create | update | delete | upsert | archive
      "row_version": 1,                         // integer >= 1
      "base_row_version": null,                 // integer >= 1, or null when the device creates the row
      "owner_user_sync_id": null,               // required for user-scoped types, else null/absent
      "payload_json": "string (valid JSON)",
      "payload_hash": "sha256 hex of payload_json (optional 'sha256:' prefix)"
    }
  ]
}
```

Unknown top-level or item keys are rejected (`400 validation_error`). `base_row_version` is
required on every item (use `null` explicitly for a create).

### 3.1 Item rules (evaluated in batch order)

1. Field validation, in this order: entity type format → registry membership → operation rule
   (`operation_not_allowed_for_type`: `delete` / `archive` of an `append_only` type other than
   `media_attachments`; also applied to v1 pushes of registry types, §7) → owner rule →
   payload hash format → hash matches `payload_json` → `payload_json` parses → row-version rule:
   `row_version` must equal `base_row_version + 1`, or `1` when `base_row_version` is `null`.
2. Item idempotency: if this item `idempotency_key` was already applied for the tenant **with the
   same entity, row version and payload hash**, the item is acknowledged again with
   `"duplicate": true` and nothing changes. The same key with different content is rejected with
   `item_idempotency_key_reused`. A key repeated inside one batch is rejected with
   `duplicate_item_in_batch`. An item whose `row_version` and payload hash already equal the
   server's current state is also acknowledged as `duplicate` (covers a retry whose log row was
   compacted); its `server_seq` is the state's.
3. Conflict check against the server current state of `(tenant, entity_type, entity_sync_id)`:
   - entity unknown on the server → applied (whatever `base_row_version` is).
   - entity known and `base_row_version` is `null` → **conflict** (create over an existing row).
   - entity known and `base_row_version != server row_version` → **conflict**.
   - otherwise applied.

   A conflicting item is never applied and never stored in the log. It is returned in
   `conflict_items` with the server row so a person can decide. Later items in the same batch see
   the state left by earlier applied items.
4. Applied items are appended to the log (`server_seq` assigned) and upserted into the current
   state. `operation: "delete"` stores a **tombstone** (state kept with `deleted = true`, delivered
   to other devices as a `delete`). Any later applied item on the same entity revives it.

Item failures never fail the whole request and never block the inbound cursor (v2 has no
checkpoint freeze, unlike v1).

## 4. Exchange response (v2)

```jsonc
{
  "protocol_version": "v2",
  "server_batch_id": "batch_<hex>",
  "checkpoint_token": "v2.<payload>.<signature>",   // store it; send it back on the next exchange
  "acknowledged_items": [
    { "idempotency_key": "…", "entity_type": "…", "entity_sync_id": "…", "operation": "update",
      "row_version": 3, "server_seq": 1234, "duplicate": false }
  ],
  "rejected_items": [
    { "idempotency_key": "…", "entity_type": "…", "entity_sync_id": "…", "operation": "update",
      "rejection_code": "unknown_entity_type", "rejection_message": "…" }
  ],
  "conflict_items": [
    {
      "idempotency_key": "…", "entity_type": "…", "entity_sync_id": "…",
      "local_row_version": 3,               // the item's row_version
      "local_base_row_version": 2,          // the item's base_row_version (null for a create)
      "server_row_version": 4,
      "server_operation": "update",
      "server_payload_json": "…",
      "server_payload_hash": "…",
      "server_owner_user_sync_id": null,
      "server_deleted": false
    }
  ],
  "inbound_items": [
    { "server_seq": 1240, "entity_type": "…", "entity_sync_id": "…", "operation": "update",
      "row_version": 5, "payload_json": "…", "payload_hash": "…", "owner_user_sync_id": null,
      "deleted": false }
  ],
  "has_more": false,               // true: call exchange again (an empty outbox is fine) with the new checkpoint
  "user_snapshot_required": [],    // users first seen on this device: run a scope "user" snapshot for them
  "policy_metadata_json": null     // reserved; always null today
}
```

`rejection_code` values: `invalid_entity_type`, `unknown_entity_type`,
`missing_owner_user_sync_id`, `unexpected_owner_user_sync_id`, `invalid_payload_hash`,
`payload_hash_mismatch`, `invalid_payload_json`, `invalid_row_version`,
`item_idempotency_key_reused`, `duplicate_item_in_batch`.

### 4.1 Inbound delivery

- Inbound is read from the **current state**, so it is collapsed: one item per entity (its latest
  state) for every entity changed after the request checkpoint, in `server_seq` order. Tombstones
  are delivered with `operation: "delete"` and `deleted: true`.
- Not delivered: entities whose latest change came from this device (it already has them), and
  user-scoped entities whose owner is not in `current_user_sync_ids`.
- At most 100 inbound items per response (`SYNC_INBOUND_BATCH_LIMIT`). When `has_more` is true the
  token points at the last delivered item; otherwise it points at the tenant high-water mark, so
  skipped rows (own rows, other users' rows) are passed over and never stall the device.
- Apply inbound items before storing the new token. If the response is lost, retry with the same
  `idempotency_key` (stored response replayed) or with the old token (changes recomputed).
- A user reported in `current_user_sync_ids` is listed in `user_snapshot_required` until a
  snapshot that includes the user (`scope: "user"` or `"all"`, same `current_user_sync_ids`)
  completes on that device, i.e. its last page is served. Their older personal items are not in
  the delta. The list therefore survives a lost response; after a bootstrap snapshot it is empty.
- After a local database reset or restore, the device must bootstrap again with a snapshot: the
  delta never re-sends rows the device wrote itself.

### 4.2 Request-level outcomes

| HTTP | `error` | Meaning / desktop action |
|---|---|---|
| 200 | — | Normal response (also an idempotent replay). |
| 400 | `validation_error` | Body shape invalid. Do not retry unchanged. |
| 400 | `invalid_checkpoint_token` | Bad signature, other tenant/device, or malformed. Bootstrap with a snapshot. |
| 409 | `checkpoint_ahead_of_server` | Token is newer than the server data (server restore). Bootstrap with a snapshot. |
| 409 | `idempotency_key_reused` | Same `idempotency_key` with a different body. Generate a new key. |
| 409 | `tenant_config_mismatch` | `tenant_config.tenant_id` is not the activation tenant. Do not retry. |
| 400 | `media_manifest_invalid` | An entry is malformed or its `object_key` is outside the tenant. |
| 401/403 | activation errors | As v1. |
| 429 | `rate_limited` | Back off and retry with the same key. |
| 500 | `sync_exchange_failed` | Nothing was committed. Retry with the same key. |

### 4.3 Idempotency and atomicity

- `idempotency_key` is scoped to the device `(tenant, machine_fingerprint)`. The server stores the
  SHA-256 of the canonical request body (object keys sorted, no whitespace). Same key + same body →
  the stored response is returned unchanged. Same key + different body →
  `409 idempotency_key_reused`.
- One Postgres transaction covers the idempotency check, log append, conflict checks, state
  upserts, device checkpoint and stored response: all of it commits or none of it does. Exchanges
  of one tenant are serialized with a transaction-scoped advisory lock, which also guarantees that
  `server_seq` values become visible in order (no gap can appear behind a delivered checkpoint).
- Stored responses are kept for `SYNC_IDEMPOTENCY_RETENTION_DAYS`. After that a reused key is
  treated as new; its items are then acknowledged as `duplicate`.

## 5. Checkpoint token

`v2.<base64url(JSON payload)>.<base64url(HMAC-SHA256(SYNC_CHECKPOINT_SECRET, "v2." + payload))>`,
payload `{ "k": "cp", "t": tenant_id, "d": machine_fingerprint, "s": server_seq, "i": issued_at }`.

Opaque to the desktop: store it and send it back as is. The server checks the signature, that `t`
and `d` match the activation, and that `s` is not above the tenant high-water mark. `null` means
`server_seq = 0` (every current row, including tombstones; prefer a snapshot for bootstrap). A v1
token (`cp-…`) sent in a v2 request is `invalid_checkpoint_token`.

## 6. Snapshot

Request:

```jsonc
{
  "protocol_version": "v2",
  "page_token": null,               // null on the first page, then next_page_token
  "page_size": 500,                 // required, 1..1000
  "scope": "all",                   // "all" | "user" ("user": only user rows of current_user_sync_ids)
  "current_user_sync_ids": ["…"]
}
```

Response:

```jsonc
{
  "protocol_version": "v2",
  "items": [ /* inbound_items shape; never tombstones */ ],
  "has_more": true,
  "next_page_token": "string | null",
  "checkpoint_token": "string | null"   // only on the last page
}
```

- The first page fixes the snapshot at the tenant high-water mark `H`. Pages contain non-deleted
  rows last changed at or before `H`, ordered by `(entity_type, entity_sync_id)`. Rows changed after
  `H` are left out of the snapshot and arrive through the delta from the final checkpoint (`H`), so
  nothing is missed or duplicated across pages.
- `scope: "all"` returns tenant rows plus the user rows of `current_user_sync_ids`, including rows
  this device wrote.
- After the last page, store `checkpoint_token` and continue with exchanges. For `scope: "user"`,
  keep the existing exchange checkpoint; the user snapshot's checkpoint can be ignored.
- `page_token` is signed and bound to tenant, device, `H`, scope and user list. Changing any of them
  mid-snapshot → `400 invalid_page_token` (restart from page 1).

## 7. Mixed fleets (v1 and v2 devices)

- v1 pushes go to the same log. For **tenant-scoped registry types** they also update the current
  state; having no `base_row_version`, they are applied last-write-wins (`row_version` as sent),
  as v1 always did. v1 pushes of user-scoped or unregistered types stay in the log only (v1 has no
  owner, so they would otherwise reach every device): v2 devices do not receive them.
- v1 devices keep reading the log with their v1 cursor, so they receive v2 writes as before.
- A v1 `delete` / `archive` of an `append_only` registry type (other than `media_attachments`) is
  rejected with `operation_not_allowed_for_type`, like any v1 rejection (the v1 checkpoint does not
  advance for that request).
- v1 fixes without a wire change: the exchange is atomic, the v1 cursor advances only together with
  the stored response, and a device whose recent rows are all its own is no longer starved.

## 8. Retention

A background job runs every `SYNC_RETENTION_INTERVAL_MINUTES`:

- Log compaction deletes log rows that every active (non-revoked) device has passed (the lowest of
  their acknowledged v2 checkpoints and v1 cursors; an active device that never synced counts as
  0 and blocks compaction) **and** that are older than `SYNC_INGRESS_RETENTION_DAYS`. A device
  revoked during a compaction and reinstated later may miss compacted rows: v2 devices recover with
  a snapshot. Current state and tombstones are never compacted, so v2 delivery
  does not depend on the log.
- Stored exchange responses older than `SYNC_IDEMPOTENCY_RETENTION_DAYS` are deleted.

## 9. Server configuration

| Variable | Rule |
|---|---|
| `DATABASE_URL` | Required. All API data lives in Postgres. |
| `SYNC_CHECKPOINT_SECRET` | Required, at least 32 characters. Rotating it invalidates every checkpoint and page token (devices re-snapshot). |
| `SYNC_INGRESS_RETENTION_DAYS` | Required integer 1..3650. |
| `SYNC_IDEMPOTENCY_RETENTION_DAYS` | Required integer 1..3650. |
| `SYNC_RETENTION_INTERVAL_MINUTES` | Required integer 5..1440. |

## 10. Server storage notes (not part of the wire contract)

- The log is `sync_mirror_ingress` (`id` = `server_seq`); the current state is
  `sync_entity_state` with `payload_raw` (byte-exact text, what is delivered and hashed) and
  `payload_json` (JSONB copy for queries, NULL only if Postgres cannot store the JSON, e.g. a
  ` ` escape).
- Conflicts are logged in `sync_conflict_log`, device positions in `sync_device_checkpoint`,
  reported users in `sync_device_user`, media manifests in `sync_media_manifest`.

## Changelog

- 2026-10-10: first version.
- 2026-10-10: §3.1 rule 2 also acknowledges an item equal to the current state as `duplicate`
  (additive; implemented with the first server release).
- 2026-10-10: §4.1 `user_snapshot_required` repeats until a covering snapshot completes (was: listed
  once). §7 v1 user-scoped/unregistered types stay out of the v2 state. §8 never-synced devices
  block compaction. All in the first server release.
- 2026-10-12 (Phase 3): additive. Diagnostic bundle endpoints (above). `user_accounts` payloads and
  stored exchange responses are encrypted at rest; delivered bytes and `payload_hash` are unchanged
  (`deploy/TENANT_ISOLATION.md`). Idempotent replays are counted for the ops metrics.
- 2026-10-20: §2 registry entries carry `append_only`; §3.1 new per-item rejection
  `operation_not_allowed_for_type` (delete/archive of append-only history, v1 and v2; existing
  `rejected_items` shape). Server-side only: accepted deletes and overwrites of attachment types are
  archived and can be restored by an operator as a new server-originated change
  (`deploy/SYNC_OPERATIONS.md`).

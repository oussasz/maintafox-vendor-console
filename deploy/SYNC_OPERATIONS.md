# Sync operations per device (Phase 4.5)

Code: `api/src/routes/sync-operations.ts` (timeline, resynchronisation), `api/src/sync/exchange-v2.ts`
and `api/src/sync/snapshot.ts` (what the device sees); console
`src/vendor-console/components/SyncDeviceTimeline.tsx` (Sync page, permission `sync.operate`).
Migration `015_sync_resync_requests.sql`. Test: `api/scripts/sync-operations.integration.mjs`
(in `test:all`, real sync v2 protocol).

**Device timeline** (`GET /api/v1/ops/devices/:tenant/:machine/timeline?hours=`, 1 h to 30 days):
only what the server recorded — each exchange (and its retries after a lost answer), each refused
item (id, reason), each conflict (device version vs server version), resynchronisations, and
operator actions on that machine from the audit log — plus the measured lag and checkpoint age.

**Repair: full resynchronisation** (`POST …/resync`, reason + step-up `sync_repair`, audited
`sync_device_resync`). The device's next sync is told its copy is out of date
(`400 invalid_checkpoint_token`, which today's desktop already answers by keeping its unsent
changes, downloading a full snapshot, then sending them). The request closes when that snapshot
completes; the timeline shows both steps.

**Replay of refused items is not a server action.** The server stores only the id and reason of a
refused item, never its content, so it cannot replay it. The device keeps refused items (its dead
letters) and replays them from its own Sync Center once the cause is fixed. The console's repair
queue used to list "replay / requeue / acknowledge / escalate" as allowed actions without any
server behind them; that column is removed.

## Deploy checklist

1. **Migration** `015_sync_resync_requests.sql`: table `sync_device_resync_request` (tenant
   isolation like the other sync tables).
2. **Environment:** nothing new.
3. **Desktop contract:** unchanged codes only (`invalid_checkpoint_token` already exists).
4. Rebuild and restart the API and console images.
5. Check: Sync page → Device timeline for a live device lists its recent syncs.

**Rollback.** `DELETE FROM schema_migrations WHERE version = 15` (and later ones) before starting
the previous images. An open resynchronisation request is then simply ignored. Re-deploying later:
`DROP TABLE sync_device_resync_request;` first.

# Deleted attachments and the forensic device log (CMMS Advisor decision 2026-10-20)

> **NEW MIGRATION `017_sync_attachment_archive`** (new tables only: `sync_deleted_attachment_archive`,
> `sync_forensic_change_log`, tenant row-level security like the other sync tables). New step-up kind
> `sync_attachment_restore` in `shared/step-up-actions.v1.json` (console-only for now:
> `rust_variant: null`).

Code: `api/src/sync/attachment-archive.ts` (hooks called by `exchange-v1.ts` / `exchange-v2.ts`,
listing, restore), routes in `api/src/routes/sync-operations.ts`; console
`src/vendor-console/components/DeletedAttachmentsPanel.tsx` (customer page, Sync tab, permission
`sync.operate`). Test: `api/scripts/sync-attachment-archive.integration.mjs` (in `test:all`; in the
CI object-storage job it also proves the restored file is byte-identical).

**Why.** The sync server knows the sending device (activation token: licence + machine fingerprint),
never the person, so it cannot prove who deleted something. Photos and attachments are the only
history that sync may delete, so the server keeps what was deleted and lets an operator put it back.

**Archive.** When an exchange (v1 or v2) accepts a `delete` or `archive` of `media_attachments`,
`asset_photos`, `di_attachments` or `work_order_attachments`, the same transaction copies the state
the server held just before it (payload exactly as stored, row version, operation, owner, origin
device, object key / checksum / size from the payload and the media manifest) and the deleting
device (licence id, fingerprint, time) into `sync_deleted_attachment_archive`. A delete of something
the server never held is recorded as `unknown`, a delete of a delete marker as `already_deleted`
(neither can be restored). What the device is told (accepted / refused / conflict) does not change.
The stored file is never deleted: the API has no code that deletes tenant media objects (checked by
the test), so a restore only has to bring the row back.

**Listing.** `GET /api/v1/tenants/:tenantId/sync/deleted-attachments[?status=all|open|restored]`
(`sync.operate`, newest first, at most 500): entity type and id, deleted at, deleting device,
checksum and size, restored (when, by whom, reason), and why it cannot be restored now if so. Never
the payload or the file.

**Restore.** `POST /api/v1/tenants/:tenantId/sync/deleted-attachments/:archiveId/restore`
(`sync.operate`, `X-Operator-Reason`, step-up `sync_attachment_restore`, optional `Idempotency-Key`;
audited `sync_attachment_restored`, category `sync_repair`, identifiers only). Under the tenant sync
lock (taken before the audit-chain lock, like every sync writer) it checks that the current state is
still exactly the delete the archive entry followed, then appends a new change from origin
`server:attachment-restore`: the prior payload byte for byte (same `payload_hash`), operation as
before the delete, `row_version` = current + 1 with `base_row_version` = current. Every device, the
one that deleted it included, receives it like a change from another device (v2 delta, snapshot,
v1 log); a media attachment received again queues its file download on the desktop. Refusals:
`404 archive_not_found | tenant_not_found`, `409 already_restored | nothing_to_restore |
entity_changed_since_delete` (re-created, edited or deleted again since: restoring would overwrite
that change). A device edit made from an older version after the restore gets the usual conflict.

**Forensic device log.** Every accepted change of `site_settings` (including the three-person
lock-removal rule), `site_setting_events` and `permit_types` adds one row to
`sync_forensic_change_log`: tenant, entity type and id, operation, row version, base version,
server_seq, payload hash (never the payload), licence id, machine fingerprint, protocol, received at.
The ingress log also has the fingerprint but no licence id, and retention compacts it after
`SYNC_INGRESS_RETENTION_DAYS`; the forensic log is append-only (an UPDATE trigger refuses any change,
and `UPDATE` is revoked from `mfx_app`) and retention never touches it, nor the archive. Both are
removed only with their tenant (tenant delete). Growth is one small row per settings change.

## Deploy checklist (017)

1. **Migration** `017_sync_attachment_archive.sql` runs at API start (additive).
2. **Environment:** nothing new.
3. **Desktop contract:** unchanged (no new codes on the device API; a restore is an ordinary inbound
   change). The desktop enum `StepUpActionKind` may add `sync_attachment_restore` later (the drift
   check lists it as console-only).
4. Rebuild and restart the API and console images (the API image carries the updated
   `shared/step-up-actions.v1.json`).
5. Check: a customer page, Sync tab, shows "Deleted photos and attachments".

**Rollback.** Remove version 17 from `schema_migrations` before starting the previous images (they
ignore the two tables). Re-deploying later needs the two tables and their two trigger functions
(`mfx_sync_attachment_archive_guard`, `mfx_sync_forensic_log_append_only`) dropped first, which
loses the archive and the forensic log: export them first if they hold anything.

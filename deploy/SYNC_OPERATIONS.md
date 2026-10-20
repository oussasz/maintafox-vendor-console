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
> `rust_variant: null`). The sync registry gains a required `append_only` flag and the server now
> refuses deletes of append-only history (`operation_not_allowed_for_type`, SYNC_PROTOCOL_V2.md §2,
> §3.1).

Code: `api/src/sync/attachment-archive.ts` (hooks called by `exchange-v1.ts` / `exchange-v2.ts`,
listing, restore), `api/src/sync/validate.ts` (operation rule), routes in
`api/src/routes/sync-operations.ts`; console `src/vendor-console/components/DeletedAttachmentsPanel.tsx`
(customer page, Sync tab, permission `sync.operate`). Test:
`api/scripts/sync-attachment-archive.integration.mjs` (in `test:all`; in the CI object-storage job,
with `REQUIRE_S3=1`, it also proves the restored file is byte-identical and fails rather than skip
that check when the S3 settings are missing).

**Why.** The sync server knows the sending device (activation token: licence + machine fingerprint),
never the person, so it cannot prove who deleted something. Photos and attachments are the only
history that sync may delete, so the server keeps what was deleted or replaced and lets an operator
put it back.

**Archived types.** `media_attachments`, `asset_photos`, `di_attachments`, `work_order_attachments`,
`library_documents`, `asset_document_links`, `inventory_document_links`.

**Archive.** When an exchange (v1 or v2) accepts, for one of these types,
- a `delete` or `archive` (always recorded: `prior_state` `present`, or `already_deleted` / `unknown`
  when the server held a delete marker or nothing, which cannot be restored), or
- an `upsert` / `update` / `create` that replaces a **live** row with a **different** payload
  (`change_kind` `overwrite`: a valid update with a junk `object_key` or `relative_path` destroys an
  attachment as surely as a delete; an identical re-send or a re-creation over a delete marker
  destroys nothing and is not archived),

the same transaction copies the state the server held just before it (payload exactly as stored,
row version, operation, owner, origin device, object key / checksum / size / relative path from the
payload and the media manifest) and the device that sent the change (licence id, fingerprint,
operation, new row version, time) into `sync_deleted_attachment_archive`. What the device is told
(accepted / refused / conflict) does not change.

**Files.** The server keeps the deleted or replaced entry and the device that sent the change.
Files uploaded to the server are never deleted (the API has no code that deletes tenant media
objects; the test checks it). For an equipment, request or work order attachment, also restore its
"Photo or file" (`media_attachments`) entry so devices download the file again: those rows only
hold a path on the PC, which the deleting PC removes; the listing pairs them with their companion
entry (same `relative_path`) and says whether the server has a copy of the file (media manifest).
A file that was never uploaded (e.g. from a PC that was offline when it was deleted) cannot be
recovered.

**Listing.** `GET /api/v1/tenants/:tenantId/sync/deleted-attachments[?status=all|open|restored]`
(`sync.operate`, newest first, at most 500): entity type and id, delete or replace, when, the device
that sent the change, checksum and size, whether the server has the file, the companion entry,
restored (when, by whom, reason), and why it cannot be restored now if so. Never the payload or the
file.

**Restore.** `POST /api/v1/tenants/:tenantId/sync/deleted-attachments/:archiveId/restore`
(`sync.operate`, `X-Operator-Reason`, step-up `sync_attachment_restore`, optional `Idempotency-Key`;
audited `sync_attachment_restored`, category `sync_repair`, identifiers only). Under the tenant sync
lock (taken before the audit-chain lock, like every sync writer) it checks that the current state is
still the change the archive entry followed (same row version and payload hash), then appends a new
change from origin `server:attachment-restore`: the prior payload byte for byte (same
`payload_hash`), operation as before, `row_version` = max(current, prior) + 1 (a v1 delete may carry
a lower version than the row it removed) with `base_row_version` = current. Every device, the one
that sent the change included, receives it like a change from another device (v2 delta, snapshot,
v1 log); a media attachment received again queues its file download on the desktop. A restore is
not itself archived. Refusals: `404 archive_not_found | tenant_not_found`, `409 already_restored |
nothing_to_restore | entity_changed_since_delete` (re-created, edited or deleted again since:
restoring would overwrite that change). A device edit made from an older version after the restore
gets the usual conflict.

**Forensic device log.** Every accepted change of `site_settings` (including the three-person
lock-removal rule), `site_setting_events` and `permit_types` adds one row to
`sync_forensic_change_log`: tenant, entity type and id, operation, row version, base version,
server_seq, payload hash (never the payload), licence id, machine fingerprint, protocol, received at.
The ingress log also has the fingerprint but no licence id, and retention compacts it after
`SYNC_INGRESS_RETENTION_DAYS`; the forensic log is append-only (an UPDATE trigger refuses any change,
and `UPDATE` is revoked from `mfx_app`). Growth is one small row per settings change.

**Retention and privacy.** Retention never touches the archive or the forensic log. Archived prior
payloads (which may hold captions, file names and other customer text) are kept with **no time
limit**: they are removed only when the tenant is deleted (tenant delete purges both tables). The
forensic log holds identifiers and a hash only. A data-subject or customer request to erase content
before tenant deletion currently needs a manual, audited database operation.

## Deploy checklist (017)

1. **Migration** `017_sync_attachment_archive.sql` runs at API start (additive).
2. **Environment:** nothing new.
3. **Desktop contract:** a delete or archive of an append-only type other than `media_attachments`
   is now refused per item with `operation_not_allowed_for_type` (existing `rejected_items` shape;
   the desktop shows it as a refused item). A restore is an ordinary inbound change. The desktop enum
   `StepUpActionKind` may add `sync_attachment_restore` later (the drift check lists it as
   console-only).
4. Rebuild and restart the API and console images (the API image carries the updated
   `shared/step-up-actions.v1.json` and `shared/sync-entity-registry.v2.json`; the API does not
   start if a registry entry lacks `append_only`).
5. Check: a customer page, Sync tab, shows "Deleted or replaced photos and attachments".

**Rollback.** Remove version 17 from `schema_migrations` before starting the previous images (they
ignore the two tables, and each image carries its own copy of `shared/`, so the previous registry
file without `append_only` comes back with them). Re-deploying
later needs the two tables and their two trigger functions (`mfx_sync_attachment_archive_guard`,
`mfx_sync_forensic_log_append_only`) dropped first, which loses the archive and the forensic log:
export them first if they hold anything.

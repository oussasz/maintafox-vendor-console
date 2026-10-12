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

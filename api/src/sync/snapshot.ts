/**
 * Protocol v2 snapshot: paged current state for bootstrap (SYNC_PROTOCOL_V2.md §6).
 * The first page fixes the tenant high-water mark H; every page returns non-deleted rows last
 * changed at or before H in (entity_type, entity_sync_id) order. The last page hands out a
 * checkpoint at H, and the delta from H delivers everything that changed meanwhile.
 */
import type { Database } from "../db/database.js";
import { signCheckpointToken, signSnapshotPageToken, verifySnapshotPageToken } from "./checkpoint.js";
import type { PayloadCipher } from "./payload-crypto.js";
import { confirmDeviceUsers, listSnapshotPage, tenantStateHighWater } from "./store.js";
import {
  sha256Hex,
  SyncRequestError,
  type ActivationSyncContext,
  type SyncSnapshotRequestV2,
  type SyncSnapshotResponseV2,
} from "./types.js";

export async function runSyncSnapshotV2(
  db: Database,
  deps: { checkpointSecret: string; cipher: PayloadCipher },
  act: ActivationSyncContext,
  body: SyncSnapshotRequestV2,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<SyncSnapshotResponseV2> {
  const users = [...new Set(body.current_user_sync_ids)].sort();
  const usersHash = sha256Hex(JSON.stringify(users));

  let highWater: number;
  let after: [string, string];
  if (body.page_token) {
    const claims = verifySnapshotPageToken(deps.checkpointSecret, body.page_token);
    const valid =
      claims !== null &&
      claims.tenantId === act.tenantId &&
      claims.machineFingerprint === act.machineFingerprint &&
      claims.scope === body.scope &&
      claims.usersHash === usersHash;
    if (!valid) {
      throw new SyncRequestError(
        400,
        "invalid_page_token",
        "page_token is invalid or does not match this device, scope and user list; restart the snapshot.",
      );
    }
    highWater = claims.highWater;
    after = claims.after;
  } else {
    // Writers hold the tenant lock and allocate server_seq under it, so every row committed later
    // gets a higher seq than this mark: reading it without the lock is safe.
    highWater = await tenantStateHighWater(db, act.tenantId);
    after = ["", ""];
  }

  const rows = await listSnapshotPage(db, deps.cipher, {
    tenantId: act.tenantId,
    highWater,
    scope: body.scope,
    userSyncIds: users,
    after,
    limit: body.page_size + 1,
  });
  const has_more = rows.length > body.page_size;
  const items = rows.slice(0, body.page_size);
  const last = items[items.length - 1];
  if (!has_more) {
    // The snapshot is complete: its users no longer need user_snapshot_required.
    await confirmDeviceUsers(db, { tenantId: act.tenantId, machineFingerprint: act.machineFingerprint, userSyncIds: users });
  }

  const response: SyncSnapshotResponseV2 = {
    protocol_version: "v2",
    items,
    has_more,
    next_page_token:
      has_more && last
        ? signSnapshotPageToken(deps.checkpointSecret, {
            tenantId: act.tenantId,
            machineFingerprint: act.machineFingerprint,
            highWater,
            scope: body.scope,
            usersHash,
            after: [last.entity_type, last.entity_sync_id],
          })
        : null,
    checkpoint_token: has_more
      ? null
      : signCheckpointToken(deps.checkpointSecret, {
          tenantId: act.tenantId,
          machineFingerprint: act.machineFingerprint,
          seq: highWater,
        }),
  };

  log("sync_snapshot_page", {
    tenant_id: act.tenantId,
    machine_fingerprint: act.machineFingerprint,
    scope: body.scope,
    high_water: highWater,
    first_page: !body.page_token,
    items: items.length,
    has_more,
  });
  return response;
}

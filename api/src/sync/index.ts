import { z } from "zod";

import { SYNC_MAX_CURRENT_USERS, SYNC_SNAPSHOT_MAX_PAGE_SIZE } from "./types.js";

export { loadSyncConfig, type SyncConfig } from "./config.js";
export { runSyncExchangeV1 } from "./exchange-v1.js";
export { runSyncExchangeV2 } from "./exchange-v2.js";
export { loadSyncEntityRegistry, type SyncEntityRegistry } from "./registry.js";
export { runSyncRetention } from "./retention.js";
export { runSyncSnapshotV2 } from "./snapshot.js";
export { loadPayloadCipher, PayloadCipher } from "./payload-crypto.js";
export { purgeTenantSyncData, removeStateOutsideTenantScope, sealExistingSyncData } from "./store.js";
export { SyncRequestError } from "./types.js";
export type {
  SyncExchangeRequest,
  SyncExchangeRequestV2,
  SyncExchangeResponse,
  SyncExchangeResponseV2,
  SyncSnapshotRequestV2,
} from "./types.js";

const UserSyncIds = z.array(z.string().min(1).max(256)).max(SYNC_MAX_CURRENT_USERS);

/** v2 outbox item: v1 fields + base_row_version (explicit null for a create) + optional owner. */
const SyncExchangeOutboxItemV2 = z
  .object({
    idempotency_key: z.string().min(1).max(256),
    entity_type: z.string().min(1).max(256),
    entity_sync_id: z.string().min(1).max(256),
    operation: z.enum(["create", "update", "delete", "upsert", "archive"]),
    row_version: z.number().int().min(1),
    base_row_version: z.number().int().min(1).nullable(),
    owner_user_sync_id: z.string().min(1).max(256).nullable().optional(),
    payload_json: z.string().min(1),
    payload_hash: z.string().min(1).max(128),
  })
  .strict();

/** `maxOutboxBatch` comes from the API (same cap as v1). */
export function syncExchangeBodyV2(maxOutboxBatch: number) {
  return z
    .object({
      protocol_version: z.literal("v2"),
      idempotency_key: z.string().min(8).max(128),
      checkpoint_token: z.string().min(1).max(2048).nullable().optional(),
      current_user_sync_ids: UserSyncIds,
      device_class: z.enum(["desktop", "mobile"]),
      // tenant_config / media_manifest are validated by the exchange (specific error codes).
      tenant_config: z.unknown().optional(),
      media_manifest: z.array(z.unknown()).max(maxOutboxBatch).optional(),
      outbox_batch: z.array(SyncExchangeOutboxItemV2).max(maxOutboxBatch),
    })
    .strict();
}

export const SyncSnapshotBodyV2 = z
  .object({
    protocol_version: z.literal("v2"),
    page_token: z.string().min(1).max(4096).nullable().optional(),
    page_size: z.number().int().min(1).max(SYNC_SNAPSHOT_MAX_PAGE_SIZE),
    scope: z.enum(["all", "user"]),
    current_user_sync_ids: UserSyncIds,
    // Optional (desktops send none = desktop); the mobile app sends "mobile". Checked against the
    // activation's class by routes/sync.ts.
    device_class: z.enum(["desktop", "mobile"]).optional(),
  })
  .strict();

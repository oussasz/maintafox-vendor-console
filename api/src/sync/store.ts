/**
 * Sync persistence helpers (Postgres). Every function runs on the caller's open transaction
 * (Database.tx); the exchange holds the per-tenant lock for its whole transaction.
 */
import type { Database } from "../db/database.js";
import type { SyncInboundItemV2, SyncOperation } from "./types.js";

/** Per-tenant writer lock: serializes exchanges so server_seq values become visible in order. */
export async function lockTenantSync(db: Database, tenantId: string): Promise<void> {
  await db.lockXact("sync-tenant", tenantId);
}

/** Highest server_seq in the tenant's current state (0 when empty). */
export async function tenantStateHighWater(db: Database, tenantId: string): Promise<number> {
  const row = await db.get<{ hw: number | null }>(
    "SELECT MAX(last_ingress_id) AS hw FROM sync_entity_state WHERE tenant_id = $1",
    tenantId,
  );
  return row?.hw ?? 0;
}

export type IngressInsert = {
  tenantId: string;
  idempotencyKey: string;
  entityType: string;
  entitySyncId: string;
  operation: SyncOperation;
  rowVersion: number;
  baseRowVersion: number | null;
  ownerUserSyncId: string | null;
  payloadJson: string;
  payloadHash: string;
  machineFingerprint: string;
  receivedAt: string;
  protocolVersion: "v1" | "v2";
};

/** Appends to the log. Returns the new server_seq, or null when the item key already exists. */
export async function insertIngress(db: Database, input: IngressInsert): Promise<number | null> {
  const row = await db.get<{ id: number }>(
    `INSERT INTO sync_mirror_ingress (
       tenant_id, idempotency_key, entity_type, entity_sync_id, operation, row_version,
       payload_json, payload_hash, machine_fingerprint, received_at_rfc3339,
       base_row_version, owner_user_sync_id, protocol_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id`,
    input.tenantId,
    input.idempotencyKey,
    input.entityType,
    input.entitySyncId,
    input.operation,
    input.rowVersion,
    input.payloadJson,
    input.payloadHash,
    input.machineFingerprint,
    input.receivedAt,
    input.baseRowVersion,
    input.ownerUserSyncId,
    input.protocolVersion,
  );
  return row ? row.id : null;
}

/** Writes the entity's latest state from a log row. A delete stores a tombstone. */
export async function upsertEntityState(db: Database, ingressId: number, input: IngressInsert): Promise<void> {
  await db.run(
    `INSERT INTO sync_entity_state (
       tenant_id, entity_type, entity_sync_id, row_version, operation, payload_raw, payload_json,
       payload_hash, deleted, owner_user_sync_id, origin_machine_fingerprint, last_ingress_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,mfx_try_jsonb($6),$7,$8,$9,$10,$11,now())
     ON CONFLICT (tenant_id, entity_type, entity_sync_id) DO UPDATE SET
       row_version = EXCLUDED.row_version,
       operation = EXCLUDED.operation,
       payload_raw = EXCLUDED.payload_raw,
       payload_json = EXCLUDED.payload_json,
       payload_hash = EXCLUDED.payload_hash,
       deleted = EXCLUDED.deleted,
       owner_user_sync_id = EXCLUDED.owner_user_sync_id,
       origin_machine_fingerprint = EXCLUDED.origin_machine_fingerprint,
       last_ingress_id = EXCLUDED.last_ingress_id,
       updated_at = EXCLUDED.updated_at`,
    input.tenantId,
    input.entityType,
    input.entitySyncId,
    input.rowVersion,
    input.operation,
    input.payloadJson,
    input.payloadHash,
    input.operation === "delete",
    input.ownerUserSyncId,
    input.machineFingerprint,
    ingressId,
  );
}

export type EntityStateRow = {
  row_version: number;
  operation: SyncOperation;
  payload_raw: string;
  payload_hash: string;
  deleted: boolean;
  owner_user_sync_id: string | null;
  last_ingress_id: number;
};

export async function getEntityState(
  db: Database,
  tenantId: string,
  entityType: string,
  entitySyncId: string,
): Promise<EntityStateRow | undefined> {
  return db.get<EntityStateRow>(
    `SELECT row_version, operation, payload_raw, payload_hash, deleted, owner_user_sync_id, last_ingress_id
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
    tenantId,
    entityType,
    entitySyncId,
  );
}

export async function logRejection(
  db: Database,
  input: {
    tenantId: string;
    machineFingerprint: string;
    idempotencyKey: string;
    entityType: string;
    entitySyncId: string;
    rejectionCode: string;
    rejectionMessage: string;
    createdAt: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO sync_rejection_log
       (tenant_id, idempotency_key, entity_sync_id, rejection_code, rejection_message, created_at_rfc3339,
        machine_fingerprint, entity_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    input.tenantId,
    input.idempotencyKey,
    input.entitySyncId,
    input.rejectionCode,
    input.rejectionMessage,
    input.createdAt,
    input.machineFingerprint,
    input.entityType,
  );
}

type StateDeliveryRow = {
  last_ingress_id: number;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  payload_raw: string;
  payload_hash: string;
  owner_user_sync_id: string | null;
  deleted: boolean;
};

export function toInboundItemV2(row: StateDeliveryRow): SyncInboundItemV2 {
  return {
    server_seq: row.last_ingress_id,
    entity_type: row.entity_type,
    entity_sync_id: row.entity_sync_id,
    operation: row.operation,
    row_version: row.row_version,
    payload_json: row.payload_raw,
    payload_hash: row.payload_hash,
    owner_user_sync_id: row.owner_user_sync_id,
    deleted: row.deleted,
  };
}

const STATE_DELIVERY_COLUMNS = `last_ingress_id, entity_type, entity_sync_id, operation, row_version,
  payload_raw, payload_hash, owner_user_sync_id, deleted`;

/**
 * Collapsed delta for one device: latest state of every entity changed after `afterSeq`, excluding
 * entities last written by this device and user-scoped rows of users the device did not report.
 */
export async function listDeltaForDevice(
  db: Database,
  input: { tenantId: string; machineFingerprint: string; afterSeq: number; userSyncIds: string[]; limit: number },
): Promise<SyncInboundItemV2[]> {
  const rows = await db.all<StateDeliveryRow>(
    `SELECT ${STATE_DELIVERY_COLUMNS}
     FROM sync_entity_state
     WHERE tenant_id = $1
       AND last_ingress_id > $2
       AND origin_machine_fingerprint <> $3
       AND (owner_user_sync_id IS NULL OR owner_user_sync_id = ANY($4::text[]))
     ORDER BY last_ingress_id ASC
     LIMIT $5`,
    input.tenantId,
    input.afterSeq,
    input.machineFingerprint,
    input.userSyncIds,
    input.limit,
  );
  return rows.map(toInboundItemV2);
}

/** One snapshot page: non-deleted rows changed at or before `highWater`, keyset-ordered. */
export async function listSnapshotPage(
  db: Database,
  input: {
    tenantId: string;
    highWater: number;
    scope: "all" | "user";
    userSyncIds: string[];
    after: [string, string];
    limit: number;
  },
): Promise<SyncInboundItemV2[]> {
  const scopeFilter =
    input.scope === "user"
      ? "owner_user_sync_id = ANY($3::text[])"
      : "(owner_user_sync_id IS NULL OR owner_user_sync_id = ANY($3::text[]))";
  const rows = await db.all<StateDeliveryRow>(
    `SELECT ${STATE_DELIVERY_COLUMNS}
     FROM sync_entity_state
     WHERE tenant_id = $1
       AND NOT deleted
       AND last_ingress_id <= $2
       AND ${scopeFilter}
       AND (entity_type, entity_sync_id) > ($4, $5)
     ORDER BY entity_type ASC, entity_sync_id ASC
     LIMIT $6`,
    input.tenantId,
    input.highWater,
    input.userSyncIds,
    input.after[0],
    input.after[1],
    input.limit,
  );
  return rows.map(toInboundItemV2);
}

/** Records users first seen on a device; returns the ones that were new, sorted. */
export async function registerDeviceUsers(
  db: Database,
  input: { tenantId: string; machineFingerprint: string; userSyncIds: string[] },
): Promise<string[]> {
  if (input.userSyncIds.length === 0) return [];
  const rows = await db.all<{ user_sync_id: string }>(
    `INSERT INTO sync_device_user (tenant_id, machine_fingerprint, user_sync_id, first_seen_at)
     SELECT $1, $2, u, now() FROM unnest($3::text[]) AS u
     ON CONFLICT (tenant_id, machine_fingerprint, user_sync_id) DO NOTHING
     RETURNING user_sync_id`,
    input.tenantId,
    input.machineFingerprint,
    input.userSyncIds,
  );
  return rows.map((r) => r.user_sync_id).sort();
}

/** Every sync table keyed by tenant (used by tenant delete). */
export const SYNC_TENANT_TABLES = [
  "sync_tenant_checkpoint",
  "sync_mirror_ingress",
  "sync_exchange_idempotency",
  "sync_device_cursor",
  "sync_rejection_log",
  "sync_entity_state",
  "sync_device_checkpoint",
  "sync_device_user",
  "sync_exchange_idempotency_v2",
  "sync_conflict_log",
  "sync_media_manifest",
] as const;

/** Removes all sync data of a tenant. Runs inside the caller's transaction, under the tenant lock. */
export async function purgeTenantSyncData(db: Database, tenantId: string): Promise<Record<string, number>> {
  await lockTenantSync(db, tenantId);
  const deleted: Record<string, number> = {};
  for (const table of SYNC_TENANT_TABLES) {
    deleted[table] = (await db.run(`DELETE FROM ${table} WHERE tenant_id = $1`, tenantId)).changes;
  }
  return deleted;
}

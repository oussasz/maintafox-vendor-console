/**
 * Sync persistence helpers (Postgres). Every function runs on the caller's open transaction
 * (Database.tx); the exchange holds the per-tenant lock for its whole transaction.
 */
import type { Database } from "../db/database.js";
import { entityAad, isSensitiveSyncEntityType, PayloadCipher, responseAad, SENSITIVE_SYNC_ENTITY_TYPES } from "./payload-crypto.js";
import type { SyncInboundItemV2, SyncOperation } from "./types.js";

/** The payload as stored: sealed for sensitive entity types, verbatim otherwise. */
function storedPayload(
  cipher: PayloadCipher,
  input: { tenantId: string; entityType: string; entitySyncId: string; payloadJson: string },
): string {
  return isSensitiveSyncEntityType(input.entityType)
    ? cipher.seal(input.payloadJson, entityAad(input.tenantId, input.entityType, input.entitySyncId))
    : input.payloadJson;
}

/** The payload as delivered (opens a sealed value; plaintext rows are returned unchanged). */
export function deliveredPayload(
  cipher: PayloadCipher,
  tenantId: string,
  entityType: string,
  entitySyncId: string,
  stored: string,
): string {
  return cipher.open(stored, entityAad(tenantId, entityType, entitySyncId));
}

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
export async function insertIngress(db: Database, cipher: PayloadCipher, input: IngressInsert): Promise<number | null> {
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
    storedPayload(cipher, input),
    input.payloadHash,
    input.machineFingerprint,
    input.receivedAt,
    input.baseRowVersion,
    input.ownerUserSyncId,
    input.protocolVersion,
  );
  return row ? row.id : null;
}

/**
 * Writes the entity's latest state from a log row. A delete stores a tombstone. A sealed payload
 * is not JSON, so its queryable payload_json copy is NULL.
 */
export async function upsertEntityState(
  db: Database,
  cipher: PayloadCipher,
  ingressId: number,
  input: IngressInsert,
): Promise<void> {
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
    storedPayload(cipher, input),
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

/** Current state of one entity, payload opened. */
export async function getEntityState(
  db: Database,
  cipher: PayloadCipher,
  tenantId: string,
  entityType: string,
  entitySyncId: string,
): Promise<EntityStateRow | undefined> {
  const row = await db.get<EntityStateRow>(
    `SELECT row_version, operation, payload_raw, payload_hash, deleted, owner_user_sync_id, last_ingress_id
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
    tenantId,
    entityType,
    entitySyncId,
  );
  return row && { ...row, payload_raw: deliveredPayload(cipher, tenantId, entityType, entitySyncId, row.payload_raw) };
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
    /** The exchange that refused the item (ops drill-down). */
    serverBatchId: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO sync_rejection_log
       (tenant_id, idempotency_key, entity_sync_id, rejection_code, rejection_message, created_at_rfc3339,
        machine_fingerprint, entity_type, server_batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    input.tenantId,
    input.idempotencyKey,
    input.entitySyncId,
    input.rejectionCode,
    input.rejectionMessage,
    input.createdAt,
    input.machineFingerprint,
    input.entityType,
    input.serverBatchId,
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

export function toInboundItemV2(cipher: PayloadCipher, tenantId: string, row: StateDeliveryRow): SyncInboundItemV2 {
  return {
    server_seq: row.last_ingress_id,
    entity_type: row.entity_type,
    entity_sync_id: row.entity_sync_id,
    operation: row.operation,
    row_version: row.row_version,
    payload_json: deliveredPayload(cipher, tenantId, row.entity_type, row.entity_sync_id, row.payload_raw),
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
  cipher: PayloadCipher,
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
  return rows.map((row) => toInboundItemV2(cipher, input.tenantId, row));
}

/** One snapshot page: non-deleted rows changed at or before `highWater`, keyset-ordered. */
export async function listSnapshotPage(
  db: Database,
  cipher: PayloadCipher,
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
  return rows.map((row) => toInboundItemV2(cipher, input.tenantId, row));
}

/**
 * Records the users a device reports and returns, sorted, those not yet covered by a completed
 * snapshot on that device (they stay listed in user_snapshot_required until then).
 */
export async function recordDeviceUsers(
  db: Database,
  input: { tenantId: string; machineFingerprint: string; userSyncIds: string[] },
): Promise<string[]> {
  if (input.userSyncIds.length === 0) return [];
  await db.run(
    `INSERT INTO sync_device_user (tenant_id, machine_fingerprint, user_sync_id, first_seen_at)
     SELECT $1, $2, u, now() FROM unnest($3::text[]) AS u
     ON CONFLICT (tenant_id, machine_fingerprint, user_sync_id) DO NOTHING`,
    input.tenantId,
    input.machineFingerprint,
    input.userSyncIds,
  );
  const rows = await db.all<{ user_sync_id: string }>(
    `SELECT user_sync_id FROM sync_device_user
     WHERE tenant_id = $1 AND machine_fingerprint = $2 AND user_sync_id = ANY($3::text[]) AND confirmed_at IS NULL
     ORDER BY user_sync_id`,
    input.tenantId,
    input.machineFingerprint,
    input.userSyncIds,
  );
  return rows.map((r) => r.user_sync_id);
}

/** Marks users as covered by a snapshot that completed on this device. */
export async function confirmDeviceUsers(
  db: Database,
  input: { tenantId: string; machineFingerprint: string; userSyncIds: string[] },
): Promise<void> {
  if (input.userSyncIds.length === 0) return;
  await db.run(
    `INSERT INTO sync_device_user (tenant_id, machine_fingerprint, user_sync_id, first_seen_at, confirmed_at)
     SELECT $1, $2, u, now(), now() FROM unnest($3::text[]) AS u
     ON CONFLICT (tenant_id, machine_fingerprint, user_sync_id)
       DO UPDATE SET confirmed_at = COALESCE(sync_device_user.confirmed_at, now())`,
    input.tenantId,
    input.machineFingerprint,
    input.userSyncIds,
  );
}

/**
 * Removes current-state rows that only v1 (no owner, no registry check) or the one-time v1
 * history backfill can have produced: rows without an owner whose type is not tenant-scoped.
 * Such rows would otherwise be delivered to every device (a user-scoped row) or carry a type v2
 * does not know. Their log rows are kept, so v1 devices are unaffected. Returns rows removed.
 */
export async function removeStateOutsideTenantScope(db: Database, tenantScopedTypes: string[]): Promise<number> {
  const result = await db.run(
    `DELETE FROM sync_entity_state
     WHERE owner_user_sync_id IS NULL AND NOT (entity_type = ANY($1::text[]))`,
    tenantScopedTypes,
  );
  return result.changes;
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

const SEAL_BATCH_ROWS = 500;

/**
 * Seals sensitive payloads and stored exchange responses written before encryption at rest
 * existed (idempotent: values already sealed are skipped). Runs at startup in a system scope.
 */
export async function sealExistingSyncData(db: Database, cipher: PayloadCipher): Promise<Record<string, number>> {
  const types = [...SENSITIVE_SYNC_ENTITY_TYPES];
  const sealed: Record<string, number> = {};
  const inBatches = async (table: string, step: () => Promise<number>) => {
    sealed[table] = 0;
    for (;;) {
      const n = await db.tx(step);
      sealed[table] += n;
      if (n < SEAL_BATCH_ROWS) break;
    }
  };
  await inBatches("sync_mirror_ingress", async () => {
    const rows = await db.all<{ id: number; tenant_id: string; entity_type: string; entity_sync_id: string; payload_json: string }>(
      `SELECT id, tenant_id, entity_type, entity_sync_id, payload_json FROM sync_mirror_ingress
       WHERE entity_type = ANY($1::text[]) AND payload_json NOT LIKE 'mfxenc:v1:%'
       ORDER BY id LIMIT $2 FOR UPDATE`,
      types,
      SEAL_BATCH_ROWS,
    );
    for (const r of rows) {
      const value = cipher.seal(r.payload_json, entityAad(r.tenant_id, r.entity_type, r.entity_sync_id));
      await db.run("UPDATE sync_mirror_ingress SET payload_json = $1 WHERE id = $2", value, r.id);
    }
    return rows.length;
  });
  await inBatches("sync_entity_state", async () => {
    const rows = await db.all<{ tenant_id: string; entity_type: string; entity_sync_id: string; payload_raw: string }>(
      `SELECT tenant_id, entity_type, entity_sync_id, payload_raw FROM sync_entity_state
       WHERE entity_type = ANY($1::text[]) AND payload_raw NOT LIKE 'mfxenc:v1:%'
       LIMIT $2 FOR UPDATE`,
      types,
      SEAL_BATCH_ROWS,
    );
    for (const r of rows) {
      const value = cipher.seal(r.payload_raw, entityAad(r.tenant_id, r.entity_type, r.entity_sync_id));
      await db.run(
        `UPDATE sync_entity_state SET payload_raw = $1, payload_json = NULL
         WHERE tenant_id = $2 AND entity_type = $3 AND entity_sync_id = $4`,
        value,
        r.tenant_id,
        r.entity_type,
        r.entity_sync_id,
      );
    }
    return rows.length;
  });
  await inBatches("sync_exchange_idempotency", async () => {
    const rows = await db.all<{ tenant_id: string; idempotency_key: string; response_json: string }>(
      `SELECT tenant_id, idempotency_key, response_json FROM sync_exchange_idempotency
       WHERE response_json NOT LIKE 'mfxenc:v1:%' LIMIT $1 FOR UPDATE`,
      SEAL_BATCH_ROWS,
    );
    for (const r of rows) {
      await db.run(
        "UPDATE sync_exchange_idempotency SET response_json = $1 WHERE tenant_id = $2 AND idempotency_key = $3",
        cipher.seal(r.response_json, responseAad(r.tenant_id, "", r.idempotency_key)),
        r.tenant_id,
        r.idempotency_key,
      );
    }
    return rows.length;
  });
  await inBatches("sync_exchange_idempotency_v2", async () => {
    const rows = await db.all<{ tenant_id: string; machine_fingerprint: string; idempotency_key: string; response_json: string }>(
      `SELECT tenant_id, machine_fingerprint, idempotency_key, response_json FROM sync_exchange_idempotency_v2
       WHERE response_json NOT LIKE 'mfxenc:v1:%' LIMIT $1 FOR UPDATE`,
      SEAL_BATCH_ROWS,
    );
    for (const r of rows) {
      await db.run(
        `UPDATE sync_exchange_idempotency_v2 SET response_json = $1
         WHERE tenant_id = $2 AND machine_fingerprint = $3 AND idempotency_key = $4`,
        cipher.seal(r.response_json, responseAad(r.tenant_id, r.machine_fingerprint, r.idempotency_key)),
        r.tenant_id,
        r.machine_fingerprint,
        r.idempotency_key,
      );
    }
    return rows.length;
  });
  return sealed;
}

import type Database from "better-sqlite3";

import { initialCheckpointToken } from "./checkpoint.js";
import { mapIngressRow, type SyncStore, type TenantCheckpoint } from "./store.js";
import { normalizePayloadHash, type SyncExchangeResponse, type SyncOutboxItem } from "./types.js";

export function createSqliteSyncStore(db: Database.Database): SyncStore {
  db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_sync_state (
          tenant_id TEXT PRIMARY KEY,
          checkpoint_seq INTEGER NOT NULL DEFAULT 0,
          checkpoint_token TEXT NOT NULL,
          updated_at_rfc3339 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_mirror_ingress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          row_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          machine_fingerprint TEXT NOT NULL,
          received_at_rfc3339 TEXT NOT NULL,
          UNIQUE(tenant_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS sync_exchange_idempotency (
          tenant_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          server_batch_id TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at_rfc3339 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS sync_device_cursor (
          tenant_id TEXT NOT NULL,
          machine_fingerprint TEXT NOT NULL,
          last_delivered_ingress_id INTEGER NOT NULL DEFAULT 0,
          updated_at_rfc3339 TEXT NOT NULL,
          PRIMARY KEY (tenant_id, machine_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS sync_rejection_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          rejection_code TEXT NOT NULL,
          rejection_message TEXT NOT NULL,
          created_at_rfc3339 TEXT NOT NULL
        );
      `);

  return {
    backend: "sqlite",

    async ensureSchema(): Promise<void> {
      // Schema applied at construction.
    },

    async getIdempotentResponse(
      tenantId: string,
      idempotencyKey: string,
    ): Promise<SyncExchangeResponse | null> {
      const row = db
        .prepare(
          `SELECT response_json FROM sync_exchange_idempotency
           WHERE tenant_id = ? AND idempotency_key = ?`,
        )
        .get(tenantId, idempotencyKey) as { response_json: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.response_json) as SyncExchangeResponse;
    },

    async saveIdempotentResponse(
      tenantId: string,
      idempotencyKey: string,
      serverBatchId: string,
      response: SyncExchangeResponse,
    ): Promise<void> {
      db.prepare(
        `INSERT OR REPLACE INTO sync_exchange_idempotency
          (tenant_id, idempotency_key, server_batch_id, response_json, created_at_rfc3339)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        tenantId,
        idempotencyKey,
        serverBatchId,
        JSON.stringify(response),
        new Date().toISOString(),
      );
    },

    async getOrCreateCheckpoint(tenantId: string): Promise<TenantCheckpoint> {
      const existing = db
        .prepare(
          `SELECT checkpoint_seq, checkpoint_token FROM tenant_sync_state WHERE tenant_id = ?`,
        )
        .get(tenantId) as TenantCheckpoint | undefined;
      if (existing) return existing;
      const token = initialCheckpointToken(tenantId);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tenant_sync_state (tenant_id, checkpoint_seq, checkpoint_token, updated_at_rfc3339)
         VALUES (?, 0, ?, ?)`,
      ).run(tenantId, token, now);
      return { checkpoint_seq: 0, checkpoint_token: token };
    },

    async setCheckpoint(tenantId: string, seq: number, token: string): Promise<void> {
      db.prepare(
        `UPDATE tenant_sync_state SET checkpoint_seq = ?, checkpoint_token = ?, updated_at_rfc3339 = ?
         WHERE tenant_id = ?`,
      ).run(seq, token, new Date().toISOString(), tenantId);
    },

    async insertIngress(input: {
      tenantId: string;
      item: SyncOutboxItem;
      machineFingerprint: string;
      receivedAt: string;
    }): Promise<{ inserted: boolean; id: number | null }> {
      const hash = normalizePayloadHash(input.item.payload_hash);
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO sync_mirror_ingress (
            tenant_id, idempotency_key, entity_type, entity_sync_id, operation, row_version,
            payload_json, payload_hash, machine_fingerprint, received_at_rfc3339
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.item.idempotency_key,
          input.item.entity_type.trim(),
          input.item.entity_sync_id,
          input.item.operation,
          input.item.row_version,
          input.item.payload_json,
          hash,
          input.machineFingerprint,
          input.receivedAt,
        );
      if (result.changes === 0) {
        return { inserted: false, id: null };
      }
      const idRow = db
        .prepare(`SELECT id FROM sync_mirror_ingress WHERE tenant_id = ? AND idempotency_key = ?`)
        .get(input.tenantId, input.item.idempotency_key) as { id: number };
      return { inserted: true, id: idRow.id };
    },

    async logRejection(input: {
      tenantId: string;
      idempotencyKey: string;
      entitySyncId: string;
      rejectionCode: string;
      rejectionMessage: string;
      createdAt: string;
    }): Promise<void> {
      db.prepare(
        `INSERT INTO sync_rejection_log
          (tenant_id, idempotency_key, entity_sync_id, rejection_code, rejection_message, created_at_rfc3339)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.tenantId,
        input.idempotencyKey,
        input.entitySyncId,
        input.rejectionCode,
        input.rejectionMessage,
        input.createdAt,
      );
    },

    async getDeviceCursor(tenantId: string, machineFingerprint: string): Promise<number> {
      const row = db
        .prepare(
          `SELECT last_delivered_ingress_id FROM sync_device_cursor
           WHERE tenant_id = ? AND machine_fingerprint = ?`,
        )
        .get(tenantId, machineFingerprint) as
        | { last_delivered_ingress_id: number }
        | undefined;
      return row?.last_delivered_ingress_id ?? 0;
    },

    async setDeviceCursor(
      tenantId: string,
      machineFingerprint: string,
      lastDeliveredIngressId: number,
    ): Promise<void> {
      db.prepare(
        `INSERT INTO sync_device_cursor
          (tenant_id, machine_fingerprint, last_delivered_ingress_id, updated_at_rfc3339)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, machine_fingerprint) DO UPDATE SET
           last_delivered_ingress_id = excluded.last_delivered_ingress_id,
           updated_at_rfc3339 = excluded.updated_at_rfc3339`,
      ).run(
        tenantId,
        machineFingerprint,
        lastDeliveredIngressId,
        new Date().toISOString(),
      );
    },

    async listIngressAfter(tenantId: string, afterId: number, limit: number) {
      const rows = db
        .prepare(
          `SELECT id, tenant_id, idempotency_key, entity_type, entity_sync_id, operation,
                  row_version, payload_json, payload_hash, machine_fingerprint, received_at_rfc3339
           FROM sync_mirror_ingress
           WHERE tenant_id = ? AND id > ?
           ORDER BY id ASC
           LIMIT ?`,
        )
        .all(tenantId, afterId, limit) as Array<Record<string, unknown>>;
      return rows.map(mapIngressRow);
    },
  };
}

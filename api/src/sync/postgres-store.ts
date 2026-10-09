import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { initialCheckpointToken } from "./checkpoint.js";
import { mapIngressRow, type SyncStore, type TenantCheckpoint } from "./store.js";
import { normalizePayloadHash, type SyncExchangeResponse, type SyncOutboxItem } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createPostgresSyncStore(databaseUrl: string): Promise<SyncStore> {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  const store: SyncStore = {
    backend: "postgres",

    async ensureSchema(): Promise<void> {
      // Prefer cwd (api/) when running via `pnpm api:start` / Docker WORKDIR /app/api.
      const candidates = [
        join(process.cwd(), "migrations/001_sync_mirror.sql"),
        join(__dirname, "../../migrations/001_sync_mirror.sql"),
      ];
      let sql: string | null = null;
      for (const migrationPath of candidates) {
        try {
          sql = await readFile(migrationPath, "utf8");
          break;
        } catch {
          // try next
        }
      }
      if (!sql) {
        throw new Error("Postgres sync migration 001_sync_mirror.sql not found");
      }
      await pool.query(sql);
    },

    async getIdempotentResponse(
      tenantId: string,
      idempotencyKey: string,
    ): Promise<SyncExchangeResponse | null> {
      const r = await pool.query(
        `SELECT response_json FROM sync_exchange_idempotency
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (r.rowCount === 0) return null;
      const json = r.rows[0]!.response_json as string;
      return JSON.parse(json) as SyncExchangeResponse;
    },

    async saveIdempotentResponse(
      tenantId: string,
      idempotencyKey: string,
      serverBatchId: string,
      response: SyncExchangeResponse,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO sync_exchange_idempotency
          (tenant_id, idempotency_key, server_batch_id, response_json, created_at_rfc3339)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
           server_batch_id = EXCLUDED.server_batch_id,
           response_json = EXCLUDED.response_json,
           created_at_rfc3339 = EXCLUDED.created_at_rfc3339`,
        [
          tenantId,
          idempotencyKey,
          serverBatchId,
          JSON.stringify(response),
          new Date().toISOString(),
        ],
      );
    },

    async getOrCreateCheckpoint(tenantId: string): Promise<TenantCheckpoint> {
      const existing = await pool.query(
        `SELECT checkpoint_seq, checkpoint_token FROM sync_tenant_checkpoint WHERE tenant_id = $1`,
        [tenantId],
      );
      if (existing.rowCount && existing.rows[0]) {
        return {
          checkpoint_seq: Number(existing.rows[0].checkpoint_seq),
          checkpoint_token: String(existing.rows[0].checkpoint_token),
        };
      }
      const token = initialCheckpointToken(tenantId);
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO sync_tenant_checkpoint (tenant_id, checkpoint_seq, checkpoint_token, updated_at_rfc3339)
         VALUES ($1, 0, $2, $3)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, token, now],
      );
      const again = await pool.query(
        `SELECT checkpoint_seq, checkpoint_token FROM sync_tenant_checkpoint WHERE tenant_id = $1`,
        [tenantId],
      );
      return {
        checkpoint_seq: Number(again.rows[0]!.checkpoint_seq),
        checkpoint_token: String(again.rows[0]!.checkpoint_token),
      };
    },

    async setCheckpoint(tenantId: string, seq: number, token: string): Promise<void> {
      await pool.query(
        `UPDATE sync_tenant_checkpoint
         SET checkpoint_seq = $1, checkpoint_token = $2, updated_at_rfc3339 = $3
         WHERE tenant_id = $4`,
        [seq, token, new Date().toISOString(), tenantId],
      );
    },

    async insertIngress(input: {
      tenantId: string;
      item: SyncOutboxItem;
      machineFingerprint: string;
      receivedAt: string;
    }): Promise<{ inserted: boolean; id: number | null }> {
      const hash = normalizePayloadHash(input.item.payload_hash);
      const r = await pool.query(
        `INSERT INTO sync_mirror_ingress (
          tenant_id, idempotency_key, entity_type, entity_sync_id, operation, row_version,
          payload_json, payload_hash, machine_fingerprint, received_at_rfc3339
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id`,
        [
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
        ],
      );
      if (!r.rowCount) {
        return { inserted: false, id: null };
      }
      return { inserted: true, id: Number(r.rows[0]!.id) };
    },

    async logRejection(input: {
      tenantId: string;
      idempotencyKey: string;
      entitySyncId: string;
      rejectionCode: string;
      rejectionMessage: string;
      createdAt: string;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO sync_rejection_log
          (tenant_id, idempotency_key, entity_sync_id, rejection_code, rejection_message, created_at_rfc3339)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantId,
          input.idempotencyKey,
          input.entitySyncId,
          input.rejectionCode,
          input.rejectionMessage,
          input.createdAt,
        ],
      );
    },

    async getDeviceCursor(tenantId: string, machineFingerprint: string): Promise<number> {
      const r = await pool.query(
        `SELECT last_delivered_ingress_id FROM sync_device_cursor
         WHERE tenant_id = $1 AND machine_fingerprint = $2`,
        [tenantId, machineFingerprint],
      );
      if (!r.rowCount) return 0;
      return Number(r.rows[0]!.last_delivered_ingress_id);
    },

    async setDeviceCursor(
      tenantId: string,
      machineFingerprint: string,
      lastDeliveredIngressId: number,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO sync_device_cursor
          (tenant_id, machine_fingerprint, last_delivered_ingress_id, updated_at_rfc3339)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, machine_fingerprint) DO UPDATE SET
           last_delivered_ingress_id = EXCLUDED.last_delivered_ingress_id,
           updated_at_rfc3339 = EXCLUDED.updated_at_rfc3339`,
        [tenantId, machineFingerprint, lastDeliveredIngressId, new Date().toISOString()],
      );
    },

    async listIngressAfter(tenantId: string, afterId: number, limit: number) {
      const r = await pool.query(
        `SELECT id, tenant_id, idempotency_key, entity_type, entity_sync_id, operation,
                row_version, payload_json, payload_hash, machine_fingerprint, received_at_rfc3339
         FROM sync_mirror_ingress
         WHERE tenant_id = $1 AND id > $2
         ORDER BY id ASC
         LIMIT $3`,
        [tenantId, afterId, limit],
      );
      return r.rows.map((row) => mapIngressRow(row as Record<string, unknown>));
    },
  };

  return store;
}

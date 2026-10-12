/**
 * Protocol v1 exchange: wire format unchanged for desktops that are not updated yet.
 *
 * Fixed without a wire change: the whole exchange is one transaction under the per-tenant lock;
 * the device cursor advances only together with the stored response; a device whose recent log
 * rows are all its own is no longer starved (the cursor passes over its own rows). v1 pushes of
 * tenant-scoped registry types also update the v2 current state (last write wins, as v1 always
 * behaved) so v2 devices receive them. User-scoped and unregistered types stay in the log only:
 * v1 carries no owner, so putting them in the state would deliver personal rows to every device.
 */
import { randomBytes } from "node:crypto";

import type { Database } from "../db/database.js";
import { initialCheckpointToken, nextCheckpointToken, shouldAdvanceCheckpoint } from "./checkpoint.js";
import { PayloadCipher, responseAad } from "./payload-crypto.js";
import type { SyncEntityRegistry } from "./registry.js";
import { deliveredPayload, insertIngress, lockTenantSync, logRejection, upsertEntityState, type IngressInsert } from "./store.js";
import {
  normalizePayloadHash,
  SYNC_INBOUND_BATCH_LIMIT,
  type ActivationSyncContext,
  type SyncAckItem,
  type SyncExchangeRequest,
  type SyncExchangeResponse,
  type SyncInboundItem,
  type SyncOperation,
  type SyncRejectedItem,
} from "./types.js";
import { shouldRedactPayloadLog, toRejected, validateOutboxItem } from "./validate.js";

export function newBatchId(): string {
  return `batch_${randomBytes(8).toString("hex")}`;
}

export async function runSyncExchangeV1(
  db: Database,
  deps: { registry: SyncEntityRegistry; cipher: PayloadCipher },
  act: ActivationSyncContext,
  body: SyncExchangeRequest,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<SyncExchangeResponse> {
  // v1 stored responses are keyed by tenant + idempotency key (no device), and so is their binding.
  const v1ResponseAad = responseAad(act.tenantId, "", body.idempotency_key);
  return db.tx(async () => {
    await lockTenantSync(db, act.tenantId);

    const replay = await db.get<{ response_json: string; server_batch_id: string }>(
      `SELECT response_json, server_batch_id FROM sync_exchange_idempotency
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      act.tenantId,
      body.idempotency_key,
    );
    if (replay) {
      // A retry of an exchange already answered (lost response): counted for the ops metrics.
      await db.run(
        `UPDATE sync_exchange_idempotency SET replay_count = replay_count + 1, last_replay_at = now()
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        act.tenantId,
        body.idempotency_key,
      );
      log("sync_exchange_idempotent_replay", {
        tenant_id: act.tenantId,
        protocol_version: "v1",
        server_batch_id: replay.server_batch_id,
      });
      return JSON.parse(deps.cipher.open(replay.response_json, v1ResponseAad)) as SyncExchangeResponse;
    }

    const nowIso = new Date().toISOString();
    await db.run(
      `INSERT INTO sync_tenant_checkpoint (tenant_id, checkpoint_seq, checkpoint_token, updated_at_rfc3339)
       VALUES ($1, 0, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      act.tenantId,
      initialCheckpointToken(act.tenantId),
      nowIso,
    );
    const checkpoint = (await db.get<{ checkpoint_seq: number; checkpoint_token: string }>(
      "SELECT checkpoint_seq, checkpoint_token FROM sync_tenant_checkpoint WHERE tenant_id = $1",
      act.tenantId,
    ))!;
    const serverBatchId = newBatchId();

    const acknowledged_items: SyncAckItem[] = [];
    const rejected_items: SyncRejectedItem[] = [];

    for (const item of body.outbox_batch) {
      const validation = validateOutboxItem(item);
      if (!validation.ok) {
        rejected_items.push(toRejected(item, validation.rejection_code, validation.rejection_message));
        await logRejection(db, {
          tenantId: act.tenantId,
          machineFingerprint: act.machineFingerprint,
          idempotencyKey: item.idempotency_key,
          entityType: item.entity_type,
          entitySyncId: item.entity_sync_id,
          rejectionCode: validation.rejection_code,
          rejectionMessage: validation.rejection_message,
          createdAt: nowIso,
          serverBatchId,
        });
        continue;
      }

      const ingress: IngressInsert = {
        tenantId: act.tenantId,
        idempotencyKey: item.idempotency_key,
        entityType: item.entity_type.trim(),
        entitySyncId: item.entity_sync_id,
        operation: item.operation,
        rowVersion: item.row_version,
        baseRowVersion: null,
        ownerUserSyncId: null,
        payloadJson: item.payload_json,
        payloadHash: normalizePayloadHash(item.payload_hash),
        machineFingerprint: act.machineFingerprint,
        receivedAt: nowIso,
        protocolVersion: "v1",
      };
      const ingressId = await insertIngress(db, deps.cipher, ingress);
      if (ingressId !== null && deps.registry.scopeOf(ingress.entityType) === "tenant") {
        await upsertEntityState(db, deps.cipher, ingressId, ingress);
      }

      acknowledged_items.push({
        idempotency_key: item.idempotency_key,
        entity_sync_id: item.entity_sync_id,
        operation: item.operation,
      });
    }

    const advance = shouldAdvanceCheckpoint(rejected_items.length);
    let responseCheckpoint = checkpoint.checkpoint_token;
    if (advance) {
      const nextSeq = checkpoint.checkpoint_seq + 1;
      responseCheckpoint = nextCheckpointToken(act.tenantId, nextSeq);
      await db.run(
        `UPDATE sync_tenant_checkpoint
         SET checkpoint_seq = $1, checkpoint_token = $2, updated_at_rfc3339 = $3
         WHERE tenant_id = $4`,
        nextSeq,
        responseCheckpoint,
        nowIso,
        act.tenantId,
      );
    }

    const cursorRow = await db.get<{ last_delivered_ingress_id: number }>(
      `SELECT last_delivered_ingress_id FROM sync_device_cursor
       WHERE tenant_id = $1 AND machine_fingerprint = $2`,
      act.tenantId,
      act.machineFingerprint,
    );
    const cursor = cursorRow?.last_delivered_ingress_id ?? 0;
    const candidates = await db.all<{
      id: number;
      entity_type: string;
      entity_sync_id: string;
      operation: SyncOperation;
      row_version: number;
      payload_json: string;
    }>(
      `SELECT id, entity_type, entity_sync_id, operation, row_version, payload_json
       FROM sync_mirror_ingress
       WHERE tenant_id = $1 AND id > $2 AND machine_fingerprint <> $3
       ORDER BY id ASC
       LIMIT $4`,
      act.tenantId,
      cursor,
      act.machineFingerprint,
      SYNC_INBOUND_BATCH_LIMIT + 1,
    );
    const delivered = candidates.slice(0, SYNC_INBOUND_BATCH_LIMIT);
    const inbound_items: SyncInboundItem[] = delivered.map((r) => ({
      entity_type: r.entity_type,
      entity_sync_id: r.entity_sync_id,
      operation: r.operation,
      row_version: r.row_version,
      payload_json: deliveredPayload(deps.cipher, act.tenantId, r.entity_type, r.entity_sync_id, r.payload_json),
    }));
    let nextCursor: number;
    if (candidates.length > SYNC_INBOUND_BATCH_LIMIT) {
      nextCursor = delivered[delivered.length - 1]!.id;
    } else {
      // Everything else up to the tenant's log high-water mark is this device's own rows: pass them.
      const hw = await db.get<{ hw: number | null }>(
        "SELECT MAX(id) AS hw FROM sync_mirror_ingress WHERE tenant_id = $1",
        act.tenantId,
      );
      nextCursor = Math.max(cursor, hw?.hw ?? 0);
    }
    if (nextCursor > cursor) {
      await db.run(
        `INSERT INTO sync_device_cursor (tenant_id, machine_fingerprint, last_delivered_ingress_id, updated_at_rfc3339)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, machine_fingerprint) DO UPDATE SET
           last_delivered_ingress_id = EXCLUDED.last_delivered_ingress_id,
           updated_at_rfc3339 = EXCLUDED.updated_at_rfc3339`,
        act.tenantId,
        act.machineFingerprint,
        nextCursor,
        nowIso,
      );
    }

    const response: SyncExchangeResponse = {
      protocol_version: "v1",
      server_batch_id: serverBatchId,
      checkpoint_token: responseCheckpoint,
      acknowledged_items,
      rejected_items,
      inbound_items,
      policy_metadata_json: null,
    };

    await db.run(
      `INSERT INTO sync_exchange_idempotency
         (tenant_id, idempotency_key, server_batch_id, response_json, created_at_rfc3339)
       VALUES ($1, $2, $3, $4, $5)`,
      act.tenantId,
      body.idempotency_key,
      serverBatchId,
      deps.cipher.seal(JSON.stringify(response), v1ResponseAad),
      nowIso,
    );

    log("sync_exchange", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      protocol_version: "v1",
      outbox_count: body.outbox_batch.length,
      acknowledged: acknowledged_items.length,
      rejected: rejected_items.length,
      inbound: inbound_items.length,
      server_batch_id: serverBatchId,
      checkpoint: responseCheckpoint,
      checkpoint_advanced: advance,
      device_class: body.device_class ?? null,
      media_manifest_count: Array.isArray(body.media_manifest) ? body.media_manifest.length : 0,
      // Never include payload bodies; entity types only (user_accounts still safe as type-only).
      entity_types: body.outbox_batch.map((i) =>
        shouldRedactPayloadLog(i.entity_type) ? "user_accounts" : i.entity_type,
      ),
    });

    return response;
  });
}

/**
 * Protocol v2 exchange (deploy/SYNC_PROTOCOL_V2.md). One Postgres transaction under the per-tenant
 * lock covers: idempotency check, item validation, conflict checks, log append, state upserts,
 * device checkpoint, device users, media manifest and the stored response.
 */
import { assertTenantOwnsObjectKey } from "../storage/object-store.js";
import type { Database } from "../db/database.js";
import { signCheckpointToken, verifyCheckpointToken } from "./checkpoint.js";
import { newBatchId } from "./exchange-v1.js";
import { PayloadCipher, responseAad } from "./payload-crypto.js";
import type { SyncEntityRegistry } from "./registry.js";
import {
  getEntityState,
  insertIngress,
  listDeltaForDevice,
  lockTenantSync,
  logRejection,
  recordDeviceUsers,
  tenantStateHighWater,
  upsertEntityState,
  type IngressInsert,
} from "./store.js";
import {
  normalizePayloadHash,
  sha256Hex,
  SyncRequestError,
  SYNC_INBOUND_BATCH_LIMIT,
  type ActivationSyncContext,
  type MediaManifestEntryV2,
  type SyncAckItemV2,
  type SyncConflictItemV2,
  type SyncExchangeRequestV2,
  type SyncExchangeResponseV2,
  type SyncRejectedItemV2,
  type TenantConfigV2,
} from "./types.js";
import { shouldRedactPayloadLog, toRejectedV2, validateOutboxItemV2 } from "./validate.js";

/** JSON with object keys sorted recursively and no whitespace: the request-hash input. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${entries.join(",")}}`;
}

/** Resolves the request checkpoint to a server_seq, or throws invalid_checkpoint_token. */
export function resolveRequestCheckpoint(
  secret: string,
  act: ActivationSyncContext,
  token: string | null | undefined,
): number {
  if (token === null || token === undefined) return 0;
  const claims = verifyCheckpointToken(secret, token);
  if (!claims) {
    throw new SyncRequestError(
      400,
      "invalid_checkpoint_token",
      "checkpoint_token is malformed or its signature is invalid.",
    );
  }
  if (claims.tenantId !== act.tenantId || claims.machineFingerprint !== act.machineFingerprint) {
    throw new SyncRequestError(
      400,
      "invalid_checkpoint_token",
      "checkpoint_token was issued to another tenant or device.",
    );
  }
  return claims.seq;
}

function parseTenantConfig(raw: unknown, tenantId: string): TenantConfigV2 | null {
  if (raw === undefined || raw === null) return null;
  const isObject = typeof raw === "object" && !Array.isArray(raw);
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["tenant_id", "is_activated", "company_display_name"]);
  const display = isObject ? o["company_display_name"] : undefined;
  const valid =
    isObject &&
    Object.keys(o).every((k) => allowed.has(k)) &&
    typeof o["tenant_id"] === "string" &&
    typeof o["is_activated"] === "boolean" &&
    (display === null || display === undefined || (typeof display === "string" && display.length <= 256));
  if (!valid) {
    throw new SyncRequestError(
      400,
      "validation_error",
      "tenant_config must be { tenant_id: string, is_activated: boolean, company_display_name: string|null }.",
    );
  }
  if (o["tenant_id"] !== tenantId) {
    throw new SyncRequestError(409, "tenant_config_mismatch", "tenant_config.tenant_id is not the activated tenant.");
  }
  return {
    tenant_id: o["tenant_id"] as string,
    is_activated: o["is_activated"] as boolean,
    company_display_name: (display as string | null | undefined) ?? null,
  };
}

function parseMediaManifest(raw: unknown[] | undefined, tenantId: string): MediaManifestEntryV2[] {
  if (!raw) return [];
  const allowed = new Set(["entity_sync_id", "content_sha256", "object_key", "byte_size"]);
  return raw.map((entry, index) => {
    const o = entry as Record<string, unknown>;
    const ok =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(o).every((k) => allowed.has(k)) &&
      typeof o["entity_sync_id"] === "string" &&
      o["entity_sync_id"].length >= 1 &&
      o["entity_sync_id"].length <= 256 &&
      typeof o["content_sha256"] === "string" &&
      /^[0-9a-f]{64}$/.test(o["content_sha256"]) &&
      typeof o["object_key"] === "string" &&
      o["object_key"].length >= 1 &&
      o["object_key"].length <= 1024 &&
      typeof o["byte_size"] === "number" &&
      Number.isSafeInteger(o["byte_size"]) &&
      o["byte_size"] >= 0;
    if (!ok) {
      throw new SyncRequestError(
        400,
        "media_manifest_invalid",
        `media_manifest[${index}] must be { entity_sync_id, content_sha256 (64 lowercase hex), object_key, byte_size >= 0 }.`,
      );
    }
    if (!assertTenantOwnsObjectKey(tenantId, o["object_key"] as string)) {
      throw new SyncRequestError(400, "media_manifest_invalid", `media_manifest[${index}].object_key is outside the tenant.`);
    }
    return {
      entity_sync_id: o["entity_sync_id"] as string,
      content_sha256: o["content_sha256"] as string,
      object_key: o["object_key"] as string,
      byte_size: o["byte_size"] as number,
    };
  });
}

export type SyncExchangeV2Outcome = { response: SyncExchangeResponseV2; replayed: boolean };

export async function runSyncExchangeV2(
  db: Database,
  deps: { registry: SyncEntityRegistry; checkpointSecret: string; cipher: PayloadCipher },
  act: ActivationSyncContext,
  rawBody: unknown,
  body: SyncExchangeRequestV2,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<SyncExchangeV2Outcome> {
  // Request-level checks that need no database run before the transaction opens.
  const requestHash = sha256Hex(canonicalJson(rawBody));
  const requestSeq = resolveRequestCheckpoint(deps.checkpointSecret, act, body.checkpoint_token);
  const tenantConfig = parseTenantConfig(body.tenant_config, act.tenantId);
  const mediaManifest = parseMediaManifest(body.media_manifest, act.tenantId);
  const currentUsers = [...new Set(body.current_user_sync_ids)].sort();
  const storedResponseAad = responseAad(act.tenantId, act.machineFingerprint, body.idempotency_key);

  return db.tx(async () => {
    await lockTenantSync(db, act.tenantId);

    const stored = await db.get<{ request_hash: string; response_json: string; server_batch_id: string }>(
      `SELECT request_hash, response_json, server_batch_id FROM sync_exchange_idempotency_v2
       WHERE tenant_id = $1 AND machine_fingerprint = $2 AND idempotency_key = $3`,
      act.tenantId,
      act.machineFingerprint,
      body.idempotency_key,
    );
    if (stored) {
      if (stored.request_hash !== requestHash) {
        throw new SyncRequestError(
          409,
          "idempotency_key_reused",
          "idempotency_key was already used by this device with a different request body.",
        );
      }
      // A retry of an exchange already answered (lost response): counted for the ops metrics.
      await db.run(
        `UPDATE sync_exchange_idempotency_v2 SET replay_count = replay_count + 1, last_replay_at = now()
         WHERE tenant_id = $1 AND machine_fingerprint = $2 AND idempotency_key = $3`,
        act.tenantId,
        act.machineFingerprint,
        body.idempotency_key,
      );
      log("sync_exchange_idempotent_replay", {
        tenant_id: act.tenantId,
        machine_fingerprint: act.machineFingerprint,
        protocol_version: "v2",
        server_batch_id: stored.server_batch_id,
      });
      return {
        response: JSON.parse(deps.cipher.open(stored.response_json, storedResponseAad)) as SyncExchangeResponseV2,
        replayed: true,
      };
    }

    const highWaterBefore = await tenantStateHighWater(db, act.tenantId);
    if (requestSeq > highWaterBefore) {
      throw new SyncRequestError(
        409,
        "checkpoint_ahead_of_server",
        "checkpoint_token is newer than the server data; bootstrap again with a snapshot.",
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const serverBatchId = newBatchId();
    const acknowledged_items: SyncAckItemV2[] = [];
    const rejected_items: SyncRejectedItemV2[] = [];
    const conflict_items: SyncConflictItemV2[] = [];
    const keysInBatch = new Set<string>();

    const reject = async (item: SyncExchangeRequestV2["outbox_batch"][number], code: string, message: string) => {
      rejected_items.push(toRejectedV2(item, code, message));
      await logRejection(db, {
        tenantId: act.tenantId,
        machineFingerprint: act.machineFingerprint,
        idempotencyKey: item.idempotency_key,
        entityType: item.entity_type,
        entitySyncId: item.entity_sync_id,
        rejectionCode: code,
        rejectionMessage: message,
        createdAt: nowIso,
        serverBatchId,
      });
    };

    for (const item of body.outbox_batch) {
      if (keysInBatch.has(item.idempotency_key)) {
        await reject(item, "duplicate_item_in_batch", "idempotency_key appears more than once in this batch.");
        continue;
      }
      keysInBatch.add(item.idempotency_key);

      const validation = validateOutboxItemV2(item, deps.registry);
      if (!validation.ok) {
        await reject(item, validation.rejection_code, validation.rejection_message);
        continue;
      }
      const payloadHash = normalizePayloadHash(item.payload_hash);
      const owner = item.owner_user_sync_id ?? null;

      // Item idempotency: an item key is applied at most once per tenant.
      const previous = await db.get<{
        id: number;
        entity_type: string;
        entity_sync_id: string;
        row_version: number;
        payload_hash: string;
      }>(
        `SELECT id, entity_type, entity_sync_id, row_version, payload_hash FROM sync_mirror_ingress
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        act.tenantId,
        item.idempotency_key,
      );
      if (previous) {
        const same =
          previous.entity_type === item.entity_type &&
          previous.entity_sync_id === item.entity_sync_id &&
          previous.row_version === item.row_version &&
          previous.payload_hash === payloadHash;
        if (same) {
          acknowledged_items.push({
            idempotency_key: item.idempotency_key,
            entity_type: item.entity_type,
            entity_sync_id: item.entity_sync_id,
            operation: item.operation,
            row_version: item.row_version,
            server_seq: previous.id,
            duplicate: true,
          });
        } else {
          await reject(
            item,
            "item_idempotency_key_reused",
            "item idempotency_key was already applied with different content.",
          );
        }
        continue;
      }

      const state = await getEntityState(db, deps.cipher, act.tenantId, item.entity_type, item.entity_sync_id);
      if (state && state.row_version === item.row_version && state.payload_hash === payloadHash) {
        // Already the current state (e.g. a retry after its log row was compacted): nothing to apply.
        acknowledged_items.push({
          idempotency_key: item.idempotency_key,
          entity_type: item.entity_type,
          entity_sync_id: item.entity_sync_id,
          operation: item.operation,
          row_version: item.row_version,
          server_seq: state.last_ingress_id,
          duplicate: true,
        });
        continue;
      }
      if (state && (item.base_row_version === null || item.base_row_version !== state.row_version)) {
        conflict_items.push({
          idempotency_key: item.idempotency_key,
          entity_type: item.entity_type,
          entity_sync_id: item.entity_sync_id,
          local_row_version: item.row_version,
          local_base_row_version: item.base_row_version,
          server_row_version: state.row_version,
          server_operation: state.operation,
          server_payload_json: state.payload_raw,
          server_payload_hash: state.payload_hash,
          server_owner_user_sync_id: state.owner_user_sync_id,
          server_deleted: state.deleted,
        });
        await db.run(
          `INSERT INTO sync_conflict_log
             (tenant_id, machine_fingerprint, server_batch_id, idempotency_key, entity_type, entity_sync_id,
              local_row_version, local_base_row_version, server_row_version, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          act.tenantId,
          act.machineFingerprint,
          serverBatchId,
          item.idempotency_key,
          item.entity_type,
          item.entity_sync_id,
          item.row_version,
          item.base_row_version,
          state.row_version,
          now,
        );
        continue;
      }

      const ingress: IngressInsert = {
        tenantId: act.tenantId,
        idempotencyKey: item.idempotency_key,
        entityType: item.entity_type,
        entitySyncId: item.entity_sync_id,
        operation: item.operation,
        rowVersion: item.row_version,
        baseRowVersion: item.base_row_version,
        ownerUserSyncId: owner,
        payloadJson: item.payload_json,
        payloadHash,
        machineFingerprint: act.machineFingerprint,
        receivedAt: nowIso,
        protocolVersion: "v2",
      };
      const serverSeq = await insertIngress(db, deps.cipher, ingress);
      if (serverSeq === null) {
        // The key was checked above under the tenant lock; reaching this means a broken invariant.
        throw new Error(`item idempotency_key ${item.idempotency_key} appeared concurrently`);
      }
      await upsertEntityState(db, deps.cipher, serverSeq, ingress);
      acknowledged_items.push({
        idempotency_key: item.idempotency_key,
        entity_type: item.entity_type,
        entity_sync_id: item.entity_sync_id,
        operation: item.operation,
        row_version: item.row_version,
        server_seq: serverSeq,
        duplicate: false,
      });
    }

    const newUsers = await recordDeviceUsers(db, {
      tenantId: act.tenantId,
      machineFingerprint: act.machineFingerprint,
      userSyncIds: currentUsers,
    });

    const candidates = await listDeltaForDevice(db, deps.cipher, {
      tenantId: act.tenantId,
      machineFingerprint: act.machineFingerprint,
      afterSeq: requestSeq,
      userSyncIds: currentUsers,
      limit: SYNC_INBOUND_BATCH_LIMIT + 1,
    });
    const has_more = candidates.length > SYNC_INBOUND_BATCH_LIMIT;
    const inbound_items = candidates.slice(0, SYNC_INBOUND_BATCH_LIMIT);
    // With nothing more to deliver, jump to the high-water mark so skipped rows never stall the device.
    const nextSeq = has_more
      ? inbound_items[inbound_items.length - 1]!.server_seq
      : Math.max(requestSeq, await tenantStateHighWater(db, act.tenantId));
    const checkpoint_token = signCheckpointToken(deps.checkpointSecret, {
      tenantId: act.tenantId,
      machineFingerprint: act.machineFingerprint,
      seq: nextSeq,
    });

    await db.run(
      `INSERT INTO sync_device_checkpoint
         (tenant_id, machine_fingerprint, acknowledged_seq, issued_seq, device_class, tenant_config_json, last_exchange_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, machine_fingerprint) DO UPDATE SET
         -- A retry with an older token must not move the acknowledged position backwards.
         acknowledged_seq = GREATEST(sync_device_checkpoint.acknowledged_seq, EXCLUDED.acknowledged_seq),
         issued_seq = EXCLUDED.issued_seq,
         device_class = EXCLUDED.device_class,
         tenant_config_json = COALESCE(EXCLUDED.tenant_config_json, sync_device_checkpoint.tenant_config_json),
         last_exchange_at = EXCLUDED.last_exchange_at`,
      act.tenantId,
      act.machineFingerprint,
      requestSeq,
      nextSeq,
      body.device_class,
      tenantConfig ? JSON.stringify(tenantConfig) : null,
      now,
    );

    for (const entry of mediaManifest) {
      await db.run(
        `INSERT INTO sync_media_manifest
           (tenant_id, entity_sync_id, content_sha256, object_key, byte_size, reported_by_machine_fingerprint, reported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, entity_sync_id) DO UPDATE SET
           content_sha256 = EXCLUDED.content_sha256,
           object_key = EXCLUDED.object_key,
           byte_size = EXCLUDED.byte_size,
           reported_by_machine_fingerprint = EXCLUDED.reported_by_machine_fingerprint,
           reported_at = EXCLUDED.reported_at`,
        act.tenantId,
        entry.entity_sync_id,
        entry.content_sha256,
        entry.object_key,
        entry.byte_size,
        act.machineFingerprint,
        now,
      );
    }

    const response: SyncExchangeResponseV2 = {
      protocol_version: "v2",
      server_batch_id: serverBatchId,
      checkpoint_token,
      acknowledged_items,
      rejected_items,
      conflict_items,
      inbound_items,
      has_more,
      user_snapshot_required: newUsers,
      policy_metadata_json: null,
    };

    await db.run(
      `INSERT INTO sync_exchange_idempotency_v2
         (tenant_id, machine_fingerprint, idempotency_key, request_hash, server_batch_id, response_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      act.tenantId,
      act.machineFingerprint,
      body.idempotency_key,
      requestHash,
      serverBatchId,
      deps.cipher.seal(JSON.stringify(response), storedResponseAad),
      now,
    );

    log("sync_exchange", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      protocol_version: "v2",
      outbox_count: body.outbox_batch.length,
      acknowledged: acknowledged_items.length,
      rejected: rejected_items.length,
      conflicts: conflict_items.length,
      inbound: inbound_items.length,
      has_more,
      checkpoint_seq_in: requestSeq,
      checkpoint_seq_out: nextSeq,
      server_batch_id: serverBatchId,
      device_class: body.device_class,
      media_manifest_count: mediaManifest.length,
      user_snapshot_required: newUsers.length,
      // Never include payload bodies; entity types only.
      entity_types: body.outbox_batch.map((i) =>
        shouldRedactPayloadLog(i.entity_type) ? "user_accounts" : i.entity_type,
      ),
    });

    return { response, replayed: false };
  });
}

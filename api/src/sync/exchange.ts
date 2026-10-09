import { randomBytes } from "node:crypto";

import { nextCheckpointToken, shouldAdvanceCheckpoint } from "./checkpoint.js";
import { selectInboundForDevice } from "./fanout.js";
import type { SyncStore } from "./store.js";
import {
  SYNC_INBOUND_BATCH_LIMIT,
  type ActivationSyncContext,
  type SyncAckItem,
  type SyncExchangeRequest,
  type SyncExchangeResponse,
  type SyncRejectedItem,
} from "./types.js";
import { shouldRedactPayloadLog, toRejected, validateOutboxItem } from "./validate.js";

function newBatchId(): string {
  return `batch_${randomBytes(8).toString("hex")}`;
}

export async function runSyncExchange(
  store: SyncStore,
  act: ActivationSyncContext,
  body: SyncExchangeRequest,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<SyncExchangeResponse> {
  const replay = await store.getIdempotentResponse(act.tenantId, body.idempotency_key);
  if (replay) {
    log("sync_exchange_idempotent_replay", {
      tenant_id: act.tenantId,
      server_batch_id: replay.server_batch_id,
    });
    return replay;
  }

  const nowIso = new Date().toISOString();
  const checkpoint = await store.getOrCreateCheckpoint(act.tenantId);
  const serverBatchId = newBatchId();

  const acknowledged_items: SyncAckItem[] = [];
  const rejected_items: SyncRejectedItem[] = [];

  for (const item of body.outbox_batch) {
    const validation = validateOutboxItem(item);
    if (!validation.ok) {
      const rejected = toRejected(item, validation.rejection_code, validation.rejection_message);
      rejected_items.push(rejected);
      await store.logRejection({
        tenantId: act.tenantId,
        idempotencyKey: item.idempotency_key,
        entitySyncId: item.entity_sync_id,
        rejectionCode: validation.rejection_code,
        rejectionMessage: validation.rejection_message,
        createdAt: nowIso,
      });
      continue;
    }

    await store.insertIngress({
      tenantId: act.tenantId,
      item,
      machineFingerprint: act.machineFingerprint,
      receivedAt: nowIso,
    });

    acknowledged_items.push({
      idempotency_key: item.idempotency_key,
      entity_sync_id: item.entity_sync_id,
      operation: item.operation,
    });
  }

  const advance = shouldAdvanceCheckpoint(rejected_items.length);
  let responseCheckpoint = checkpoint.checkpoint_token;
  let nextSeq = checkpoint.checkpoint_seq;
  if (advance) {
    nextSeq = checkpoint.checkpoint_seq + 1;
    responseCheckpoint = nextCheckpointToken(act.tenantId, nextSeq);
    await store.setCheckpoint(act.tenantId, nextSeq, responseCheckpoint);
  }

  const cursor = await store.getDeviceCursor(act.tenantId, act.machineFingerprint);
  // Fetch a window larger than batch so self-origin filtering still fills the batch.
  const candidates = await store.listIngressAfter(
    act.tenantId,
    cursor,
    SYNC_INBOUND_BATCH_LIMIT * 3,
  );
  const { items: inbound_items, maxDeliveredId } = selectInboundForDevice(
    candidates,
    cursor,
    act.machineFingerprint,
    SYNC_INBOUND_BATCH_LIMIT,
  );
  if (maxDeliveredId > cursor) {
    await store.setDeviceCursor(act.tenantId, act.machineFingerprint, maxDeliveredId);
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

  await store.saveIdempotentResponse(
    act.tenantId,
    body.idempotency_key,
    serverBatchId,
    response,
  );

  log("sync_exchange", {
    tenant_id: act.tenantId,
    machine_fingerprint: act.machineFingerprint,
    backend: store.backend,
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
}

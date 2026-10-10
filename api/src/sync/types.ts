import { createHash } from "node:crypto";

export type SyncOperation = "create" | "update" | "delete" | "upsert" | "archive";

// ── v1 wire types (unchanged for old desktops) ──────────────────────────────

export type SyncOutboxItem = {
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  payload_json: string;
  payload_hash: string;
};

export type SyncExchangeRequest = {
  protocol_version: "v1";
  idempotency_key: string;
  checkpoint_token?: string | null;
  outbox_batch: SyncOutboxItem[];
  device_class?: "desktop" | "mobile";
  media_manifest?: unknown[];
  tenant_config?: unknown;
};

export type SyncAckItem = {
  idempotency_key: string;
  entity_sync_id: string;
  operation: SyncOperation;
};

export type SyncRejectedItem = {
  idempotency_key: string;
  entity_sync_id: string;
  operation: SyncOperation;
  rejection_code: string;
  rejection_message: string;
};

export type SyncInboundItem = {
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  payload_json: string;
};

export type SyncExchangeResponse = {
  protocol_version: "v1";
  server_batch_id: string;
  checkpoint_token: string;
  acknowledged_items: SyncAckItem[];
  rejected_items: SyncRejectedItem[];
  inbound_items: SyncInboundItem[];
  policy_metadata_json: string | null;
};

// ── v2 wire types (deploy/SYNC_PROTOCOL_V2.md) ──────────────────────────────

export type SyncOutboxItemV2 = SyncOutboxItem & {
  base_row_version: number | null;
  owner_user_sync_id?: string | null;
};

export type TenantConfigV2 = {
  tenant_id: string;
  is_activated: boolean;
  company_display_name: string | null;
};

export type MediaManifestEntryV2 = {
  entity_sync_id: string;
  content_sha256: string;
  object_key: string;
  byte_size: number;
};

export type SyncExchangeRequestV2 = {
  protocol_version: "v2";
  idempotency_key: string;
  checkpoint_token?: string | null;
  current_user_sync_ids: string[];
  device_class: "desktop" | "mobile";
  tenant_config?: unknown;
  media_manifest?: unknown[];
  outbox_batch: SyncOutboxItemV2[];
};

export type SyncAckItemV2 = {
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  server_seq: number;
  duplicate: boolean;
};

export type SyncRejectedItemV2 = {
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  rejection_code: string;
  rejection_message: string;
};

export type SyncConflictItemV2 = {
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  local_row_version: number;
  local_base_row_version: number | null;
  server_row_version: number;
  server_operation: SyncOperation;
  server_payload_json: string;
  server_payload_hash: string;
  server_owner_user_sync_id: string | null;
  server_deleted: boolean;
};

export type SyncInboundItemV2 = {
  server_seq: number;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  payload_json: string;
  payload_hash: string;
  owner_user_sync_id: string | null;
  deleted: boolean;
};

export type SyncExchangeResponseV2 = {
  protocol_version: "v2";
  server_batch_id: string;
  checkpoint_token: string;
  acknowledged_items: SyncAckItemV2[];
  rejected_items: SyncRejectedItemV2[];
  conflict_items: SyncConflictItemV2[];
  inbound_items: SyncInboundItemV2[];
  has_more: boolean;
  user_snapshot_required: string[];
  policy_metadata_json: string | null;
};

export type SyncSnapshotRequestV2 = {
  protocol_version: "v2";
  page_token?: string | null;
  page_size: number;
  scope: "all" | "user";
  current_user_sync_ids: string[];
};

export type SyncSnapshotResponseV2 = {
  protocol_version: "v2";
  items: SyncInboundItemV2[];
  has_more: boolean;
  next_page_token: string | null;
  checkpoint_token: string | null;
};

export type ActivationSyncContext = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
};

/** Request-level failure with an HTTP status and a stable `error` code (see the protocol doc). */
export class SyncRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncRequestError";
  }
}

/** Inbound items per exchange response (v1 and v2). */
export const SYNC_INBOUND_BATCH_LIMIT = 100;
/** Snapshot page size upper bound (request `page_size` must be 1..this). */
export const SYNC_SNAPSHOT_MAX_PAGE_SIZE = 1000;
/** Users a device may report per request. */
export const SYNC_MAX_CURRENT_USERS = 100;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function normalizePayloadHash(hash: string): string {
  const t = hash.trim();
  const hex = t.startsWith("sha256:") ? t.slice("sha256:".length).trim() : t;
  return hex.toLowerCase();
}

export function isValidSha256Hex(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

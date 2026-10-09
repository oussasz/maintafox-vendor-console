import { createHash } from "node:crypto";

export type SyncOperation = "create" | "update" | "delete" | "upsert" | "archive";

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

export type SyncIngressRow = {
  id: number;
  tenant_id: string;
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: SyncOperation;
  row_version: number;
  payload_json: string;
  payload_hash: string;
  machine_fingerprint: string;
  received_at_rfc3339: string;
};

export type ActivationSyncContext = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
};

export const SYNC_INBOUND_BATCH_LIMIT = 100;

/** Phase-1 + known desktop entity keys (forward-compatible: also allow snake_case identifiers). */
export const SYNC_KNOWN_ENTITY_TYPES = new Set([
  "equipment",
  "equipment_meters",
  "user_accounts",
  "roles",
  "user_role_assignments",
  "user_scope_assignments",
  "org_nodes",
  "org_structure_models",
  "org_node_types",
  "personnel",
  "teams",
  "personnel_team_assignments",
  "intervention_requests",
  "work_orders",
  "work_order_tasks",
  "work_order_interveners",
  "pm_plans",
  "pm_plan_versions",
  "pm_occurrences",
  "articles",
  "warehouses",
  "stock_locations",
  "inventory_transactions",
  "stock_reservations",
  "media_attachments",
  "reference_values",
]);

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

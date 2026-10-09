import type {
  SyncExchangeResponse,
  SyncIngressRow,
  SyncOperation,
  SyncOutboxItem,
} from "./types.js";

export type TenantCheckpoint = {
  checkpoint_seq: number;
  checkpoint_token: string;
};

export interface SyncStore {
  readonly backend: "sqlite" | "postgres";

  ensureSchema(): Promise<void>;

  getIdempotentResponse(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<SyncExchangeResponse | null>;

  saveIdempotentResponse(
    tenantId: string,
    idempotencyKey: string,
    serverBatchId: string,
    response: SyncExchangeResponse,
  ): Promise<void>;

  getOrCreateCheckpoint(tenantId: string): Promise<TenantCheckpoint>;

  setCheckpoint(
    tenantId: string,
    seq: number,
    token: string,
  ): Promise<void>;

  /**
   * Insert ingress row. Returns true if inserted, false if duplicate idempotency key.
   */
  insertIngress(input: {
    tenantId: string;
    item: SyncOutboxItem;
    machineFingerprint: string;
    receivedAt: string;
  }): Promise<{ inserted: boolean; id: number | null }>;

  logRejection(input: {
    tenantId: string;
    idempotencyKey: string;
    entitySyncId: string;
    rejectionCode: string;
    rejectionMessage: string;
    createdAt: string;
  }): Promise<void>;

  getDeviceCursor(tenantId: string, machineFingerprint: string): Promise<number>;

  setDeviceCursor(
    tenantId: string,
    machineFingerprint: string,
    lastDeliveredIngressId: number,
  ): Promise<void>;

  listIngressAfter(
    tenantId: string,
    afterId: number,
    limit: number,
  ): Promise<SyncIngressRow[]>;
}

export function mapIngressRow(raw: Record<string, unknown>): SyncIngressRow {
  return {
    id: Number(raw["id"]),
    tenant_id: String(raw["tenant_id"]),
    idempotency_key: String(raw["idempotency_key"]),
    entity_type: String(raw["entity_type"]),
    entity_sync_id: String(raw["entity_sync_id"]),
    operation: String(raw["operation"]) as SyncOperation,
    row_version: Number(raw["row_version"]),
    payload_json: String(raw["payload_json"]),
    payload_hash: String(raw["payload_hash"]),
    machine_fingerprint: String(raw["machine_fingerprint"]),
    received_at_rfc3339: String(raw["received_at_rfc3339"]),
  };
}

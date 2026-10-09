import {
  SYNC_INBOUND_BATCH_LIMIT,
  type SyncInboundItem,
  type SyncIngressRow,
  type SyncOperation,
} from "./types.js";

export function selectInboundForDevice(
  rows: SyncIngressRow[],
  afterId: number,
  excludeMachineFingerprint: string,
  limit: number = SYNC_INBOUND_BATCH_LIMIT,
): { items: SyncInboundItem[]; maxDeliveredId: number } {
  const selected = rows
    .filter(
      (r) =>
        r.id > afterId && r.machine_fingerprint !== excludeMachineFingerprint,
    )
    .sort((a, b) => a.id - b.id)
    .slice(0, limit);

  const items: SyncInboundItem[] = selected.map((r) => ({
    entity_type: r.entity_type,
    entity_sync_id: r.entity_sync_id,
    operation: r.operation as SyncOperation,
    row_version: r.row_version,
    payload_json: r.payload_json,
  }));

  const maxDeliveredId =
    selected.length > 0 ? selected[selected.length - 1]!.id : afterId;

  return { items, maxDeliveredId };
}

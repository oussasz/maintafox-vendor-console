/**
 * Audit ledger hash chain: record preimage, integrity hash and chain verification. Shared by the
 * API (append + verify-chain route) and the SQLite -> Postgres migration script, so both verify
 * the chain with the same code.
 */
import { createHash } from "node:crypto";

export type AuditEntityRefs = {
  tenant_id?: string;
  entitlement_id?: string;
  machine_id?: string;
  sync_batch_id?: string;
  release_id?: string;
  incident_id?: string;
  support_ticket_id?: string;
};

/** A stored audit_records row. */
export type AuditRecordRow = {
  record_id: string;
  sequence: number;
  occurred_at_rfc3339: string;
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  payload_canonical_sha256: string;
  chain_prev_hash: string | null;
  record_integrity_sha256: string;
  reason_code: string | null;
  approval_correlation_id: string | null;
  entity_refs_json: string;
};

export const AUDIT_RECORD_COLUMNS = `record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
  correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
  payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
  approval_correlation_id, entity_refs_json`;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function auditRecordPreimage(input: {
  record_id: string;
  sequence: number;
  occurred_at_rfc3339: string;
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  payload_canonical_sha256: string;
  chain_prev_hash: string | null;
  reason_code: string | null;
  approval_correlation_id: string | null;
  entity_refs: AuditEntityRefs;
}): string {
  const refs = input.entity_refs;
  const o = (v?: string | null) => v ?? "";
  return [
    "audit_v1",
    input.record_id,
    String(input.sequence),
    input.occurred_at_rfc3339,
    input.actor_id,
    input.action_code,
    input.action_category,
    input.correlation_id,
    o(input.scope_tenant_id),
    o(input.before_snapshot_sha256),
    o(input.after_snapshot_sha256),
    input.payload_canonical_sha256,
    o(input.chain_prev_hash),
    o(input.reason_code),
    o(input.approval_correlation_id),
    o(refs.tenant_id),
    o(refs.entitlement_id),
    o(refs.machine_id),
    o(refs.sync_batch_id),
    o(refs.release_id),
    o(refs.incident_id),
    o(refs.support_ticket_id),
  ].join("|");
}

export function mapAuditRow(row: AuditRecordRow) {
  let refs: AuditEntityRefs = {};
  try {
    refs = JSON.parse(row.entity_refs_json) as AuditEntityRefs;
  } catch {
    refs = {};
  }
  return {
    record_id: row.record_id,
    sequence: row.sequence,
    occurred_at_rfc3339: row.occurred_at_rfc3339,
    actor_id: row.actor_id,
    action_code: row.action_code,
    action_category: row.action_category,
    correlation_id: row.correlation_id,
    scope_tenant_id: row.scope_tenant_id,
    before_snapshot_sha256: row.before_snapshot_sha256,
    after_snapshot_sha256: row.after_snapshot_sha256,
    payload_canonical_sha256: row.payload_canonical_sha256,
    chain_prev_hash: row.chain_prev_hash,
    record_integrity_sha256: row.record_integrity_sha256,
    reason_code: row.reason_code,
    approval_correlation_id: row.approval_correlation_id,
    entity_refs: refs,
  };
}

export type AuditChainStatus = "ok" | "integrity_mismatch" | "chain_broken";

/**
 * Recomputes every record hash and checks each record points at its predecessor.
 * `rows` must be ordered by sequence ascending. `first_bad_sequence` is null when the chain is ok.
 */
export function verifyAuditChain(rows: AuditRecordRow[]): {
  status: AuditChainStatus;
  checked_count: number;
  first_bad_sequence: number | null;
} {
  let previous: string | null = null;
  for (const row of rows) {
    const mapped = mapAuditRow(row);
    const computed = sha256Hex(
      auditRecordPreimage({
        record_id: mapped.record_id,
        sequence: mapped.sequence,
        occurred_at_rfc3339: mapped.occurred_at_rfc3339,
        actor_id: mapped.actor_id,
        action_code: mapped.action_code,
        action_category: mapped.action_category,
        correlation_id: mapped.correlation_id,
        scope_tenant_id: mapped.scope_tenant_id,
        before_snapshot_sha256: mapped.before_snapshot_sha256,
        after_snapshot_sha256: mapped.after_snapshot_sha256,
        payload_canonical_sha256: mapped.payload_canonical_sha256,
        chain_prev_hash: mapped.chain_prev_hash,
        reason_code: mapped.reason_code,
        approval_correlation_id: mapped.approval_correlation_id,
        entity_refs: mapped.entity_refs,
      }),
    );
    if (computed !== mapped.record_integrity_sha256) {
      return { status: "integrity_mismatch", checked_count: rows.length, first_bad_sequence: mapped.sequence };
    }
    if (mapped.chain_prev_hash !== previous) {
      return { status: "chain_broken", checked_count: rows.length, first_bad_sequence: mapped.sequence };
    }
    previous = mapped.record_integrity_sha256;
  }
  return { status: "ok", checked_count: rows.length, first_bad_sequence: null };
}

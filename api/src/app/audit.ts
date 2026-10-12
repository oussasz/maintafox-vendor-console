/** Audit ledger append (hash chain), bound to the API database. */
import { auditRecordPreimage, type AuditEntityRefs } from "../audit-chain.js";
import type { Database } from "../db/database.js";
import { newId, sha256Hex } from "./runtime.js";

export function createAuditAppender(db: Database) {
  async function appendAuditRecord(input: {
    actor_id: string;
    action_code: string;
    action_category: string;
    correlation_id: string;
    scope_tenant_id?: string | null;
    reason_code?: string | null;
    approval_correlation_id?: string | null;
    entity_refs?: AuditEntityRefs;
    payload?: unknown;
  }): Promise<string> {
    // The hash chain needs a gap-free sequence: serialize appends (joins the caller's transaction).
    return db.tx(async () => {
      await db.lockXact("audit-chain", "append");
      const prev = await db.get("SELECT sequence, record_integrity_sha256 FROM audit_records ORDER BY sequence DESC LIMIT 1") as { sequence: number; record_integrity_sha256: string } | undefined;
      const sequence = (prev?.sequence ?? 0) + 1;
      const now = new Date().toISOString();
      const recordId = newId("audit");
      const entityRefs = input.entity_refs ?? {};
      const payloadCanonical = JSON.stringify(input.payload ?? {});
      const payloadSha = sha256Hex(payloadCanonical);
      const preimage = auditRecordPreimage({
        record_id: recordId,
        sequence,
        occurred_at_rfc3339: now,
        actor_id: input.actor_id,
        action_code: input.action_code,
        action_category: input.action_category,
        correlation_id: input.correlation_id,
        scope_tenant_id: input.scope_tenant_id ?? null,
        before_snapshot_sha256: null,
        after_snapshot_sha256: null,
        payload_canonical_sha256: payloadSha,
        chain_prev_hash: prev?.record_integrity_sha256 ?? null,
        reason_code: input.reason_code ?? null,
        approval_correlation_id: input.approval_correlation_id ?? null,
        entity_refs: entityRefs,
      });
      const integrity = sha256Hex(preimage);
      await db.run(`INSERT INTO audit_records
          (record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
           correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
           payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
           approval_correlation_id, entity_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, recordId,
        sequence,
        now,
        input.actor_id,
        input.action_code,
        input.action_category,
        input.correlation_id,
        input.scope_tenant_id ?? null,
        null,
        null,
        payloadSha,
        prev?.record_integrity_sha256 ?? null,
        integrity,
        input.reason_code ?? null,
        input.approval_correlation_id ?? null,
        JSON.stringify(entityRefs));
      return recordId;
    });
  }

  return { appendAuditRecord };
}

export type AuditAppender = ReturnType<typeof createAuditAppender>;

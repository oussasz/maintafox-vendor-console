import { z } from "zod";

import type { VendorAdminAuditRecordV1 } from "@maintafox/contracts";

/** Must match `vps::audit_support_hardening::audit_record_preimage`. */
export function auditRecordPreimage(record: VendorAdminAuditRecordV1): string {
  const e = record.entity_refs;
  const o = (x?: string | null) => x ?? "";
  const parts = [
    "audit_v1",
    record.record_id,
    String(record.sequence),
    record.occurred_at_rfc3339,
    record.actor_id,
    record.action_code,
    record.action_category,
    record.correlation_id,
    o(record.scope_tenant_id),
    o(record.before_snapshot_sha256),
    o(record.after_snapshot_sha256),
    record.payload_canonical_sha256,
    o(record.chain_prev_hash),
    o(record.reason_code),
    o(record.approval_correlation_id),
    o(e.tenant_id),
    o(e.entitlement_id),
    o(e.machine_id),
    o(e.sync_batch_id),
    o(e.release_id),
    o(e.incident_id),
    o(e.support_ticket_id),
  ];
  return parts.join("|");
}

export async function computeRecordIntegritySha256(record: VendorAdminAuditRecordV1): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(auditRecordPreimage(record)));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyRecordIntegrity(record: VendorAdminAuditRecordV1): Promise<boolean> {
  const h = await computeRecordIntegritySha256(record);
  return h === record.record_integrity_sha256;
}

export async function verifyAuditChain(records: VendorAdminAuditRecordV1[]): Promise<"ok" | "integrity_mismatch" | "chain_broken"> {
  if (records.length === 0) return "ok";
  for (const r of records) {
    if (!(await verifyRecordIntegrity(r))) return "integrity_mismatch";
  }
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const cur = records[i];
    if (!prev || !cur) return "chain_broken";
    if (cur.chain_prev_hash !== prev.record_integrity_sha256) return "chain_broken";
  }
  return "ok";
}

export const VendorAdminAuditRecordV1Schema = z.object({
  record_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  occurred_at_rfc3339: z.string(),
  actor_id: z.string().min(1),
  action_code: z.string().min(1),
  // The desktop contract names 7 categories; the control API writes more (vendor sign-in,
  // customers, operators, billing, rollout governance: shared/audit-action-categories.v1.json).
  // A category the console does not know is shown as its code, never a reason to drop the ledger.
  action_category: z.string().min(1),
  correlation_id: z.string().min(1),
  scope_tenant_id: z.string().nullable(),
  before_snapshot_sha256: z.string().nullable(),
  after_snapshot_sha256: z.string().nullable(),
  payload_canonical_sha256: z.string().min(1),
  chain_prev_hash: z.string().nullable(),
  record_integrity_sha256: z.string().length(64),
  reason_code: z.string().nullable(),
  approval_correlation_id: z.string().nullable(),
  entity_refs: z.object({
    tenant_id: z.string().optional(),
    entitlement_id: z.string().optional(),
    machine_id: z.string().optional(),
    sync_batch_id: z.string().optional(),
    release_id: z.string().optional(),
    incident_id: z.string().optional(),
    support_ticket_id: z.string().optional(),
  }),
});

export const SupportTicketV1Schema = z.object({
  ticket_id: z.string().min(1),
  tenant_id: z.string().min(1),
  state: z.enum(["new", "triaged", "waiting_for_vendor", "waiting_for_customer", "resolved", "closed"]),
  severity: z.enum(["info", "warn", "critical"]),
  affected_module: z.string().min(1),
  /** Null until a device reports them (tickets opened by an operator). */
  sync_status_hint: z.string().nullable(),
  app_version_reported: z.string().nullable(),
  linked_incident_ids: z.array(z.string()),
  linked_audit_record_ids: z.array(z.string()),
  sla_due_rfc3339: z.string().nullable(),
  created_at_rfc3339: z.string(),
  summary: z.string().nullable(),
  origin: z.enum(["operator", "device"]).nullable(),
  created_by: z.string().nullable(),
  diagnostic_bundle_ids: z.array(z.string()),
});

export const DiagnosticArtifactRefV1Schema = z.object({
  logical_path: z.string().min(1),
  sha256: z.string().min(1),
  kind: z.string().min(1),
});

export const DiagnosticBundleManifestV1Schema = z.object({
  bundle_id: z.string().min(1),
  created_at_rfc3339: z.string(),
  redaction_profile: z.string().min(1),
  artifacts: z.array(DiagnosticArtifactRefV1Schema),
});

/** A bundle uploaded by a desktop (GET /api/v1/support/diagnostic-bundles). */
export const DiagnosticBundleSummaryV1Schema = DiagnosticBundleManifestV1Schema.extend({
  tenant_id: z.string().nullable(),
  machine_id: z.string().nullable(),
  app_version: z.string().nullable(),
  status: z.enum(["pending_upload", "uploaded", "rejected"]).nullable(),
  byte_size: z.number().int().nonnegative().nullable(),
  content_sha256: z.string().nullable(),
  ticket_id: z.string().nullable(),
  uploaded_at_rfc3339: z.string().nullable(),
  rejection_reason: z.string().nullable(),
});

export const DiagnosticBundleDownloadV1Schema = z.object({
  bundle_id: z.string().min(1),
  url: z.string().url(),
  expires_in_seconds: z.number().int().positive(),
  byte_size: z.number().int().nonnegative().nullable(),
  content_sha256: z.string().nullable(),
  audit_record_id: z.string().min(1),
});

export const OfflineTicketReconciliationRowV1Schema = z.object({
  desktop_queue_id: z.string().min(1),
  vendor_ticket_id: z.string().nullable(),
  sync_state: z.string().min(1),
  duplicate_of: z.string().nullable(),
});

export const IncidentRunbookEntryV1Schema = z.object({
  /** Operators can add runbooks, so the id is any snake_case slug (the standard ones: api/src/app/runbooks.ts). */
  runbook_id: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  title: z.string().min(1),
  summary: z.string().min(1),
  first_steps: z.array(z.string()),
  updated_at_rfc3339: z.string().nullable(),
  updated_by: z.string().nullable(),
});

export const AuditReadinessCheckItemV1Schema = z.object({
  code: z.string().min(1),
  description: z.string().min(1),
  passed: z.boolean(),
});

/** Mirrors Rust `privileged_action_guard_ok`. */
export function privilegedActionGuardOk(
  reasonCode: string | null | undefined,
  stepUpSatisfied: boolean,
  dualApprovalPresent: boolean,
  requiresDualApproval: boolean,
): boolean {
  const reasonOk = (reasonCode?.length ?? 0) >= 4;
  if (!reasonOk || !stepUpSatisfied) return false;
  if (requiresDualApproval && !dualApprovalPresent) return false;
  return true;
}

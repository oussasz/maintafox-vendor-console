import { z } from "zod";

import { getAccessToken } from "@/lib/auth-token";
import { privilegedHeaders, type PrivilegedActionContext } from "@/services/license-control-service";
import {
  AuditReadinessCheckItemV1Schema,
  DiagnosticBundleManifestV1Schema,
  IncidentRunbookEntryV1Schema,
  OfflineTicketReconciliationRowV1Schema,
  SupportTicketV1Schema,
  VendorAdminAuditRecordV1Schema,
} from "@/services/vendor-audit-support-contracts";

export type AuditRecord = z.infer<typeof VendorAdminAuditRecordV1Schema>;
export type SupportTicket = z.infer<typeof SupportTicketV1Schema>;
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleManifestV1Schema>;
export type OfflineReconciliationRow = z.infer<typeof OfflineTicketReconciliationRowV1Schema>;
export type IncidentRunbookEntry = z.infer<typeof IncidentRunbookEntryV1Schema>;
export type ReadinessCheckItem = z.infer<typeof AuditReadinessCheckItemV1Schema>;

function apiBase(): string {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) throw new Error("VITE_ADMIN_API_BASE_URL is not configured.");
  return raw.replace(/\/$/, "");
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated.");
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function parseOrThrow<T>(res: Response, parser: { parse: (v: unknown) => T }, label: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status})`);
  }
  return parser.parse(await res.json());
}

export async function listAuditLedger(input?: {
  q?: string;
  category?:
    | "all"
    | "auth_session"
    | "entitlement"
    | "machine"
    | "sync_repair"
    | "rollout_intervention"
    | "platform_override"
    | "support_intervention";
  limit?: number;
}): Promise<AuditRecord[]> {
  const params = new URLSearchParams();
  if (input?.q) params.set("q", input.q);
  if (input?.category) params.set("category", input.category);
  if (input?.limit) params.set("limit", String(input.limit));
  const q = params.toString();
  const res = await authFetch(`/api/v1/audit/ledger${q ? `?${q}` : ""}`);
  return parseOrThrow(res, z.array(VendorAdminAuditRecordV1Schema), "Audit ledger");
}

export async function verifyAuditLedgerChainRemote(): Promise<{
  status: "ok" | "integrity_mismatch" | "chain_broken";
  checked_count: number;
}> {
  const schema = z.object({
    status: z.enum(["ok", "integrity_mismatch", "chain_broken"]),
    checked_count: z.number().int().nonnegative(),
  });
  const res = await authFetch("/api/v1/audit/ledger/verify-chain");
  return parseOrThrow(res, schema, "Audit chain verification");
}

export async function listSupportTickets(): Promise<SupportTicket[]> {
  const res = await authFetch("/api/v1/support/tickets");
  return parseOrThrow(res, z.array(SupportTicketV1Schema), "Support tickets");
}

export async function createSupportIntervention(
  ticketId: string,
  input: {
    action_code: string;
    note: string;
    next_state?: "new" | "triaged" | "waiting_for_vendor" | "waiting_for_customer" | "resolved" | "closed";
    reason_code?: string;
  },
  privileged: PrivilegedActionContext,
): Promise<{ ok: true; audit_record_id: string; state: string }> {
  const schema = z.object({
    ok: z.literal(true),
    audit_record_id: z.string().min(1),
    state: z.string().min(1),
  });
  const res = await authFetch(`/api/v1/support/tickets/${encodeURIComponent(ticketId)}/interventions`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: privilegedHeaders(privileged),
  });
  return parseOrThrow(res, schema, "Support intervention");
}

export async function getLatestDiagnosticBundle(): Promise<DiagnosticBundle> {
  const res = await authFetch("/api/v1/support/diagnostic-bundles/latest");
  return parseOrThrow(res, DiagnosticBundleManifestV1Schema, "Diagnostic bundle");
}

export async function listOfflineReconciliation(): Promise<OfflineReconciliationRow[]> {
  const res = await authFetch("/api/v1/support/offline-reconciliation");
  return parseOrThrow(res, z.array(OfflineTicketReconciliationRowV1Schema), "Offline reconciliation");
}

export async function listIncidentRunbooks(): Promise<IncidentRunbookEntry[]> {
  const res = await authFetch("/api/v1/audit/hardening/runbooks");
  return parseOrThrow(res, z.array(IncidentRunbookEntryV1Schema), "Incident runbooks");
}

export async function listReadinessChecks(): Promise<ReadinessCheckItem[]> {
  const res = await authFetch("/api/v1/audit/hardening/readiness");
  return parseOrThrow(res, z.array(AuditReadinessCheckItemV1Schema), "Readiness checks");
}

async function downloadCsv(path: string): Promise<Blob> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated.");
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Accept: "text/csv", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`CSV export failed (${res.status})`);
  }
  return res.blob();
}

export async function downloadAuditLedgerCsv(): Promise<Blob> {
  return downloadCsv("/api/v1/audit/ledger/export");
}

export async function downloadSupportTicketsCsv(): Promise<Blob> {
  return downloadCsv("/api/v1/support/tickets/export");
}

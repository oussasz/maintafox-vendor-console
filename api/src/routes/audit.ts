/**
 * Audit ledger: listing, hash-chain verification, CSV export.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { isAuditActionCategory } from "../app/audit-categories.js";
import { parsePagination, sendValidationError } from "../app/http.js";
import { AUDIT_RECORD_COLUMNS, mapAuditRow, verifyAuditChain, type AuditRecordRow } from "../audit-chain.js";

const AuditLedgerQuery = z.object({
  q: z.string().optional(),
  // "all" or a category of shared/audit-action-categories.v1.json.
  category: z
    .string()
    .refine((value) => value === "all" || isAuditActionCategory(value), { message: "unknown audit category" })
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

export function registerAuditRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware } = ctx;

  app.get("/api/v1/audit/ledger", authMiddleware, async (req, res) => {
    const parsed = AuditLedgerQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "query");
      return;
    }
    const { q, category, limit } = parsed.data;
    const pagination = parsePagination(req.query);
    const effectiveLimit = limit ?? pagination.limit;
    const cursorSequence = pagination.cursor ? Number.parseInt(pagination.cursor, 10) : null;
    const qTrimmed = q?.trim().toLowerCase() ?? "";
    const rows = (cursorSequence
      ? await db.all(`SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                    correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                    payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                    approval_correlation_id, entity_refs_json
             FROM audit_records
             WHERE sequence < ?
             ORDER BY sequence DESC
             LIMIT ?`, cursorSequence, effectiveLimit + 1)
      : await db.all(`SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                    correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                    payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                    approval_correlation_id, entity_refs_json
             FROM audit_records
             ORDER BY sequence DESC
             LIMIT ?`, effectiveLimit + 1)) as Array<{
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
      }>;
    const mapped = rows.map(mapAuditRow).filter((row) => {
      if (category && category !== "all" && row.action_category !== category) return false;
      if (!qTrimmed) return true;
      return (
        row.record_id.toLowerCase().includes(qTrimmed) ||
        row.actor_id.toLowerCase().includes(qTrimmed) ||
        row.correlation_id.toLowerCase().includes(qTrimmed) ||
        row.action_code.toLowerCase().includes(qTrimmed) ||
        (row.entity_refs.tenant_id?.toLowerCase().includes(qTrimmed) ?? false) ||
        (row.entity_refs.support_ticket_id?.toLowerCase().includes(qTrimmed) ?? false)
      );
    });
    const items = mapped.slice(0, effectiveLimit);
    const hasMore = mapped.length > effectiveLimit;
    if (pagination.withPagination) {
      res.json({
        items,
        next_cursor: hasMore && items.length > 0 ? String(items[items.length - 1]?.sequence ?? "") : null,
        limit: effectiveLimit,
      });
      return;
    }
    res.json(items);
  });

  app.get("/api/v1/audit/ledger/verify-chain", authMiddleware, async (_req, res) => {
    const rows = await db.all<AuditRecordRow>(
      `SELECT ${AUDIT_RECORD_COLUMNS}
       FROM audit_records
       ORDER BY sequence ASC`,
    );
    const result = verifyAuditChain(rows);
    res.json({ status: result.status, checked_count: result.checked_count });
  });

  app.get("/api/v1/audit/ledger/export", authMiddleware, async (_req, res) => {
    const rows = await db.all(`SELECT sequence, occurred_at_rfc3339, actor_id, action_code, action_category, correlation_id,
                scope_tenant_id, reason_code, approval_correlation_id, record_id
         FROM audit_records
         ORDER BY sequence DESC`) as Array<{
        sequence: number;
        occurred_at_rfc3339: string;
        actor_id: string;
        action_code: string;
        action_category: string;
        correlation_id: string;
        scope_tenant_id: string | null;
        reason_code: string | null;
        approval_correlation_id: string | null;
        record_id: string;
      }>;
    const header =
      "sequence,occurred_at_rfc3339,actor_id,action_code,action_category,correlation_id,scope_tenant_id,reason_code,approval_correlation_id,record_id";
    const csv = [
      header,
      ...rows.map((r) =>
        [
          r.sequence,
          r.occurred_at_rfc3339,
          r.actor_id,
          r.action_code,
          r.action_category,
          r.correlation_id,
          r.scope_tenant_id ?? "",
          r.reason_code ?? "",
          r.approval_correlation_id ?? "",
          r.record_id,
        ]
          .map((v) => `"${String(v).replaceAll(`"`, `""`)}"`)
          .join(","),
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="audit-ledger.csv"');
    res.status(200).send(csv);
  });
}

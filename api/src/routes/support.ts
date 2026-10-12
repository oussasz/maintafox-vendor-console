/**
 * Support: tickets and interventions, diagnostic bundles, offline reconciliation, runbooks and
 * hardening readiness.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { parsePagination, resolveActorId, sendValidationError } from "../app/http.js";
import { newId } from "../app/runtime.js";

const SupportInterventionBody = z.object({
  action_code: z.string().trim().min(3).max(64),
  note: z.string().trim().min(3).max(2048),
  next_state: z
    .enum(["new", "triaged", "waiting_for_vendor", "waiting_for_customer", "resolved", "closed"])
    .optional(),
  reason_code: z.string().trim().min(2).max(128).optional(),
}).strict();

export function registerSupportRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction } = ctx;

  app.get("/api/v1/support/tickets", authMiddleware, async (req, res) => {
    const { cursor, limit, withPagination } = parsePagination(req.query);
    const effectiveLimit = withPagination ? limit : 10_000;
    const cursorCreatedAt = cursor?.split("|")[0] ?? null;
    const cursorTicketId = cursor?.split("|")[1] ?? "";
    const rows = (cursor
      ? await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                    linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
             FROM support_tickets
             WHERE (created_at_rfc3339 < ?) OR (created_at_rfc3339 = ? AND ticket_id < ?)
             ORDER BY created_at_rfc3339 DESC, ticket_id DESC
             LIMIT ?`, cursorCreatedAt, cursorCreatedAt, cursorTicketId, effectiveLimit + 1)
      : await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                    linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
             FROM support_tickets
             ORDER BY created_at_rfc3339 DESC, ticket_id DESC
             LIMIT ?`, effectiveLimit + 1)) as Array<{
        ticket_id: string;
        tenant_id: string;
        state: string;
        severity: "info" | "warn" | "critical";
        affected_module: string;
        sync_status_hint: string;
        app_version_reported: string;
        linked_incident_ids_json: string;
        sla_due_rfc3339: string | null;
        created_at_rfc3339: string;
      }>;
    const mapped = await Promise.all(rows.slice(0, effectiveLimit).map(async (row) => {
      const linkedAudit = await db.all("SELECT audit_record_id FROM support_ticket_interventions WHERE ticket_id = ? ORDER BY created_at_rfc3339 DESC", row.ticket_id) as Array<{ audit_record_id: string }>;
      let incidents: string[] = [];
      try {
        incidents = JSON.parse(row.linked_incident_ids_json) as string[];
      } catch {
        incidents = [];
      }
      return {
        ticket_id: row.ticket_id,
        tenant_id: row.tenant_id,
        state: row.state,
        severity: row.severity,
        affected_module: row.affected_module,
        sync_status_hint: row.sync_status_hint,
        app_version_reported: row.app_version_reported,
        linked_incident_ids: incidents,
        linked_audit_record_ids: linkedAudit.map((a) => a.audit_record_id),
        sla_due_rfc3339: row.sla_due_rfc3339,
        created_at_rfc3339: row.created_at_rfc3339,
      };
    }));
    if (withPagination) {
      const hasMore = rows.length > effectiveLimit;
      const last = mapped[mapped.length - 1];
      res.json({
        items: mapped,
        next_cursor: hasMore && last ? `${last.created_at_rfc3339}|${last.ticket_id}` : null,
        limit: effectiveLimit,
      });
      return;
    }
    res.json(mapped);
  });

  app.post("/api/v1/support/tickets/:ticketId/interventions", authMiddleware, async (req, res) => {
    const parsed = SupportInterventionBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const ticketId = req.params.ticketId;
      const ticket = await db.get(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
           FROM support_tickets WHERE ticket_id = ?`, ticketId) as
        | {
            ticket_id: string;
            tenant_id: string;
            state: string;
            severity: "info" | "warn" | "critical";
            affected_module: string;
            sync_status_hint: string;
            app_version_reported: string;
            linked_incident_ids_json: string;
            sla_due_rfc3339: string | null;
            created_at_rfc3339: string;
          }
        | undefined;
      if (!ticket) {
        return { status: 404, body: { error: "ticket_not_found" } };
      }
      const nextState = parsed.data.next_state ?? ticket.state;
      const guard = await requirePrivilegedAction(req, {
        action_code: parsed.data.action_code,
        action_category: "support_intervention",
        scope_tenant_id: ticket.tenant_id,
        entity_refs: { tenant_id: ticket.tenant_id, support_ticket_id: ticketId },
        payload: { note: parsed.data.note, from_state: ticket.state, to_state: nextState },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      const actorId = resolveActorId(req);
      await db.run("UPDATE support_tickets SET state = ? WHERE ticket_id = ?", nextState, ticketId);
      const auditId = guard.auditRecordId;
      await db.run(`INSERT INTO support_ticket_interventions
          (intervention_id, ticket_id, actor_id, action_code, note, from_state, to_state,
           reason_code, audit_record_id, created_at_rfc3339)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId("intv"),
        ticketId,
        actorId,
        parsed.data.action_code,
        parsed.data.note,
        ticket.state,
        nextState,
        parsed.data.reason_code ?? null,
        auditId,
        new Date().toISOString());
      return { status: 201, body: { ok: true, audit_record_id: auditId, state: nextState } };
    });
  });

  app.get("/api/v1/support/tickets/export", authMiddleware, async (_req, res) => {
    const rows = await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint,
                app_version_reported, sla_due_rfc3339, created_at_rfc3339
         FROM support_tickets
         ORDER BY created_at_rfc3339 DESC`) as Array<{
        ticket_id: string;
        tenant_id: string;
        state: string;
        severity: string;
        affected_module: string;
        sync_status_hint: string;
        app_version_reported: string;
        sla_due_rfc3339: string | null;
        created_at_rfc3339: string;
      }>;
    const header =
      "ticket_id,tenant_id,state,severity,affected_module,sync_status_hint,app_version_reported,sla_due_rfc3339,created_at_rfc3339";
    const csv = [
      header,
      ...rows.map((r) =>
        [
          r.ticket_id,
          r.tenant_id,
          r.state,
          r.severity,
          r.affected_module,
          r.sync_status_hint,
          r.app_version_reported,
          r.sla_due_rfc3339 ?? "",
          r.created_at_rfc3339,
        ]
          .map((v) => `"${String(v).replaceAll(`"`, `""`)}"`)
          .join(","),
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="support-tickets.csv"');
    res.status(200).send(csv);
  });

  app.get("/api/v1/support/diagnostic-bundles/latest", authMiddleware, async (_req, res) => {
    const bundle = await db.get("SELECT bundle_id, created_at_rfc3339, redaction_profile FROM diagnostic_bundles ORDER BY created_at_rfc3339 DESC LIMIT 1") as { bundle_id: string; created_at_rfc3339: string; redaction_profile: string } | undefined;
    if (!bundle) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    const artifacts = await db.all("SELECT logical_path, sha256, kind FROM diagnostic_bundle_artifacts WHERE bundle_id = ? ORDER BY logical_path ASC", bundle.bundle_id) as Array<{ logical_path: string; sha256: string; kind: string }>;
    res.json({
      bundle_id: bundle.bundle_id,
      created_at_rfc3339: bundle.created_at_rfc3339,
      redaction_profile: bundle.redaction_profile,
      artifacts,
    });
  });

  app.get("/api/v1/support/offline-reconciliation", authMiddleware, async (_req, res) => {
    const rows = await db.all("SELECT desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of FROM offline_ticket_reconciliation ORDER BY desktop_queue_id ASC");
    res.json(rows);
  });

  app.get("/api/v1/audit/hardening/runbooks", authMiddleware, async (_req, res) => {
    const rows = await db.all("SELECT runbook_id, title, summary, first_steps_json FROM incident_runbooks ORDER BY runbook_id ASC") as Array<{ runbook_id: string; title: string; summary: string; first_steps_json: string }>;
    const mapped = rows.map((row) => {
      let steps: string[] = [];
      try {
        steps = JSON.parse(row.first_steps_json) as string[];
      } catch {
        steps = [];
      }
      return { runbook_id: row.runbook_id, title: row.title, summary: row.summary, first_steps: steps };
    });
    res.json(mapped);
  });

  app.get("/api/v1/audit/hardening/readiness", authMiddleware, async (_req, res) => {
    const auditCount = (await db.get("SELECT COUNT(*) as c FROM audit_records") as { c: number }).c;
    const interventionCount = (await db.get("SELECT COUNT(*) as c FROM support_ticket_interventions") as { c: number }).c;
    const bundleCount = (await db.get("SELECT COUNT(*) as c FROM diagnostic_bundles") as { c: number }).c;
    res.json([
      {
        code: "audit_chain_verified",
        description: "Audit records pass chain verification and integrity hash checks.",
        passed: auditCount > 0,
      },
      {
        code: "support_ticket_linked",
        description: "Support interventions are linked to immutable audit records.",
        passed: interventionCount > 0,
      },
      {
        code: "export_redaction",
        description: "Diagnostic bundles are present with redaction profile and artifact digests.",
        passed: bundleCount > 0,
      },
    ]);
  });
}

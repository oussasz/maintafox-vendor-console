/**
 * Support (master plan Phase 3.4): tickets (opened by operators or by devices) and interventions,
 * diagnostic bundles uploaded by devices to object storage, offline reconciliation, editable
 * runbooks, and hardening readiness computed from the data.
 *
 * Device routes (activation token, tenant scope) live under /api/v1/sync/diagnostic-bundles:
 *   1. POST /api/v1/sync/diagnostic-bundles            declare size + SHA-256 -> presigned PUT
 *   2. PUT <url>                                       the device uploads the bytes
 *   3. POST /api/v1/sync/diagnostic-bundles/:id/complete  the server reads the object back,
 *      checks size and SHA-256, marks it uploaded, and opens the requested ticket.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { deviceRateLimiter, parsePagination, resolveActorId, sendValidationError, type ActivationAuthContext } from "../app/http.js";
import { getMediaStore, sendObjectStoreError } from "../app/media.js";
import { newId, structuredLog } from "../app/runtime.js";
import { AUDIT_RECORD_COLUMNS, verifyAuditChain, type AuditRecordRow } from "../audit-chain.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

/** Largest diagnostic bundle accepted (the desktop bundle is ~0.1 MB: 500 sanitized log lines). */
export const DIAGNOSTIC_BUNDLE_MAX_BYTES = 5 * 1024 * 1024;
const TICKET_STATES = ["new", "triaged", "waiting_for_vendor", "waiting_for_customer", "resolved", "closed"] as const;
const SeveritySchema = z.enum(["info", "warn", "critical"]);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");

const SupportInterventionBody = z.object({
  action_code: z.string().trim().min(3).max(64),
  note: z.string().trim().min(3).max(2048),
  next_state: z.enum(TICKET_STATES).optional(),
  reason_code: z.string().trim().min(2).max(128).optional(),
}).strict();

const CreateTicketBody = z
  .object({
    tenant_id: z.string().min(3).max(128),
    severity: SeveritySchema,
    affected_module: z.string().trim().min(2).max(64),
    summary: z.string().trim().min(3).max(2000),
    sla_due_rfc3339: z.string().datetime().nullable().optional(),
  })
  .strict();

const DeviceTicketRequest = z
  .object({
    summary: z.string().trim().min(3).max(2000),
    affected_module: z.string().trim().min(2).max(64),
    severity: SeveritySchema,
  })
  .strict();

const CreateBundleBody = z
  .object({
    content_sha256: Sha256Schema,
    byte_size: z.number().int().min(1).max(DIAGNOSTIC_BUNDLE_MAX_BYTES),
    redaction_profile: z.string().trim().min(2).max(64),
    app_version: z.string().trim().min(1).max(32),
    artifacts: z
      .array(
        z
          .object({
            logical_path: z.string().trim().min(1).max(256),
            sha256: Sha256Schema,
            kind: z.string().trim().min(2).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    ticket: DeviceTicketRequest.optional(),
  })
  .strict();

const RunbookIdSchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, "lowercase snake_case, 3..64 characters");
const RunbookBody = z
  .object({
    title: z.string().trim().min(3).max(128),
    summary: z.string().trim().min(3).max(1000),
    first_steps: z.array(z.string().trim().min(3).max(1000)).min(1).max(30),
  })
  .strict();
const CreateRunbookBody = RunbookBody.extend({ runbook_id: RunbookIdSchema }).strict();

type TicketRow = {
  ticket_id: string;
  tenant_id: string;
  state: string;
  severity: "info" | "warn" | "critical";
  affected_module: string;
  sync_status_hint: string | null;
  app_version_reported: string | null;
  linked_incident_ids_json: string;
  sla_due_rfc3339: string | null;
  created_at_rfc3339: string;
  summary: string | null;
  origin: string | null;
  created_by: string | null;
};

const TICKET_COLUMNS = `ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339, summary, origin, created_by`;

type BundleRow = {
  bundle_id: string;
  tenant_id: string | null;
  machine_fingerprint: string | null;
  app_version: string | null;
  status: string | null;
  object_key: string | null;
  byte_size: number | null;
  content_sha256: string | null;
  redaction_profile: string;
  requested_ticket_json: string | null;
  ticket_id: string | null;
  created_at_rfc3339: string;
  uploaded_at_rfc3339: string | null;
  rejection_reason: string | null;
};

const BUNDLE_COLUMNS = `bundle_id, tenant_id, machine_fingerprint, app_version, status, object_key, byte_size, content_sha256,
  redaction_profile, requested_ticket_json, ticket_id, created_at_rfc3339, uploaded_at_rfc3339, rejection_reason`;

function parseJsonArray(text: string): string[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function registerSupportRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, activationAuthMiddleware, runIdempotent, requirePrivilegedAction, appendAuditRecord } = ctx;

  async function mapTicket(row: TicketRow) {
    const linkedAudit = await db.all<{ audit_record_id: string }>(
      "SELECT audit_record_id FROM support_ticket_interventions WHERE ticket_id = ? ORDER BY created_at_rfc3339 DESC",
      row.ticket_id,
    );
    const bundles = await db.all<{ bundle_id: string }>(
      "SELECT bundle_id FROM diagnostic_bundles WHERE ticket_id = ? ORDER BY created_at_rfc3339 DESC",
      row.ticket_id,
    );
    return {
      ticket_id: row.ticket_id,
      tenant_id: row.tenant_id,
      state: row.state,
      severity: row.severity,
      affected_module: row.affected_module,
      sync_status_hint: row.sync_status_hint,
      app_version_reported: row.app_version_reported,
      linked_incident_ids: parseJsonArray(row.linked_incident_ids_json),
      linked_audit_record_ids: linkedAudit.map((a) => a.audit_record_id),
      sla_due_rfc3339: row.sla_due_rfc3339,
      created_at_rfc3339: row.created_at_rfc3339,
      summary: row.summary,
      origin: row.origin,
      created_by: row.created_by,
      diagnostic_bundle_ids: bundles.map((b) => b.bundle_id),
    };
  }

  async function bundleArtifacts(bundleId: string) {
    return db.all<{ logical_path: string; sha256: string; kind: string }>(
      "SELECT logical_path, sha256, kind FROM diagnostic_bundle_artifacts WHERE bundle_id = ? ORDER BY logical_path ASC",
      bundleId,
    );
  }

  async function mapBundle(row: BundleRow) {
    return {
      bundle_id: row.bundle_id,
      tenant_id: row.tenant_id,
      machine_id: row.machine_fingerprint,
      app_version: row.app_version,
      status: row.status,
      byte_size: row.byte_size,
      content_sha256: row.content_sha256,
      redaction_profile: row.redaction_profile,
      ticket_id: row.ticket_id,
      created_at_rfc3339: row.created_at_rfc3339,
      uploaded_at_rfc3339: row.uploaded_at_rfc3339,
      rejection_reason: row.rejection_reason,
      artifacts: await bundleArtifacts(row.bundle_id),
    };
  }

  // ── Tickets ────────────────────────────────────────────────────────────────────────────────

  app.get("/api/v1/support/tickets", authMiddleware, async (req, res) => {
    const { cursor, limit, withPagination } = parsePagination(req.query);
    const effectiveLimit = withPagination ? limit : 10_000;
    const cursorCreatedAt = cursor?.split("|")[0] ?? null;
    const cursorTicketId = cursor?.split("|")[1] ?? "";
    const rows = cursor
      ? await db.all<TicketRow>(
          `SELECT ${TICKET_COLUMNS}
           FROM support_tickets
           WHERE (created_at_rfc3339 < ?) OR (created_at_rfc3339 = ? AND ticket_id < ?)
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorTicketId,
          effectiveLimit + 1,
        )
      : await db.all<TicketRow>(
          `SELECT ${TICKET_COLUMNS}
           FROM support_tickets
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`,
          effectiveLimit + 1,
        );
    const mapped = await Promise.all(rows.slice(0, effectiveLimit).map(mapTicket));
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

  /** An operator opens a ticket for a tenant (recorded in the audit ledger). */
  app.post("/api/v1/support/tickets", authMiddleware, async (req, res) => {
    const parsed = CreateTicketBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const input = parsed.data;
      const tenant = await db.get<{ id: string }>("SELECT id FROM tenants WHERE id = ?", input.tenant_id);
      if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
      const ticketId = newId("sup");
      const actor = resolveActorId(req);
      await db.run(
        `INSERT INTO support_tickets
           (ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
            linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339, summary, origin, created_by)
         VALUES (?, ?, 'new', ?, ?, NULL, NULL, '[]', ?, ?, ?, 'operator', ?)`,
        ticketId,
        input.tenant_id,
        input.severity,
        input.affected_module,
        input.sla_due_rfc3339 ?? null,
        new Date().toISOString(),
        input.summary,
        actor,
      );
      await appendAuditRecord({
        actor_id: actor,
        action_code: "support_ticket_create",
        action_category: "support_intervention",
        correlation_id: ticketId,
        scope_tenant_id: input.tenant_id,
        entity_refs: { tenant_id: input.tenant_id, support_ticket_id: ticketId },
        payload: { severity: input.severity, affected_module: input.affected_module, summary: input.summary },
      });
      const row = await db.get<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE ticket_id = ?`, ticketId);
      return { status: 201, body: await mapTicket(row!) };
    });
  });

  app.post("/api/v1/support/tickets/:ticketId/interventions", authMiddleware, async (req, res) => {
    const parsed = SupportInterventionBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const ticketId = req.params.ticketId;
      const ticket = await db.get<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE ticket_id = ?`, ticketId);
      if (!ticket) {
        return { status: 404, body: { error: "ticket_not_found" } };
      }
      const nextState = parsed.data.next_state ?? ticket.state;
      const guard = await requirePrivilegedAction(req, {
        action_code: parsed.data.action_code,
        step_up_kind: StepUpKinds.supportIntervention,
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
    const rows = await db.all<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM support_tickets ORDER BY created_at_rfc3339 DESC`);
    const header =
      "ticket_id,tenant_id,state,severity,affected_module,sync_status_hint,app_version_reported,sla_due_rfc3339,created_at_rfc3339,summary,origin,created_by";
    const csv = [
      header,
      ...rows.map((r) =>
        [
          r.ticket_id,
          r.tenant_id,
          r.state,
          r.severity,
          r.affected_module,
          r.sync_status_hint ?? "",
          r.app_version_reported ?? "",
          r.sla_due_rfc3339 ?? "",
          r.created_at_rfc3339,
          r.summary ?? "",
          r.origin ?? "",
          r.created_by ?? "",
        ]
          .map((v) => `"${String(v).replaceAll(`"`, `""`)}"`)
          .join(","),
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="support-tickets.csv"');
    res.status(200).send(csv);
  });

  // ── Diagnostic bundles (console) ──────────────────────────────────────────────────────────

  app.get("/api/v1/support/diagnostic-bundles", authMiddleware, async (req, res) => {
    const tenantId = typeof req.query.tenant_id === "string" && req.query.tenant_id ? req.query.tenant_id : null;
    const rows = tenantId
      ? await db.all<BundleRow>(
          `SELECT ${BUNDLE_COLUMNS} FROM diagnostic_bundles WHERE tenant_id = ? ORDER BY created_at_rfc3339 DESC LIMIT 200`,
          tenantId,
        )
      : await db.all<BundleRow>(`SELECT ${BUNDLE_COLUMNS} FROM diagnostic_bundles ORDER BY created_at_rfc3339 DESC LIMIT 200`);
    res.json(await Promise.all(rows.map(mapBundle)));
  });

  app.get("/api/v1/support/diagnostic-bundles/latest", authMiddleware, async (_req, res) => {
    const bundle = await db.get<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM diagnostic_bundles WHERE status = 'uploaded' ORDER BY uploaded_at_rfc3339 DESC LIMIT 1`,
    );
    if (!bundle) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    res.json(await mapBundle(bundle));
  });

  /** Presigned download of an uploaded bundle; every download is recorded in the audit ledger. */
  app.get("/api/v1/support/diagnostic-bundles/:bundleId/download", authMiddleware, async (req, res) => {
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const bundle = await db.get<BundleRow>(`SELECT ${BUNDLE_COLUMNS} FROM diagnostic_bundles WHERE bundle_id = ?`, req.params.bundleId);
    if (!bundle) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    if (bundle.status !== "uploaded" || !bundle.object_key) {
      res.status(409).json({ error: "bundle_not_uploaded", status: bundle.status });
      return;
    }
    let signed;
    try {
      signed = await media.presignGet(bundle.object_key);
    } catch (err) {
      sendObjectStoreError(res, "diagnostic_bundle_download_failed", err, { bundle_id: bundle.bundle_id });
      return;
    }
    const auditRecordId = await appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: "diagnostic_bundle_download",
      action_category: "support_intervention",
      correlation_id: bundle.bundle_id,
      scope_tenant_id: bundle.tenant_id,
      entity_refs: { tenant_id: bundle.tenant_id ?? undefined, support_ticket_id: bundle.ticket_id ?? undefined },
      payload: { bundle_id: bundle.bundle_id, content_sha256: bundle.content_sha256 },
    });
    res.json({
      bundle_id: bundle.bundle_id,
      url: signed.url,
      expires_in_seconds: signed.expires_in_seconds,
      byte_size: bundle.byte_size,
      content_sha256: bundle.content_sha256,
      audit_record_id: auditRecordId,
    });
  });

  app.get("/api/v1/support/offline-reconciliation", authMiddleware, async (_req, res) => {
    const rows = await db.all("SELECT desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of FROM offline_ticket_reconciliation ORDER BY desktop_queue_id ASC");
    res.json(rows);
  });

  // ── Runbooks ─────────────────────────────────────────────────────────────────────────────

  type RunbookRow = { runbook_id: string; title: string; summary: string; first_steps_json: string; updated_at_rfc3339: string | null; updated_by: string | null };
  const mapRunbook = (row: RunbookRow) => ({
    runbook_id: row.runbook_id,
    title: row.title,
    summary: row.summary,
    first_steps: parseJsonArray(row.first_steps_json),
    updated_at_rfc3339: row.updated_at_rfc3339,
    updated_by: row.updated_by,
  });
  const RUNBOOK_COLUMNS = "runbook_id, title, summary, first_steps_json, updated_at_rfc3339, updated_by";

  app.get("/api/v1/audit/hardening/runbooks", authMiddleware, async (_req, res) => {
    const rows = await db.all<RunbookRow>(`SELECT ${RUNBOOK_COLUMNS} FROM incident_runbooks ORDER BY runbook_id ASC`);
    res.json(rows.map(mapRunbook));
  });

  app.post("/api/v1/audit/hardening/runbooks", authMiddleware, async (req, res) => {
    const parsed = CreateRunbookBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const input = parsed.data;
      if (await db.get("SELECT 1 FROM incident_runbooks WHERE runbook_id = ?", input.runbook_id)) {
        return { status: 409, body: { error: "runbook_exists" } };
      }
      const actor = resolveActorId(req);
      await db.run(
        `INSERT INTO incident_runbooks (runbook_id, title, summary, first_steps_json, updated_at_rfc3339, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.runbook_id,
        input.title,
        input.summary,
        JSON.stringify(input.first_steps),
        new Date().toISOString(),
        actor,
      );
      await appendAuditRecord({
        actor_id: actor,
        action_code: "runbook_create",
        action_category: "support_intervention",
        correlation_id: input.runbook_id,
        payload: input,
      });
      const row = await db.get<RunbookRow>(`SELECT ${RUNBOOK_COLUMNS} FROM incident_runbooks WHERE runbook_id = ?`, input.runbook_id);
      return { status: 201, body: mapRunbook(row!) };
    });
  });

  app.put("/api/v1/audit/hardening/runbooks/:runbookId", authMiddleware, async (req, res) => {
    const parsed = RunbookBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const runbookId = req.params.runbookId;
      const actor = resolveActorId(req);
      const updated = await db.run(
        `UPDATE incident_runbooks SET title = ?, summary = ?, first_steps_json = ?, updated_at_rfc3339 = ?, updated_by = ?
         WHERE runbook_id = ?`,
        parsed.data.title,
        parsed.data.summary,
        JSON.stringify(parsed.data.first_steps),
        new Date().toISOString(),
        actor,
        runbookId,
      );
      if (updated.changes === 0) return { status: 404, body: { error: "runbook_not_found" } };
      await appendAuditRecord({
        actor_id: actor,
        action_code: "runbook_update",
        action_category: "support_intervention",
        correlation_id: runbookId,
        payload: { runbook_id: runbookId, ...parsed.data },
      });
      const row = await db.get<RunbookRow>(`SELECT ${RUNBOOK_COLUMNS} FROM incident_runbooks WHERE runbook_id = ?`, runbookId);
      return { status: 200, body: mapRunbook(row!) };
    });
  });

  app.delete("/api/v1/audit/hardening/runbooks/:runbookId", authMiddleware, async (req, res) => {
    await runIdempotent(req, res, async () => {
      const runbookId = req.params.runbookId;
      const removed = await db.run("DELETE FROM incident_runbooks WHERE runbook_id = ?", runbookId);
      if (removed.changes === 0) return { status: 404, body: { error: "runbook_not_found" } };
      const auditRecordId = await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "runbook_delete",
        action_category: "support_intervention",
        correlation_id: runbookId,
        payload: { runbook_id: runbookId },
      });
      return { status: 200, body: { ok: true, audit_record_id: auditRecordId } };
    });
  });

  // ── Readiness (computed, not counted) ──────────────────────────────────────────────────

  app.get("/api/v1/audit/hardening/readiness", authMiddleware, async (_req, res) => {
    const chain = verifyAuditChain(
      await db.all<AuditRecordRow>(`SELECT ${AUDIT_RECORD_COLUMNS} FROM audit_records ORDER BY sequence ASC`),
    );
    const unlinked = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM support_ticket_interventions i
       WHERE NOT EXISTS (SELECT 1 FROM audit_records a WHERE a.record_id = i.audit_record_id)`,
    );
    const bundles = await db.get<{ uploaded: number; unverified: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'uploaded') AS uploaded,
              COUNT(*) FILTER (WHERE status = 'uploaded' AND (content_sha256 IS NULL OR redaction_profile = '')) AS unverified
       FROM diagnostic_bundles`,
    );
    res.json([
      {
        code: "audit_chain_verified",
        description: `Audit hash chain recomputed over ${chain.checked_count} records: ${chain.status}.`,
        passed: chain.status === "ok" && chain.checked_count > 0,
      },
      {
        code: "support_ticket_linked",
        description: `Every support intervention points to an audit record (${unlinked?.c ?? 0} without one).`,
        passed: (unlinked?.c ?? 0) === 0,
      },
      {
        code: "export_redaction",
        description: `Uploaded diagnostic bundles carry a redaction profile and a verified SHA-256 (${bundles?.uploaded ?? 0} uploaded, ${bundles?.unverified ?? 0} not verified).`,
        passed: (bundles?.uploaded ?? 0) > 0 && (bundles?.unverified ?? 0) === 0,
      },
    ]);
  });

  // ── Diagnostic bundles (device) ─────────────────────────────────────────────────────────

  app.post("/api/v1/sync/diagnostic-bundles", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation!;
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const parsed = CreateBundleBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;
    // The store must be usable before a bundle is recorded (no pending row for an upload that
    // cannot happen).
    try {
      await media.assertBucket();
    } catch (err) {
      sendObjectStoreError(res, "diagnostic_bundle_declare_failed", err, { tenant_id: act.tenantId });
      return;
    }
    const bundleId = newId("bundle");
    // Not under {env}/media/: device media keys and bundle keys never overlap.
    const objectKey = `${media.config.deploymentEnv}/support/${act.tenantId}/${bundleId}`;
    await db.tx(async () => {
      await db.run(
        `INSERT INTO diagnostic_bundles
           (bundle_id, created_at_rfc3339, redaction_profile, tenant_id, machine_fingerprint, app_version, status,
            object_key, byte_size, content_sha256, requested_ticket_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_upload', ?, ?, ?, ?)`,
        bundleId,
        new Date().toISOString(),
        input.redaction_profile,
        act.tenantId,
        act.machineFingerprint,
        input.app_version,
        objectKey,
        input.byte_size,
        input.content_sha256,
        input.ticket ? JSON.stringify(input.ticket) : null,
      );
      for (const a of input.artifacts) {
        await db.run(
          "INSERT INTO diagnostic_bundle_artifacts (bundle_id, logical_path, sha256, kind) VALUES (?, ?, ?, ?)",
          bundleId,
          a.logical_path,
          a.sha256,
          a.kind,
        );
      }
    });
    const upload = await media.presignPut(objectKey);
    structuredLog("diagnostic_bundle_declared", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      bundle_id: bundleId,
      byte_size: input.byte_size,
    });
    res.status(201).json({ bundle_id: bundleId, upload });
  });

  app.post("/api/v1/sync/diagnostic-bundles/:bundleId/complete", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation!;
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const bundle = await db.get<BundleRow>(
      `SELECT ${BUNDLE_COLUMNS} FROM diagnostic_bundles WHERE bundle_id = ? AND machine_fingerprint = ?`,
      req.params.bundleId,
      act.machineFingerprint,
    );
    if (!bundle) {
      res.status(404).json({ error: "bundle_not_found" });
      return;
    }
    if (bundle.status === "uploaded") {
      res.json({ bundle_id: bundle.bundle_id, status: bundle.status, ticket_id: bundle.ticket_id });
      return;
    }
    if (bundle.status !== "pending_upload" || !bundle.object_key) {
      res.status(409).json({ error: "bundle_not_pending", status: bundle.status });
      return;
    }
    let digest: { byteSize: number; sha256: string } | null;
    try {
      digest = await media.readObjectDigest(bundle.object_key, DIAGNOSTIC_BUNDLE_MAX_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "object_too_large") digest = { byteSize: DIAGNOSTIC_BUNDLE_MAX_BYTES + 1, sha256: "" };
      else {
        sendObjectStoreError(res, "diagnostic_bundle_complete_failed", err, { bundle_id: bundle.bundle_id });
        return;
      }
    }
    if (!digest) {
      res.status(409).json({ error: "bundle_not_uploaded", message: "No object was uploaded to the presigned URL." });
      return;
    }
    if (digest.byteSize !== bundle.byte_size || digest.sha256 !== bundle.content_sha256) {
      const reason = `uploaded object is ${digest.byteSize} bytes / sha256 ${digest.sha256 || "n/a"}, declared ${bundle.byte_size} / ${bundle.content_sha256}`;
      await db.run("UPDATE diagnostic_bundles SET status = 'rejected', rejection_reason = ? WHERE bundle_id = ?", reason, bundle.bundle_id);
      res.status(422).json({ error: "bundle_verification_failed", message: reason });
      return;
    }
    const nowIso = new Date().toISOString();
    const ticketId = await db.tx(async () => {
      let opened: string | null = null;
      if (bundle.requested_ticket_json) {
        const ticket = DeviceTicketRequest.parse(JSON.parse(bundle.requested_ticket_json));
        opened = newId("sup");
        await db.run(
          `INSERT INTO support_tickets
             (ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
              linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339, summary, origin, created_by)
           VALUES (?, ?, 'new', ?, ?, NULL, ?, '[]', NULL, ?, ?, 'device', ?)`,
          opened,
          act.tenantId,
          ticket.severity,
          ticket.affected_module,
          bundle.app_version,
          nowIso,
          ticket.summary,
          `device:${act.machineFingerprint}`,
        );
      }
      await db.run(
        "UPDATE diagnostic_bundles SET status = 'uploaded', uploaded_at_rfc3339 = ?, ticket_id = ? WHERE bundle_id = ?",
        nowIso,
        opened,
        bundle.bundle_id,
      );
      return opened;
    });
    structuredLog("diagnostic_bundle_uploaded", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      bundle_id: bundle.bundle_id,
      ticket_id: ticketId,
    });
    res.json({ bundle_id: bundle.bundle_id, status: "uploaded", ticket_id: ticketId });
  });
}

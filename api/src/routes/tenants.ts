/**
 * Tenants: CRUD (delete purges the tenant's sync data), offline policy, machine activations list.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { parsePagination, sendValidationError } from "../app/http.js";
import { EditionIdSchema, ForceUpdateModeSchema } from "../app/schemas.js";
import { newId, structuredLog } from "../app/runtime.js";
import { editionExists } from "../edition-catalog-store.js";
import { purgeTenantSyncData } from "../sync/index.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

const CreateTenantBody = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
  display_name: z.string().min(2).max(128),
  force_min_app_version: z.string().trim().min(1).max(32).optional().nullable(),
  force_update_mode: ForceUpdateModeSchema.optional(),
  force_update_reason: z.string().trim().min(2).max(512).optional().nullable(),
  rollout_cohort: z.string().trim().min(2).max(64).optional(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  edition: EditionIdSchema.optional(),
  offline_grace_hours: z.number().int().min(1).max(720).optional(),
  trust_revocation_disconnects_immediately: z.boolean().optional(),
  reconnect_requires_fresh_heartbeat: z.boolean().optional(),
}).strict();

const UpdateTenantBody = z
  .object({
    slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).optional(),
    display_name: z.string().min(2).max(128).optional(),
    rollout_cohort: z.string().trim().min(2).max(64).optional(),
    update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
    edition: EditionIdSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

/** Typed confirmation: the operator retypes the slug of the tenant being deleted. */
const SuspendTenantBody = z.object({ reason: z.string().trim().min(4).max(512) }).strict();

const DeleteTenantBody = z.object({ confirm_slug: z.string().min(1).max(64) }).strict();

const OfflinePolicyUpdateBody = z.object({
  offline_grace_hours: z.number().int().min(1).max(720),
  trust_revocation_disconnects_immediately: z.boolean(),
  reconnect_requires_fresh_heartbeat: z.boolean(),
}).strict();

export function registerTenantsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction, insertTenantRow, updateTenantRow, tenantWriteFailure } = ctx;

  app.get("/api/v1/tenants", authMiddleware, async (req, res) => {
    const { cursor, limit, withPagination } = parsePagination(req.query);
    const effectiveLimit = withPagination ? limit : 10_000;
    const pageSize = effectiveLimit + 1;
    let rows: Array<Record<string, unknown>>;
    if (cursor) {
      const [cursorCreatedAt, cursorId] = cursor.split("|");
      rows = await db.all(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                  COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
                  offline_grace_hours, trust_revocation_disconnects_immediately,
                  reconnect_requires_fresh_heartbeat, is_initialized, has_demo_data, is_active, suspended_at, suspended_reason, created_at
           FROM tenants
           WHERE (created_at < ?) OR (created_at = ? AND id < ?)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`, cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
    } else {
      rows = await db.all(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                  COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
                  offline_grace_hours, trust_revocation_disconnects_immediately,
                  reconnect_requires_fresh_heartbeat, is_initialized, has_demo_data, is_active, suspended_at, suspended_reason, created_at
           FROM tenants
           ORDER BY created_at DESC, id DESC
           LIMIT ?`, pageSize) as Array<Record<string, unknown>>;
    }
    const items = rows.slice(0, effectiveLimit);
    const hasMore = rows.length > effectiveLimit;
    const nextCursor = hasMore
      ? `${String(items[items.length - 1]?.created_at ?? "")}|${String(items[items.length - 1]?.id ?? "")}`
      : null;
    if (withPagination) {
      res.json({ items, next_cursor: nextCursor, limit: effectiveLimit });
      return;
    }
    res.json(items);
  });

  app.post("/api/v1/tenants", authMiddleware, async (req, res) => {
    const parsed = CreateTenantBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const input = parsed.data;
      const id = newId("tenant");
      const edition = (input.edition?.trim() || "core");
      if (!await editionExists(db, edition)) {
        return { status: 400, body: { error: "edition_not_found", message: `Edition '${edition}' not found` } };
      }
      try {
        await insertTenantRow({
          id,
          slug: input.slug,
          display_name: input.display_name,
          force_min_app_version: input.force_min_app_version ?? null,
          force_update_mode: input.force_update_mode ?? "inherit",
          force_update_reason: input.force_update_reason ?? null,
          rollout_cohort: input.rollout_cohort ?? "stable-main",
          update_channel: input.update_channel ?? "stable",
          edition,
          offline_grace_hours: input.offline_grace_hours ?? 72,
          trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately ?? false,
          reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat ?? true,
        });
      } catch (err) {
        return tenantWriteFailure(err);
      }
      return {
        status: 201,
        body: {
          id,
          slug: input.slug,
          display_name: input.display_name,
          force_min_app_version: input.force_min_app_version ?? null,
          force_update_mode: input.force_update_mode ?? "inherit",
          force_update_reason: input.force_update_reason ?? null,
          rollout_cohort: input.rollout_cohort ?? "stable-main",
          update_channel: input.update_channel ?? "stable",
          edition,
          entitlement_lineage: 0,
          offline_grace_hours: input.offline_grace_hours ?? 72,
          trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately ?? false,
          reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat ?? true,
          is_initialized: false,
          has_demo_data: false,
        },
      };
    });
  });

  app.patch("/api/v1/tenants/:tenantId", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const parsed = UpdateTenantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const row = await db.get(`SELECT id, slug, display_name, rollout_cohort, update_channel,
                COALESCE(edition, 'core') AS edition
         FROM tenants WHERE id = ?`, tenantId) as
      | {
          id: string;
          slug: string;
          display_name: string;
          rollout_cohort: string;
          update_channel: string;
          edition: string;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    const input = parsed.data;
    const nextSlug = input.slug ?? row.slug;
    const nextDisplay = input.display_name ?? row.display_name;
    const nextCohort = input.rollout_cohort ?? row.rollout_cohort;
    const nextChannel = input.update_channel ?? row.update_channel;
    const prevEdition = row.edition || "core";
    const nextEdition = input.edition != null ? input.edition.trim() : prevEdition;
    if (!await editionExists(db, nextEdition)) {
      res.status(400).json({ error: "edition_not_found", message: `Edition '${nextEdition}' not found` });
      return;
    }
    const editionChanged = nextEdition !== prevEdition;
    try {
      await updateTenantRow(tenantId, {
        slug: nextSlug,
        display_name: nextDisplay,
        rollout_cohort: nextCohort,
        update_channel: nextChannel,
        edition: nextEdition,
        bumpEntitlementLineage: editionChanged,
      });
    } catch (err) {
      const failure = tenantWriteFailure(err);
      res.status(failure.status).json(failure.body);
      return;
    }
    const out = await db.get(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
                offline_grace_hours, trust_revocation_disconnects_immediately, reconnect_requires_fresh_heartbeat, is_active, suspended_at, suspended_reason, created_at
         FROM tenants WHERE id = ?`, tenantId) as Record<string, unknown>;
    res.json(out);
  });

  /**
   * Irreversible: deletes the tenant, its licences, activations, tickets and every synchronised row.
   * Needs the tenant's slug retyped (`confirm_slug`), a reason and a `tenant_delete` step-up; audited.
   */
  app.delete("/api/v1/tenants/:tenantId", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const parsed = DeleteTenantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const exists = await db.get(`SELECT id, slug FROM tenants WHERE id = ?`, tenantId) as { id: string; slug: string } | undefined;
    if (!exists) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    if (parsed.data.confirm_slug !== exists.slug) {
      res.status(400).json({ error: "confirmation_mismatch", message: "confirm_slug must equal the tenant's slug." });
      return;
    }
    const guard = await requirePrivilegedAction(req, {
      action_code: "tenant_delete",
      action_category: "tenant",
      step_up_kind: StepUpKinds.tenantDelete,
      scope_tenant_id: tenantId,
      entity_refs: { tenant_id: tenantId },
      payload: { slug: exists.slug },
    });
    if (!guard.ok) {
      res.status(guard.status).json(guard.body);
      return;
    }
    let syncRowsDeleted: Record<string, number>;
    try {
      syncRowsDeleted = await db.tx(async () => {
        await db.run(
          `DELETE FROM support_ticket_interventions WHERE ticket_id IN (SELECT ticket_id FROM support_tickets WHERE tenant_id = ?)`,
          tenantId,
        );
        await db.run(`DELETE FROM support_tickets WHERE tenant_id = ?`, tenantId);
        await db.run(`DELETE FROM machine_activations WHERE tenant_id = ?`, tenantId);
        await db.run(`DELETE FROM license_keys WHERE tenant_id = ?`, tenantId);
        await db.run(`DELETE FROM tenant_update_policy_history WHERE tenant_id = ?`, tenantId);
        // Every sync table (v1 log/cursors and v2 state/checkpoints), under the tenant sync lock.
        const purged = await purgeTenantSyncData(db, tenantId);
        await db.run(`DELETE FROM tenants WHERE id = ?`, tenantId);
        return purged;
      });
    } catch (err) {
      res.status(500).json({ error: "tenant_delete_failed", message: String(err) });
      return;
    }
    structuredLog("tenant_deleted", { tenant_id: tenantId, sync_rows_deleted: syncRowsDeleted });
    res.status(204).send();
  });

  app.get("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const row = await db.get(`SELECT id, offline_grace_hours, trust_revocation_disconnects_immediately,
                reconnect_requires_fresh_heartbeat
         FROM tenants WHERE id = ?`, tenantId) as
      | {
          id: string;
          offline_grace_hours: number;
          trust_revocation_disconnects_immediately: number;
          reconnect_requires_fresh_heartbeat: number;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    res.json({
      tenant_id: tenantId,
      grace_hours: row.offline_grace_hours,
      trust_revocation_disconnects_immediately: row.trust_revocation_disconnects_immediately === 1,
      reconnect_requires_fresh_heartbeat: row.reconnect_requires_fresh_heartbeat === 1,
    });
  });

  app.put("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const parsed = OfflinePolicyUpdateBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const guard = await requirePrivilegedAction(req, {
        action_code: "offline_policy_update",
        step_up_kind: StepUpKinds.offlinePolicyChange,
        action_category: "platform_override",
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId },
        payload: parsed.data,
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      const tenant = await db.get("SELECT id FROM tenants WHERE id = ?", tenantId) as { id: string } | undefined;
      if (!tenant) {
        return { status: 404, body: { error: "tenant_not_found" } };
      }
      const input = parsed.data;
      await db.run(`UPDATE tenants
         SET offline_grace_hours = ?,
             trust_revocation_disconnects_immediately = ?,
             reconnect_requires_fresh_heartbeat = ?
         WHERE id = ?`, input.offline_grace_hours,
        input.trust_revocation_disconnects_immediately ? 1 : 0,
        input.reconnect_requires_fresh_heartbeat ? 1 : 0,
        tenantId);
      return {
        status: 200,
        body: {
          tenant_id: tenantId,
          grace_hours: input.offline_grace_hours,
          trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately,
          reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  app.get("/api/v1/tenants/:tenantId/activations", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const { cursor, limit, withPagination } = parsePagination(req.query);
    const effectiveLimit = withPagination ? limit : 10_000;
    const rows = await db.all(`SELECT a.machine_fingerprint, a.last_seen_at, a.app_version, a.revoked_at, a.revocation_kind,
                a.policy_refresh_requested_at, l.update_channel
         FROM machine_activations a
         JOIN license_keys l ON l.id = a.license_id
         WHERE a.tenant_id = ?
         ORDER BY a.last_seen_at COLLATE "C" DESC, a.machine_fingerprint COLLATE "C" DESC`, tenantId) as Array<{
        machine_fingerprint: string;
        last_seen_at: string;
        app_version: string | null;
        policy_refresh_requested_at: string | null;
        revoked_at: string | null;
        revocation_kind: string | null;
        update_channel: string;
      }>;
    // The cursor is compared in JS (binary); the ORDER BY uses the binary "C" collation to match.
    const filtered = cursor
      ? rows.filter((row) => {
          const [cursorLastSeenAt, cursorMachineId] = cursor.split("|");
          if (row.last_seen_at < cursorLastSeenAt) return true;
          if (row.last_seen_at > cursorLastSeenAt) return false;
          return row.machine_fingerprint < (cursorMachineId ?? "");
        })
      : rows;
    const pagedRows = filtered.slice(0, effectiveLimit + 1);
    const nowMs = Date.now();
    const mapped = pagedRows.slice(0, effectiveLimit).map((row) => {
      const ageMs = nowMs - new Date(row.last_seen_at).getTime();
      const heartbeat_freshness = Number.isFinite(ageMs) && ageMs <= 15 * 60_000 ? "live" : "stale";
      return {
        machine_id: row.machine_fingerprint,
        tenant_id: tenantId,
        last_heartbeat_rfc3339: row.last_seen_at,
        app_version: row.app_version,
        trusted_device: row.revoked_at == null,
        // 'machine' = revoked by an operator (reinstatable), 'license' = licence revoked,
        // 'released' = slot freed by an operator (the device may activate again), null = active.
        revocation_kind: row.revoked_at ? (row.revocation_kind ?? "license") : null,
        policy_refresh_requested_at: row.policy_refresh_requested_at,
        activation_source: "license_claim",
        anomaly_flags: row.revoked_at ? ["revoked"] : [],
        heartbeat_freshness,
        update_channel: row.update_channel,
      };
    });
    if (withPagination) {
      const hasMore = pagedRows.length > effectiveLimit;
      const last = mapped[mapped.length - 1];
      res.json({
        items: mapped,
        next_cursor: hasMore && last ? `${last.last_heartbeat_rfc3339 ?? ""}|${last.machine_id}` : null,
        limit: effectiveLimit,
      });
      return;
    }
    res.json(mapped);
  });

  /**
   * Soft suspension (unpaid invoice, contract dispute...): every device of the tenant is refused
   * (403 tenant_inactive) from its next request; licences, activations and data are kept.
   * Reversed by /resume. Step-up `entitlement_suspension`, audited.
   */
  app.post("/api/v1/tenants/:tenantId/suspend", authMiddleware, async (req, res) => {
    const parsed = SuspendTenantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const tenantId = req.params.tenantId;
    await runIdempotent(req, res, async () => {
      const tenant = await db.get<{ id: string; is_active: number; suspended_at: string | null }>(
        "SELECT id, is_active, suspended_at FROM tenants WHERE id = ? FOR UPDATE",
        tenantId,
      );
      if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
      if (tenant.is_active !== 1) return { status: 409, body: { error: "tenant_already_suspended", suspended_at: tenant.suspended_at } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_suspend",
        action_category: "tenant",
        step_up_kind: StepUpKinds.entitlementSuspension,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId },
        payload: { reason: parsed.data.reason },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const now = new Date().toISOString();
      await db.run(
        "UPDATE tenants SET is_active = 0, suspended_at = ?, suspended_reason = ? WHERE id = ?",
        now,
        parsed.data.reason,
        tenantId,
      );
      structuredLog("tenant_suspended", { tenant_id: tenantId });
      return { status: 200, body: { ok: true, suspended_at: now, audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Lifts a soft suspension. Desktops stopped syncing when they were refused and resume only with a
   * new token, so every active device is asked for a policy refresh (it gets one at its next
   * licence check). Step-up `tenant_restore`, audited.
   */
  app.post("/api/v1/tenants/:tenantId/resume", authMiddleware, async (req, res) => {
    const parsed = SuspendTenantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const tenantId = req.params.tenantId;
    await runIdempotent(req, res, async () => {
      const tenant = await db.get<{ id: string; is_active: number; suspended_at: string | null }>(
        "SELECT id, is_active, suspended_at FROM tenants WHERE id = ? FOR UPDATE",
        tenantId,
      );
      if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
      if (tenant.is_active === 1) return { status: 409, body: { error: "tenant_not_suspended" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_resume",
        action_category: "tenant",
        step_up_kind: StepUpKinds.tenantRestore,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId },
        payload: { reason: parsed.data.reason, suspended_at: tenant.suspended_at },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const now = new Date().toISOString();
      await db.run("UPDATE tenants SET is_active = 1, suspended_at = NULL, suspended_reason = NULL WHERE id = ?", tenantId);
      const flagged = await db.run(
        "UPDATE machine_activations SET policy_refresh_requested_at = ? WHERE tenant_id = ? AND revoked_at IS NULL",
        now,
        tenantId,
      );
      structuredLog("tenant_resumed", { tenant_id: tenantId, devices_asked_to_refresh: flagged.changes });
      return {
        status: 200,
        body: { ok: true, resumed_at: now, devices_asked_to_refresh: flagged.changes, audit_record_id: guard.auditRecordId },
      };
    });
  });
}

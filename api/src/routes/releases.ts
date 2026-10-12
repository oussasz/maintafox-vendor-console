/**
 * Release governance: forced-update policies per tenant and per channel/cohort, with rollback.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { resolveActorId, sendValidationError } from "../app/http.js";
import { CohortForceUpdateModeSchema, ForceUpdateModeSchema } from "../app/schemas.js";
import { newId, type ForceUpdateMode } from "../app/runtime.js";

const UpdatePolicyBody = z
  .object({
    force_min_app_version: z.string().trim().min(1).max(32).nullable().optional(),
    force_update_mode: CohortForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

const TenantUpdatePolicyBody = z
  .object({
    force_min_app_version: z.string().trim().min(1).max(32).nullable().optional(),
    force_update_mode: ForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

export function registerReleasesRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction } = ctx;

  app.get("/api/v1/tenants/:tenantId/update-policy", authMiddleware, async (req, res) => {
    const row = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
         FROM tenants
         WHERE id = ?`, req.params.tenantId) as
      | {
          tenant_id: string;
          update_channel: string;
          rollout_cohort: string;
          force_min_app_version: string | null;
          force_update_mode: ForceUpdateMode;
          force_update_reason: string | null;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    res.json(row);
  });

  app.put("/api/v1/tenants/:tenantId/update-policy", authMiddleware, async (req, res) => {
    const parsed = TenantUpdatePolicyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const current = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
           FROM tenants
           WHERE id = ?`, req.params.tenantId) as
        | {
            tenant_id: string;
            update_channel: string;
            rollout_cohort: string;
            force_min_app_version: string | null;
            force_update_mode: ForceUpdateMode;
            force_update_reason: string | null;
          }
        | undefined;
      if (!current) {
        return { status: 404, body: { error: "tenant_not_found" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_update_policy_set",
        action_category: "rollout_intervention",
        scope_tenant_id: current.tenant_id,
        entity_refs: { tenant_id: current.tenant_id },
        payload: {
          tenant_id: current.tenant_id,
          previous: {
            force_min_app_version: current.force_min_app_version,
            force_update_mode: current.force_update_mode,
            force_update_reason: current.force_update_reason,
          },
          next: parsed.data,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(`INSERT INTO tenant_update_policy_history
         (id, tenant_id, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
          changed_at_rfc3339, changed_by_actor_id, reason_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("tph"),
        current.tenant_id,
        current.force_min_app_version,
        current.force_update_mode,
        current.force_update_reason,
        new Date().toISOString(),
        resolveActorId(req),
        guard.reasonCode);
      const nextMinVersion = parsed.data.force_min_app_version ?? current.force_min_app_version;
      const nextMode = parsed.data.force_update_mode ?? current.force_update_mode;
      const nextReason = parsed.data.force_update_reason ?? current.force_update_reason;
      await db.run(`UPDATE tenants
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
         WHERE id = ?`, nextMinVersion, nextMode, nextReason, current.tenant_id);
      return {
        status: 200,
        body: {
          tenant_id: current.tenant_id,
          update_channel: current.update_channel,
          rollout_cohort: current.rollout_cohort,
          force_min_app_version: nextMinVersion,
          force_update_mode: nextMode,
          force_update_reason: nextReason,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  app.post("/api/v1/tenants/:tenantId/update-policy/rollback", authMiddleware, async (req, res) => {
    await runIdempotent(req, res, async () => {
      const current = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
           FROM tenants
           WHERE id = ?`, req.params.tenantId) as
        | {
            tenant_id: string;
            update_channel: string;
            rollout_cohort: string;
            force_min_app_version: string | null;
            force_update_mode: ForceUpdateMode;
            force_update_reason: string | null;
          }
        | undefined;
      if (!current) {
        return { status: 404, body: { error: "tenant_not_found" } };
      }
      const previous = await db.get(`SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
           FROM tenant_update_policy_history
           WHERE tenant_id = ?
           ORDER BY changed_at_rfc3339 DESC
           LIMIT 1`, current.tenant_id) as
        | {
            previous_force_min_app_version: string | null;
            previous_force_update_mode: ForceUpdateMode;
            previous_force_update_reason: string | null;
          }
        | undefined;
      if (!previous) {
        return { status: 409, body: { error: "no_policy_history" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_update_policy_rollback",
        action_category: "rollout_intervention",
        scope_tenant_id: current.tenant_id,
        entity_refs: { tenant_id: current.tenant_id },
        payload: { rollback_to_previous: true },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(`UPDATE tenants
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
         WHERE id = ?`, previous.previous_force_min_app_version,
        previous.previous_force_update_mode,
        previous.previous_force_update_reason,
        current.tenant_id);
      return {
        status: 200,
        body: {
          tenant_id: current.tenant_id,
          update_channel: current.update_channel,
          rollout_cohort: current.rollout_cohort,
          force_min_app_version: previous.previous_force_min_app_version,
          force_update_mode: previous.previous_force_update_mode,
          force_update_reason: previous.previous_force_update_reason,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  app.get("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, async (req, res) => {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!["stable", "pilot", "internal"].includes(channel)) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    const row = await db.get(`SELECT channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
         FROM cohort_update_policies
         WHERE channel = ? AND cohort_label = ?`, channel, cohort) as
      | {
          channel: string;
          cohort_label: string;
          force_min_app_version: string | null;
          force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          force_update_reason: string | null;
        }
      | undefined;
    if (!row) {
      res.json({
        channel,
        cohort_label: cohort,
        force_min_app_version: null,
        force_update_mode: "off",
        force_update_reason: null,
      });
      return;
    }
    res.json(row);
  });

  app.put("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, async (req, res) => {
    const parsed = UpdatePolicyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const channel = req.params.channel;
      const cohort = req.params.cohort;
      if (!["stable", "pilot", "internal"].includes(channel)) {
        return { status: 400, body: { error: "invalid_channel" } };
      }
      const current = await db.get(`SELECT id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
           FROM cohort_update_policies
           WHERE channel = ? AND cohort_label = ?`, channel, cohort) as
        | {
            id: string;
            channel: string;
            cohort_label: string;
            force_min_app_version: string | null;
            force_update_mode: Exclude<ForceUpdateMode, "inherit">;
            force_update_reason: string | null;
          }
        | undefined;
      const guard = await requirePrivilegedAction(req, {
        action_code: "cohort_update_policy_set",
        action_category: "rollout_intervention",
        entity_refs: { release_id: `${channel}:${cohort}` },
        payload: {
          channel,
          cohort_label: cohort,
          previous: current ?? null,
          next: parsed.data,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const prevMin = current?.force_min_app_version ?? null;
      const prevMode = current?.force_update_mode ?? "off";
      const prevReason = current?.force_update_reason ?? null;
      await db.run(`INSERT INTO cohort_update_policy_history
         (id, channel, cohort_label, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
          changed_at_rfc3339, changed_by_actor_id, reason_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId("cph"),
        channel,
        cohort,
        prevMin,
        prevMode,
        prevReason,
        new Date().toISOString(),
        resolveActorId(req),
        guard.reasonCode);
      const nextMinVersion = parsed.data.force_min_app_version ?? prevMin;
      const nextMode = parsed.data.force_update_mode ?? prevMode;
      const nextReason = parsed.data.force_update_reason ?? prevReason;
      if (current) {
        await db.run(`UPDATE cohort_update_policies
           SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
               updated_at_rfc3339 = ?, updated_by_actor_id = ?
           WHERE id = ?`, nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req), current.id);
      } else {
        await db.run(`INSERT INTO cohort_update_policies
           (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("cup"), channel, cohort, nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req));
      }
      return {
        status: 200,
        body: {
          channel,
          cohort_label: cohort,
          force_min_app_version: nextMinVersion,
          force_update_mode: nextMode,
          force_update_reason: nextReason,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  app.post("/api/v1/cohorts/:channel/:cohort/update-policy/rollback", authMiddleware, async (req, res) => {
    await runIdempotent(req, res, async () => {
      const channel = req.params.channel;
      const cohort = req.params.cohort;
      if (!["stable", "pilot", "internal"].includes(channel)) {
        return { status: 400, body: { error: "invalid_channel" } };
      }
      const previous = await db.get(`SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
           FROM cohort_update_policy_history
           WHERE channel = ? AND cohort_label = ?
           ORDER BY changed_at_rfc3339 DESC
           LIMIT 1`, channel, cohort) as
        | {
            previous_force_min_app_version: string | null;
            previous_force_update_mode: Exclude<ForceUpdateMode, "inherit">;
            previous_force_update_reason: string | null;
          }
        | undefined;
      if (!previous) {
        return { status: 409, body: { error: "no_policy_history" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "cohort_update_policy_rollback",
        action_category: "rollout_intervention",
        entity_refs: { release_id: `${channel}:${cohort}` },
        payload: { rollback_to_previous: true },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const existing = await db.get("SELECT id FROM cohort_update_policies WHERE channel = ? AND cohort_label = ?", channel, cohort) as { id: string } | undefined;
      if (existing) {
        await db.run(`UPDATE cohort_update_policies
           SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
               updated_at_rfc3339 = ?, updated_by_actor_id = ?
           WHERE id = ?`, previous.previous_force_min_app_version,
          previous.previous_force_update_mode,
          previous.previous_force_update_reason,
          new Date().toISOString(),
          resolveActorId(req),
          existing.id);
      } else {
        await db.run(`INSERT INTO cohort_update_policies
           (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("cup"),
          channel,
          cohort,
          previous.previous_force_min_app_version,
          previous.previous_force_update_mode,
          previous.previous_force_update_reason,
          new Date().toISOString(),
          resolveActorId(req));
      }
      return {
        status: 200,
        body: {
          channel,
          cohort_label: cohort,
          force_min_app_version: previous.previous_force_min_app_version,
          force_update_mode: previous.previous_force_update_mode,
          force_update_reason: previous.previous_force_update_reason,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });
}

/**
 * Release governance: forced-update policies per tenant and per channel/cohort, with rollback.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { resolveActorId, sendValidationError } from "../app/http.js";
import { CohortForceUpdateModeSchema, ForceMinAppVersionSchema, ForceUpdateModeSchema } from "../app/schemas.js";
import { newId, type ForceUpdateMode } from "../app/runtime.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

const UpdatePolicyBody = z
  .object({
    force_min_app_version: ForceMinAppVersionSchema.nullable().optional(),
    force_update_mode: CohortForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

const TenantUpdatePolicyBody = z
  .object({
    force_min_app_version: ForceMinAppVersionSchema.nullable().optional(),
    force_update_mode: ForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

/**
 * Removing the forced-update floor: the caller names the floor it saw (the one its confirmation
 * showed). Nothing else is accepted, so a stray force_min_app_version or flag is a 400.
 */
const ClearMinVersionBody = z
  .object({ expected_force_min_app_version: z.string().trim().min(1).max(32) })
  .strict();

/**
 * 409 when there is no floor to remove, when it is not the one the operator confirmed, or when the
 * policy's own mode is "required": under "required" a policy with no floor blocks every PC (fail
 * closed, app/force-update.ts), so the operator switches the mode first (the same reason the policy
 * PUT refuses a floor it cannot read).
 */
function floorRemovalRefusal(
  stored: string | null,
  mode: ForceUpdateMode,
  expected: string,
): { status: number; body: unknown } | null {
  if (stored === null || stored.trim() === "") return { status: 409, body: { error: "no_force_min_app_version" } };
  if (stored.trim() !== expected) {
    return { status: 409, body: { error: "force_min_app_version_changed", force_min_app_version: stored } };
  }
  if (mode === "required") return REQUIRED_NEEDS_FLOOR;
  return null;
}

/**
 * A policy may not end up "required" with no floor: that blocks every PC (fail closed). Checked
 * before the audit append so a refusal writes nothing.
 */
function requiredWithoutFloor(mode: ForceUpdateMode, floor: string | null): boolean {
  return mode === "required" && (floor === null || floor.trim() === "");
}
const REQUIRED_NEEDS_FLOOR = { status: 409, body: { error: "force_min_app_version_needed_by_required_mode" } } as const;

const UPDATE_CHANNELS = ["stable", "pilot", "internal"] as const;

const GovernanceBody = z.object({ reason: z.string().trim().min(4).max(512) }).strict();
const RecallBody = z
  .object({
    reason: z.string().trim().min(4).max(512),
    /** The app version withdrawn from the cohort (same bounds as force_min_app_version). */
    recalled_version: z.string().trim().min(1).max(32),
  })
  .strict();

type GovernanceState = "active" | "paused" | "recalled";

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
           WHERE id = ?
           FOR UPDATE`, req.params.tenantId) as
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
      const nextMinVersion = parsed.data.force_min_app_version ?? current.force_min_app_version;
      const nextMode = parsed.data.force_update_mode ?? current.force_update_mode;
      const nextReason = parsed.data.force_update_reason ?? current.force_update_reason;
      if (requiredWithoutFloor(nextMode, nextMinVersion)) return REQUIRED_NEEDS_FLOOR;
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_update_policy_set",
        step_up_kind: StepUpKinds.rolloutPublish,
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
           WHERE id = ?
           FOR UPDATE`, req.params.tenantId) as
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
        step_up_kind: StepUpKinds.forcedRollback,
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

  /**
   * Removes the forced-update floor (force_min_app_version) and nothing else. A dedicated route so
   * that the policy PUT keeps "missing / null = unchanged" and can never clear the floor by
   * accident; the caller must name the floor it is removing (409 when it differs from the stored
   * one). Same audit reason and step-up (rollout_publish) as setting a policy; the history row keeps
   * the old floor, so a rollback restores it.
   */
  app.post("/api/v1/tenants/:tenantId/update-policy/clear-min-version", authMiddleware, async (req, res) => {
    const parsed = ClearMinVersionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const current = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
           FROM tenants
           WHERE id = ?
           FOR UPDATE`, req.params.tenantId) as
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
      const refusal = floorRemovalRefusal(current.force_min_app_version, current.force_update_mode, parsed.data.expected_force_min_app_version);
      if (refusal) return refusal;
      const guard = await requirePrivilegedAction(req, {
        action_code: "tenant_update_policy_min_version_removed",
        step_up_kind: StepUpKinds.rolloutPublish,
        action_category: "rollout_intervention",
        scope_tenant_id: current.tenant_id,
        entity_refs: { tenant_id: current.tenant_id },
        payload: {
          tenant_id: current.tenant_id,
          floor_removed: true,
          removed_force_min_app_version: current.force_min_app_version,
          force_update_mode: current.force_update_mode,
          previous: {
            force_min_app_version: current.force_min_app_version,
            force_update_mode: current.force_update_mode,
            force_update_reason: current.force_update_reason,
          },
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
      await db.run(`UPDATE tenants SET force_min_app_version = NULL WHERE id = ?`, current.tenant_id);
      return {
        status: 200,
        body: {
          tenant_id: current.tenant_id,
          update_channel: current.update_channel,
          rollout_cohort: current.rollout_cohort,
          force_min_app_version: null,
          force_update_mode: current.force_update_mode,
          force_update_reason: current.force_update_reason,
          removed_force_min_app_version: current.force_min_app_version,
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
      await db.lockXact("cohort-update-policy", `${channel}:${cohort}`);
      const current = await db.get(`SELECT id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
           FROM cohort_update_policies
           WHERE channel = ? AND cohort_label = ?
           FOR UPDATE`, channel, cohort) as
        | {
            id: string;
            channel: string;
            cohort_label: string;
            force_min_app_version: string | null;
            force_update_mode: Exclude<ForceUpdateMode, "inherit">;
            force_update_reason: string | null;
          }
        | undefined;
      const prevMin = current?.force_min_app_version ?? null;
      const prevMode = current?.force_update_mode ?? "off";
      const prevReason = current?.force_update_reason ?? null;
      const nextMinVersion = parsed.data.force_min_app_version ?? prevMin;
      const nextMode = parsed.data.force_update_mode ?? prevMode;
      const nextReason = parsed.data.force_update_reason ?? prevReason;
      if (requiredWithoutFloor(nextMode, nextMinVersion)) return REQUIRED_NEEDS_FLOOR;
      const guard = await requirePrivilegedAction(req, {
        action_code: "cohort_update_policy_set",
        step_up_kind: StepUpKinds.rolloutPublish,
        action_category: "rollout_intervention",
        payload: {
          channel,
          cohort_label: cohort,
          previous: current ?? null,
          next: parsed.data,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
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
      await db.lockXact("cohort-update-policy", `${channel}:${cohort}`);
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
        step_up_kind: StepUpKinds.forcedRollback,
        action_category: "rollout_intervention",
        payload: { channel, cohort_label: cohort, rollback_to_previous: true },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const existing = await db.get("SELECT id FROM cohort_update_policies WHERE channel = ? AND cohort_label = ? FOR UPDATE", channel, cohort) as { id: string } | undefined;
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

  app.post("/api/v1/cohorts/:channel/:cohort/update-policy/clear-min-version", authMiddleware, async (req, res) => {
    const parsed = ClearMinVersionBody.safeParse(req.body ?? {});
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
      await db.lockXact("cohort-update-policy", `${channel}:${cohort}`);
      const current = await db.get(`SELECT id, force_min_app_version, force_update_mode, force_update_reason
           FROM cohort_update_policies
           WHERE channel = ? AND cohort_label = ?
           FOR UPDATE`, channel, cohort) as
        | {
            id: string;
            force_min_app_version: string | null;
            force_update_mode: Exclude<ForceUpdateMode, "inherit">;
            force_update_reason: string | null;
          }
        | undefined;
      const refusal = floorRemovalRefusal(current?.force_min_app_version ?? null, current?.force_update_mode ?? "off", parsed.data.expected_force_min_app_version);
      if (refusal) return refusal;
      if (!current) return { status: 409, body: { error: "no_force_min_app_version" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "cohort_update_policy_min_version_removed",
        step_up_kind: StepUpKinds.rolloutPublish,
        action_category: "rollout_intervention",
        entity_refs: { release_id: `${channel}:${cohort}` },
        payload: {
          channel,
          cohort_label: cohort,
          floor_removed: true,
          removed_force_min_app_version: current.force_min_app_version,
          force_update_mode: current.force_update_mode,
          previous: {
            force_min_app_version: current.force_min_app_version,
            force_update_mode: current.force_update_mode,
            force_update_reason: current.force_update_reason,
          },
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(`INSERT INTO cohort_update_policy_history
         (id, channel, cohort_label, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
          changed_at_rfc3339, changed_by_actor_id, reason_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId("cph"),
        channel,
        cohort,
        current.force_min_app_version,
        current.force_update_mode,
        current.force_update_reason,
        new Date().toISOString(),
        resolveActorId(req),
        guard.reasonCode);
      await db.run(`UPDATE cohort_update_policies
         SET force_min_app_version = NULL, updated_at_rfc3339 = ?, updated_by_actor_id = ?
         WHERE id = ?`, new Date().toISOString(), resolveActorId(req), current.id);
      return {
        status: 200,
        body: {
          channel,
          cohort_label: cohort,
          force_min_app_version: null,
          force_update_mode: current.force_update_mode,
          force_update_reason: current.force_update_reason,
          removed_force_min_app_version: current.force_min_app_version,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  /**
   * Rollout governance of one (channel, cohort): pause (stop offering updates), resume, recall (a
   * version is withdrawn). Persisted, audited, and delivered to the cohort's devices with their
   * policy (routes/activation.ts); the desktop updater (master plan Phase 5) acts on it — today's
   * desktops have no updater, so nothing changes on them yet. Pause/resume: step-up
   * `rollout_publish`; recall: `forced_rollback`.
   */
  async function setGovernance(
    req: express.Request,
    res: express.Response,
    next: { state: GovernanceState; reason: string; recalled_version: string | null },
  ): Promise<void> {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!(UPDATE_CHANNELS as readonly string[]).includes(channel)) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    await runIdempotent(req, res, async () => {
      await db.lockXact("rollout-governance", `${channel}:${cohort}`);
      const current = await db.get<{ state: GovernanceState; recalled_version: string | null }>(
        "SELECT state, recalled_version FROM rollout_cohort_governance WHERE channel = ? AND cohort_label = ?",
        channel,
        cohort,
      );
      const from = current?.state ?? "active";
      if (from === next.state && (current?.recalled_version ?? null) === next.recalled_version) {
        return { status: 409, body: { error: "governance_unchanged", state: from } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: `rollout_${next.state === "active" ? "resume" : next.state === "paused" ? "pause" : "recall"}`,
        action_category: "rollout",
        step_up_kind: next.state === "recalled" ? StepUpKinds.forcedRollback : StepUpKinds.rolloutPublish,
        payload: {
          channel,
          cohort_label: cohort,
          from_state: from,
          to_state: next.state,
          recalled_version: next.recalled_version,
          reason: next.reason,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO rollout_cohort_governance
           (channel, cohort_label, state, recalled_version, reason, changed_at, changed_by, audit_record_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel, cohort_label) DO UPDATE SET
           state = EXCLUDED.state, recalled_version = EXCLUDED.recalled_version, reason = EXCLUDED.reason,
           changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by, audit_record_id = EXCLUDED.audit_record_id`,
        channel,
        cohort,
        next.state,
        next.recalled_version,
        next.reason,
        now,
        resolveActorId(req),
        guard.auditRecordId,
      );
      return {
        status: 200,
        body: {
          channel,
          cohort_label: cohort,
          state: next.state,
          recalled_version: next.recalled_version,
          changed_at: now,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  }

  app.post("/api/v1/rollouts/:channel/:cohort/pause", authMiddleware, async (req, res) => {
    const parsed = GovernanceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await setGovernance(req, res, { state: "paused", reason: parsed.data.reason, recalled_version: null });
  });

  app.post("/api/v1/rollouts/:channel/:cohort/resume", authMiddleware, async (req, res) => {
    const parsed = GovernanceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await setGovernance(req, res, { state: "active", reason: parsed.data.reason, recalled_version: null });
  });

  app.post("/api/v1/rollouts/:channel/:cohort/recall", authMiddleware, async (req, res) => {
    const parsed = RecallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await setGovernance(req, res, {
      state: "recalled",
      reason: parsed.data.reason,
      recalled_version: parsed.data.recalled_version,
    });
  });
}

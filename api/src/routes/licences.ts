/**
 * Licences: issue, list, update, revoke; per-machine revoke / reinstate.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { PRIVILEGED_REASON_MIN_LENGTH } from "../app/config.js";
import { MaxMobileDevicesSchema, slotLimitFor, type DeviceClass } from "../app/device-class.js";
import { parsePagination, resolveActorId, sendValidationError } from "../app/http.js";
import { newId, randomLicenseKey, structuredLog } from "../app/runtime.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

const UpdateLicenseBody = z
  .object({
    max_machines: z.number().int().min(1).max(1000).optional(),
    // Phones of the mobile field app (migration 019); 0 = mobile not licensed.
    max_mobile_devices: MaxMobileDevicesSchema.optional(),
    expires_at: z.string().datetime().nullable().optional(),
    update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
    operator_rationale: z.string().trim().min(8).max(512).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

const CreateLicenseBody = z.object({
  tenant_id: z.string().min(3),
  max_machines: z.number().int().min(1).max(1000).default(1),
  // Phones of the mobile field app (migration 019). Omitted = 0 = mobile not licensed, the same as
  // the column default: how many phones a licence includes is set by the operator, never assumed.
  max_mobile_devices: MaxMobileDevicesSchema.default(0),
  expires_at: z.string().datetime().optional().nullable(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  operator_reason_code: z.string().trim().min(2).max(64).optional().nullable(),
  operator_rationale: z.string().trim().min(8).max(512).optional().nullable(),
}).strict();

const RevokeLicenseBody = z.object({
  reason: z.string().min(2).max(256).optional(),
}).strict();

const MachineActionBody = z.object({
  reason: z.string().min(2).max(256).optional(),
}).strict();

const RebindBody = z.object({
  /** Same bounds as the activation claim's machine_fingerprint. */
  new_machine_fingerprint: z.string().trim().min(8).max(256),
  reason: z.string().min(2).max(256).optional(),
}).strict();

type MachineActivationRow = {
  id: string;
  license_id: string;
  device_class: DeviceClass;
  revoked_at: string | null;
  revocation_kind: string | null;
};

export function registerLicencesRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction, appendAuditRecord, countActiveActivations } = ctx;

  app.post("/api/v1/licenses", authMiddleware, async (req, res) => {
    const parsed = CreateLicenseBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const input = parsed.data;
      const tenant = await db.get("SELECT id, display_name, force_min_app_version, update_channel, is_active FROM tenants WHERE id = ?", input.tenant_id) as
        | {
            id: string;
            display_name: string;
            force_min_app_version: string | null;
            update_channel: string;
            is_active: number;
          }
        | undefined;
      if (!tenant || tenant.is_active !== 1) {
        return { status: 404, body: { error: "tenant_not_found_or_inactive" } };
      }

      const id = newId("lic");
      const key = randomLicenseKey();
      const actor = Number.parseInt(String((req as express.Request & { userId?: string }).userId ?? "0"), 10) || null;
      await db.run(`INSERT INTO license_keys
          (id, tenant_id, license_key, max_machines, max_mobile_devices, update_channel, issued_by_user_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id,
        input.tenant_id,
        key,
        input.max_machines,
        input.max_mobile_devices,
        input.update_channel ?? tenant.update_channel,
        actor,
        input.expires_at ?? null);

      const auditRecordId = await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "license_issue",
        action_category: "entitlement",
        correlation_id: `lic-${newId("corr")}`,
        scope_tenant_id: input.tenant_id,
        reason_code: input.operator_reason_code ?? null,
        entity_refs: {
          tenant_id: input.tenant_id,
          entitlement_id: id,
        },
        payload: {
          update_channel: input.update_channel ?? tenant.update_channel,
          max_machines: input.max_machines,
          max_mobile_devices: input.max_mobile_devices,
          expires_at: input.expires_at ?? null,
          operator_rationale: input.operator_rationale ?? null,
        },
      });

      return {
        status: 201,
        body: {
          id,
          tenant_id: input.tenant_id,
          tenant_display_name: tenant.display_name,
          license_key: key,
          max_machines: input.max_machines,
          max_mobile_devices: input.max_mobile_devices,
          update_channel: input.update_channel ?? tenant.update_channel,
          expires_at: input.expires_at ?? null,
          revoked_at: null,
          audit_record_id: auditRecordId,
        },
      };
    });
  });

  app.get("/api/v1/tenants/:tenantId/licenses", authMiddleware, async (req, res) => {
    const tenantId = req.params.tenantId;
    const { cursor, limit, withPagination } = parsePagination(req.query);
    const effectiveLimit = withPagination ? limit : 10_000;
    const pageSize = effectiveLimit + 1;
    let rows: Array<Record<string, unknown>>;
    if (cursor) {
      const [cursorCreatedAt, cursorId] = cursor.split("|");
      rows = await db.all(`SELECT id, tenant_id, license_key, max_machines, max_mobile_devices, expires_at, revoked_at, revoked_reason, created_at, update_channel
           FROM license_keys
           WHERE tenant_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`, tenantId, cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
    } else {
      rows = await db.all(`SELECT id, tenant_id, license_key, max_machines, max_mobile_devices, expires_at, revoked_at, revoked_reason, created_at, update_channel
           FROM license_keys
           WHERE tenant_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`, tenantId, pageSize) as Array<Record<string, unknown>>;
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

  app.patch("/api/v1/licenses/:licenseId", authMiddleware, async (req, res) => {
    const licenseId = req.params.licenseId;
    const parsed = UpdateLicenseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const row = await db.get(`SELECT id, tenant_id, license_key, max_machines, max_mobile_devices, expires_at, revoked_at, revoked_reason, created_at, update_channel FROM license_keys WHERE id = ?`, licenseId) as
      | {
          id: string;
          tenant_id: string;
          license_key: string;
          max_machines: number;
          max_mobile_devices: number;
          expires_at: string | null;
          revoked_at: string | null;
          revoked_reason: string | null;
          created_at: string;
          update_channel: string;
        }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "license_not_found" });
      return;
    }
    if (row.revoked_at) {
      res.status(409).json({ error: "license_revoked", message: "Cannot update a revoked license key." });
      return;
    }
    const input = parsed.data;
    const nextMax = input.max_machines ?? row.max_machines;
    // Lowering a count below the devices already active evicts nobody (same rule as max_machines):
    // those devices keep working until a vendor operator revokes them one by one, and their next
    // policy refresh is refused when the count is 0. New claims respect the new count at once.
    const nextMaxMobile = input.max_mobile_devices ?? row.max_mobile_devices;
    const nextExpires =
      input.expires_at === undefined ? row.expires_at : input.expires_at === null ? null : input.expires_at;
    const nextChannel = input.update_channel ?? row.update_channel;
    await db.tx(async () => {
      await db.run(
        `UPDATE license_keys SET max_machines = ?, max_mobile_devices = ?, expires_at = ?, update_channel = ? WHERE id = ?`,
        nextMax,
        nextMaxMobile,
        nextExpires,
        nextChannel,
        licenseId,
      );
      // Term, slots (desktop and mobile) and channel are what the customer paid for: every change is
      // in the ledger.
      await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "license_update",
        action_category: "entitlement",
        correlation_id: newId("corr"),
        scope_tenant_id: row.tenant_id,
        reason_code: req.header("X-Operator-Reason")?.trim() || null,
        entity_refs: { tenant_id: row.tenant_id, entitlement_id: licenseId },
        payload: {
          from: {
            max_machines: row.max_machines,
            max_mobile_devices: row.max_mobile_devices,
            expires_at: row.expires_at,
            update_channel: row.update_channel,
          },
          to: { max_machines: nextMax, max_mobile_devices: nextMaxMobile, expires_at: nextExpires, update_channel: nextChannel },
          operator_rationale: input.operator_rationale ?? null,
        },
      });
    });
    const out = await db.get(`SELECT id, tenant_id, license_key, max_machines, max_mobile_devices, expires_at, revoked_at, revoked_reason, created_at, update_channel FROM license_keys WHERE id = ?`, licenseId) as Record<string, unknown>;
    res.json(out);
  });

  app.post("/api/v1/licenses/:licenseId/revoke", authMiddleware, async (req, res) => {
    const parsed = RevokeLicenseBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const guard = await requirePrivilegedAction(req, {
        action_code: "license_revoke",
        step_up_kind: StepUpKinds.entitlementSuspension,
        action_category: "entitlement",
        entity_refs: { entitlement_id: req.params.licenseId },
        payload: { reason: parsed.data.reason ?? "revoked by operator" },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      const licenseId = req.params.licenseId;
      const now = new Date().toISOString();
      await db.lockXact("license-slots", licenseId);
      const row = await db.get("SELECT id, revoked_at, tenant_id FROM license_keys WHERE id = ?", licenseId) as { id: string; revoked_at: string | null; tenant_id: string } | undefined;
      if (!row) {
        return { status: 404, body: { error: "license_not_found" } };
      }
      if (!row.revoked_at) {
        await db.run("UPDATE license_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?", now,
          parsed.data.reason ?? "revoked by operator",
          licenseId);
        await db.run("UPDATE machine_activations SET revoked_at = ?, revocation_kind = 'license' WHERE license_id = ? AND revoked_at IS NULL", now, licenseId);
      }
      return { status: 200, body: { ok: true, revoked_at: now, audit_record_id: guard.auditRecordId } };
    });
  });

  async function loadMachineActivation(tenantId: string, machineFingerprint: string): Promise<MachineActivationRow | undefined> {
    return await db.get(`SELECT id, license_id, revoked_at, revocation_kind, device_class
         FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`, tenantId, machineFingerprint) as MachineActivationRow | undefined;
  }

  /**
   * Revokes one device. Its next request (sync heartbeat, policy refresh) is refused with
   * `activation_revoked`, its slot is freed, and re-entering the licence key does not undo it.
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/revoke", authMiddleware, async (req, res) => {
    const parsed = MachineActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    await runIdempotent(req, res, async () => {
      const guard = await requirePrivilegedAction(req, {
        action_code: "machine_revoke",
        step_up_kind: StepUpKinds.machineTrustChange,
        action_category: "entitlement",
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, machine_id: machineFingerprint },
        payload: { reason: parsed.data.reason ?? "revoked by operator" },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      const row = await loadMachineActivation(tenantId, machineFingerprint);
      if (!row) {
        return { status: 404, body: { error: "activation_not_found" } };
      }
      if (row.revoked_at) {
        return {
          status: 200,
          body: { ok: true, revoked_at: row.revoked_at, revocation_kind: row.revocation_kind ?? "license", audit_record_id: guard.auditRecordId },
        };
      }
      const now = new Date().toISOString();
      await db.run("UPDATE machine_activations SET revoked_at = ?, revocation_kind = 'machine' WHERE id = ?", now, row.id);
      structuredLog("machine_activation_revoked", { tenant_id: tenantId, machine_fingerprint: machineFingerprint });
      return { status: 200, body: { ok: true, revoked_at: now, revocation_kind: "machine", audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Reinstates a device revoked with the route above. A device revoked because its licence was
   * revoked cannot be reinstated here (issue a new licence instead). Needs a free slot.
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/reinstate", authMiddleware, async (req, res) => {
    const parsed = MachineActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    await runIdempotent(req, res, async () => {
      const guard = await requirePrivilegedAction(req, {
        action_code: "machine_reinstate",
        step_up_kind: StepUpKinds.machineTrustChange,
        action_category: "entitlement",
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, machine_id: machineFingerprint },
        payload: { reason: parsed.data.reason ?? "reinstated by operator" },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      const row = await loadMachineActivation(tenantId, machineFingerprint);
      if (!row) {
        return { status: 404, body: { error: "activation_not_found" } };
      }
      if (!row.revoked_at) {
        return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
      }
      if (row.revocation_kind !== "machine") {
        return { status: 409, body: { error: "license_revoked", message: "The licence itself is revoked; issue a new licence." } };
      }
      const lic = await db.get("SELECT max_machines, max_mobile_devices, revoked_at FROM license_keys WHERE id = ?", row.license_id) as
        | { max_machines: number; max_mobile_devices: number; revoked_at: string | null }
        | undefined;
      if (!lic || lic.revoked_at) {
        return { status: 409, body: { error: "license_revoked" } };
      }
      // The device comes back on a slot of its own class.
      // 403 as on claim and policy refresh: the licence does not include phones (not a full pool).
      if (row.device_class === "mobile" && lic.max_mobile_devices <= 0) {
        return { status: 403, body: { error: "mobile_not_licensed", device_class: "mobile", max_mobile_devices: 0 } };
      }
      await db.lockXact("license-slots", row.license_id);
      const limit = slotLimitFor(lic, row.device_class);
      if (await countActiveActivations(row.license_id, row.device_class) >= limit) {
        return {
          status: 409,
          body: {
            error: "slot_limit_reached",
            device_class: row.device_class,
            limit,
            [row.device_class === "mobile" ? "max_mobile_devices" : "max_machines"]: limit,
          },
        };
      }
      await db.run("UPDATE machine_activations SET revoked_at = NULL, revocation_kind = NULL WHERE id = ?", row.id);
      structuredLog("machine_activation_reinstated", { tenant_id: tenantId, machine_fingerprint: machineFingerprint });
      return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Slot release: frees the device's slot (decommissioned or reinstalled machine). The device is
   * refused from its next request (`activation_revoked`) but, unlike a revocation, it may activate
   * again later with the licence key if a slot is free.
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/release", authMiddleware, async (req, res) => {
    const parsed = MachineActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    await runIdempotent(req, res, async () => {
      const row = await loadMachineActivation(tenantId, machineFingerprint);
      if (!row) {
        return { status: 404, body: { error: "activation_not_found" } };
      }
      if (row.revoked_at) {
        return { status: 409, body: { error: "slot_not_held", revocation_kind: row.revocation_kind } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "machine_slot_release",
        action_category: "entitlement",
        step_up_kind: StepUpKinds.machineTrustChange,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, entitlement_id: row.license_id, machine_id: machineFingerprint },
        payload: { reason: parsed.data.reason ?? "slot released by operator" },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      await db.lockXact("license-slots", row.license_id);
      const now = new Date().toISOString();
      await db.run("UPDATE machine_activations SET revoked_at = ?, revocation_kind = 'released' WHERE id = ?", now, row.id);
      structuredLog("machine_slot_released", { tenant_id: tenantId, machine_fingerprint: machineFingerprint });
      return {
        status: 200,
        body: {
          ok: true,
          released_at: now,
          device_class: row.device_class,
          active_slots: await countActiveActivations(row.license_id, row.device_class),
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  /**
   * Rebind: moves the device's slot to its replacement machine (new hardware, new fingerprint).
   * The old device is refused at once; the new one activates with the licence key and finds its
   * slot already held, even when the licence has no free slot.
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/rebind", authMiddleware, async (req, res) => {
    const parsed = RebindBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    const target = parsed.data.new_machine_fingerprint;
    if (target === machineFingerprint) {
      res.status(400).json({ error: "same_fingerprint" });
      return;
    }
    await runIdempotent(req, res, async () => {
      const row = await loadMachineActivation(tenantId, machineFingerprint);
      if (!row) {
        return { status: 404, body: { error: "activation_not_found" } };
      }
      if (row.revoked_at) {
        return { status: 409, body: { error: "slot_not_held", revocation_kind: row.revocation_kind } };
      }
      await db.lockXact("license-slots", row.license_id);
      await db.lockXact("activation-device", `${tenantId}:${target}`);
      const existing = await loadMachineActivation(tenantId, target);
      // A target that is active holds its own slot; an operator-revoked one stays revoked. A target
      // that only released its slot (or lost it with a licence revocation) gives way to the rebind.
      if (existing && (existing.revoked_at === null || existing.revocation_kind === "machine")) {
        return { status: 409, body: { error: "target_fingerprint_in_use", revocation_kind: existing.revocation_kind } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "machine_rebind",
        action_category: "entitlement",
        step_up_kind: StepUpKinds.machineTrustChange,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, entitlement_id: row.license_id, machine_id: machineFingerprint },
        payload: {
          reason: parsed.data.reason ?? "rebound by operator",
          from_machine_fingerprint: machineFingerprint,
          to_machine_fingerprint: target,
        },
      });
      if (!guard.ok) {
        return { status: guard.status, body: guard.body };
      }
      if (existing) {
        await db.run("DELETE FROM machine_activations WHERE id = ?", existing.id);
      }
      // The stored token no longer matches any bearer (a JWT never equals this value), so the old
      // device is refused; the new device's claim replaces it with its own token.
      await db.run(
        `UPDATE machine_activations
         SET machine_fingerprint = ?, activation_token = ?, policy_refresh_requested_at = NULL
         WHERE id = ?`,
        target,
        `rebound:${guard.auditRecordId}`,
        row.id,
      );
      structuredLog("machine_rebound", { tenant_id: tenantId, from: machineFingerprint, to: target });
      return { status: 200, body: { ok: true, machine_fingerprint: target, audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Policy refresh: the device fetches its licence, edition and policies now instead of at its next
   * scheduled check. Its sync requests are refused (401 policy_refresh_required) until it calls
   * POST /activation/policy-refresh, which renews its token; the desktop then resumes syncing.
   * Not dangerous (no step-up), but audited with a reason.
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/policy-refresh", authMiddleware, async (req, res) => {
    const parsed = MachineActionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const reason = req.header("X-Operator-Reason")?.trim() ?? "";
    if (reason.length < PRIVILEGED_REASON_MIN_LENGTH) {
      res.status(400).json({ error: "missing_reason_code" });
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    await runIdempotent(req, res, async () => {
      const row = await loadMachineActivation(tenantId, machineFingerprint);
      if (!row) {
        return { status: 404, body: { error: "activation_not_found" } };
      }
      if (row.revoked_at) {
        return { status: 409, body: { error: "slot_not_held", revocation_kind: row.revocation_kind } };
      }
      const now = new Date().toISOString();
      await db.run("UPDATE machine_activations SET policy_refresh_requested_at = ? WHERE id = ?", now, row.id);
      const auditRecordId = await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "machine_policy_refresh_requested",
        action_category: "entitlement",
        correlation_id: newId("corr"),
        scope_tenant_id: tenantId,
        reason_code: reason,
        entity_refs: { tenant_id: tenantId, entitlement_id: row.license_id, machine_id: machineFingerprint },
        payload: { note: parsed.data.reason ?? null },
      });
      return { status: 200, body: { ok: true, requested_at: now, audit_record_id: auditRecordId } };
    });
  });
}

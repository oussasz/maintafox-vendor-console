/**
 * Administrator recovery codes (decision register 2026-10-19, "No active administrator left on a
 * PC", part a, rule as amended the same day). An operator issues a vendor-signed code bound to one
 * PC activation; on that PC it creates one new administrator account (no existing account is reset
 * or unlocked; the desktop then notifies every active administrator).
 * Valid 24 h; single use is enforced by the desktop (it records the code_id). Format and checks:
 * api/src/admin-recovery-signer.ts and deploy/CONSOLE_ACTIONS.md.
 *
 * The code is returned once in the response and never stored: not in admin_recovery_codes, not in
 * the audit ledger, not in idempotency_keys (this route does not replay responses).
 */
import type express from "express";
import { z } from "zod";

import { buildAdminRecoveryCode } from "../admin-recovery-signer.js";
import type { ApiContext } from "../app/context.js";
import { resolveActorId, sendValidationError } from "../app/http.js";
import { structuredLog } from "../app/runtime.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

/** More unexpired codes than this for one PC is refused (409): wait, or use one already sent. */
export const ADMIN_RECOVERY_MAX_UNEXPIRED_PER_DEVICE = 3;

const IssueBody = z.object({}).strict();

const ListQuery = z
  .object({
    machine_fingerprint: z.string().min(1).max(256).optional(),
  })
  .strict();

type CodeRow = {
  code_id: string;
  tenant_id: string;
  license_id: string;
  machine_fingerprint: string;
  issued_by: string;
  reason: string;
  issued_at: string;
  expires_at: string;
  key_id: string;
  audit_record_id: string;
};

export function registerAdminRecoveryRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, requirePrivilegedAction } = ctx;

  /**
   * Issues a code for the PC (tenant, machine fingerprint). Reason (X-Operator-Reason) and a
   * step-up of kind `admin_recovery_code` are required. Refusals:
   * 404 tenant_not_found | activation_not_found;
   * 409 tenant_suspended | activation_revoked | license_revoked | license_expired |
   *     admin_recovery_code_limit (ADMIN_RECOVERY_MAX_UNEXPIRED_PER_DEVICE unexpired codes already).
   */
  app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/admin-recovery-code", authMiddleware, async (req, res) => {
    const parsed = IssueBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { tenantId, machineFingerprint } = req.params;
    // A plain transaction (no Idempotency-Key replay): the response holds the code, which must not
    // be persisted anywhere.
    const out = await db.tx(async () => {
      // Serialises issuance per PC (the cap below). Taken before the guard's audit-chain lock, like
      // every tenant writer (lock → audit chain); no other route takes this namespace.
      await db.lockXact("admin-recovery", `${tenantId}:${machineFingerprint}`);
      const tenant = await db.get<{ id: string; is_active: number }>("SELECT id, is_active FROM tenants WHERE id = ?", tenantId);
      if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
      if (tenant.is_active !== 1) return { status: 409, body: { error: "tenant_suspended" } };
      const activation = await db.get<{ license_id: string; machine_fingerprint: string; revoked_at: string | null; revocation_kind: string | null }>(
        `SELECT license_id, machine_fingerprint, revoked_at, revocation_kind
         FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`,
        tenantId,
        machineFingerprint,
      );
      if (!activation) return { status: 404, body: { error: "activation_not_found" } };
      if (activation.revoked_at) {
        return { status: 409, body: { error: "activation_revoked", revocation_kind: activation.revocation_kind } };
      }
      const licence = await db.get<{ revoked_at: string | null; expires_at: string | null }>(
        "SELECT revoked_at, expires_at FROM license_keys WHERE id = ? AND tenant_id = ?",
        activation.license_id,
        tenantId,
      );
      if (!licence || licence.revoked_at) return { status: 409, body: { error: "license_revoked" } };
      const now = new Date();
      if (licence.expires_at && Date.parse(licence.expires_at) <= now.getTime()) {
        return { status: 409, body: { error: "license_expired", expires_at: licence.expires_at } };
      }
      const unexpired = await db.all<{ expires_at: string }>(
        `SELECT expires_at FROM admin_recovery_codes
         WHERE tenant_id = ? AND machine_fingerprint = ? AND expires_at > ?
         ORDER BY expires_at`,
        tenantId,
        machineFingerprint,
        now.toISOString(),
      );
      if (unexpired.length >= ADMIN_RECOVERY_MAX_UNEXPIRED_PER_DEVICE) {
        return {
          status: 409,
          body: {
            error: "admin_recovery_code_limit",
            max_unexpired: ADMIN_RECOVERY_MAX_UNEXPIRED_PER_DEVICE,
            next_expiry_at: unexpired[0]!.expires_at,
          },
        };
      }

      // The fingerprint as stored (byte for byte), which is what the desktop's claim holds.
      const signed = buildAdminRecoveryCode({
        tenantId,
        machineFingerprint: activation.machine_fingerprint,
        licenseId: activation.license_id,
        issuedAt: now,
      });
      const { payload } = signed;
      const guard = await requirePrivilegedAction(req, {
        action_code: "admin_recovery_code_issued",
        action_category: "entitlement",
        step_up_kind: StepUpKinds.adminRecoveryCode,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, entitlement_id: payload.license_id, machine_id: payload.machine_fingerprint },
        // Identifiers only: never the code string or its signature.
        payload: {
          code_id: payload.code_id,
          tenant_id: payload.tenant_id,
          machine_fingerprint: payload.machine_fingerprint,
          license_id: payload.license_id,
          key_id: payload.key_id,
          issued_at: payload.issued_at,
          expires_at: payload.expires_at,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        `INSERT INTO admin_recovery_codes
          (code_id, tenant_id, license_id, machine_fingerprint, issued_by, reason, issued_at, expires_at, key_id, audit_record_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        payload.code_id,
        tenantId,
        payload.license_id,
        payload.machine_fingerprint,
        resolveActorId(req),
        guard.reasonCode ?? "",
        payload.issued_at,
        payload.expires_at,
        payload.key_id,
        guard.auditRecordId,
      );
      structuredLog("admin_recovery_code_issued", {
        tenant_id: tenantId,
        machine_fingerprint: payload.machine_fingerprint,
        code_id: payload.code_id,
        expires_at: payload.expires_at,
      });
      return {
        status: 201,
        body: {
          code: signed.code,
          code_id: payload.code_id,
          tenant_id: tenantId,
          machine_fingerprint: payload.machine_fingerprint,
          license_id: payload.license_id,
          issued_at: payload.issued_at,
          expires_at: payload.expires_at,
          key_id: payload.key_id,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(out.status).json(out.body);
  });

  /** Codes issued for the tenant's PCs (newest first), optionally one PC's. Never the code strings. */
  app.get("/api/v1/tenants/:tenantId/admin-recovery-codes", authMiddleware, async (req, res) => {
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "query");
      return;
    }
    const { tenantId } = req.params;
    const fp = parsed.data.machine_fingerprint;
    const rows = await db.all<CodeRow>(
      `SELECT code_id, tenant_id, license_id, machine_fingerprint, issued_by, reason, issued_at, expires_at, key_id, audit_record_id
       FROM admin_recovery_codes
       WHERE tenant_id = ?${fp === undefined ? "" : " AND machine_fingerprint = ?"}
       ORDER BY issued_at DESC, code_id DESC
       LIMIT 500`,
      ...(fp === undefined ? [tenantId] : [tenantId, fp]),
    );
    const nowMs = Date.now();
    // Operator reasons: not for shared caches.
    res.setHeader("Cache-Control", "no-store");
    res.json(rows.map((r) => ({ ...r, expired: Date.parse(r.expires_at) <= nowMs })));
  });
}

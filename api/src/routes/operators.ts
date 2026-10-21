/**
 * Console operators and roles (master plan Phase 4.3): list, create, change role / name / enabled,
 * delete, reset second factor. Permission `operator.manage` (owners only, vendor-auth/roles.ts);
 * every change needs a reason and a `vendor_user_admin` step-up and is audited.
 *
 * Safety rules, checked server-side under one lock: you cannot demote, disable, delete or reset
 * yourself here, and the last enabled owner can never be demoted, disabled or deleted (the console
 * must always have someone able to manage it).
 */
import bcrypt from "bcryptjs";
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { sendValidationError, type AuthRequest, type IdempotentResponse } from "../app/http.js";
import { structuredLog } from "../app/runtime.js";
import { ROLES, type Role } from "../vendor-auth/roles.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";
import { OPERATOR_PASSWORD_BCRYPT_COST, OPERATOR_PASSWORD_MIN_LENGTH } from "./auth.js";

const RoleSchema = z.enum(ROLES);

const CreateOperatorBody = z
  .object({
    email: z.string().trim().email().max(254),
    display_name: z.string().trim().min(1).max(128),
    role: RoleSchema,
    initial_password: z.string().min(OPERATOR_PASSWORD_MIN_LENGTH).max(1024),
  })
  .strict();

const UpdateOperatorBody = z
  .object({
    display_name: z.string().trim().min(1).max(128).optional(),
    role: RoleSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

type OperatorRow = {
  id: number;
  email: string;
  display_name: string | null;
  role: Role;
  is_active: boolean;
  totp_enrolled_at: Date | null;
  created_at: string;
  last_login_at: Date | null;
  open_sessions: number;
};

const OPERATOR_SELECT = `SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.totp_enrolled_at, u.created_at,
         u.last_login_at,
         (SELECT count(*) FROM vendor_sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS open_sessions
       FROM users u`;

function toOperator(row: OperatorRow) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active,
    mfa_enrolled: row.totp_enrolled_at !== null,
    created_at: row.created_at,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    open_sessions: row.open_sessions,
  };
}

export function registerOperatorsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction, vendorAuth } = ctx;

  async function loadOperator(id: number): Promise<OperatorRow | undefined> {
    return db.get<OperatorRow>(`${OPERATOR_SELECT} WHERE u.id = ?`, id);
  }

  async function enabledOwnerCount(): Promise<number> {
    const row = await db.get<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND is_active");
    return row?.n ?? 0;
  }

  /**
   * For answers that carry a one-time code: one transaction, never the idempotency store (which
   * keeps response bodies), so the code exists in clear only in this response.
   */
  async function runOnce(res: express.Response, op: () => Promise<IdempotentResponse>): Promise<void> {
    const out = await db.tx(op);
    res.status(out.status).json(out.body);
  }

  function operatorIdOf(req: express.Request): number | null {
    const id = Number(req.params.operatorId);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  app.get("/api/v1/operators", authMiddleware, async (_req, res) => {
    const rows = await db.all<OperatorRow>(`${OPERATOR_SELECT} ORDER BY u.id`);
    res.json(rows.map(toOperator));
  });

  /** Creates an operator; returns a one-time enrolment code their first sign-in needs (shown once). */
  app.post("/api/v1/operators", authMiddleware, async (req, res) => {
    const parsed = CreateOperatorBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;
    await runOnce(res, async () => {
      await db.lockXact("operators", "admin");
      if (await vendorAuth.findUserByEmail(input.email)) {
        return { status: 409, body: { error: "operator_email_taken" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "operator_create",
        action_category: "operator",
        step_up_kind: StepUpKinds.vendorUserAdmin,
        payload: { email: input.email, display_name: input.display_name, role: input.role },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const hash = await bcrypt.hash(input.initial_password, OPERATOR_PASSWORD_BCRYPT_COST);
      const created = await db.get<{ id: number }>(
        "INSERT INTO users (email, password_hash, display_name, role) VALUES (?, ?, ?, ?) RETURNING id",
        input.email,
        hash,
        input.display_name,
        input.role,
      );
      const enrolmentCode = await vendorAuth.issueEnrolmentCode(created!.id);
      structuredLog("operator_created", { operator_id: created!.id, role: input.role });
      return {
        status: 201,
        body: {
          operator: toOperator((await loadOperator(created!.id))!),
          enrolment_code: enrolmentCode,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });

  /** Name, role, enabled. Disabling ends the operator's sessions at once. */
  app.patch("/api/v1/operators/:operatorId", authMiddleware, async (req, res) => {
    const parsed = UpdateOperatorBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const id = operatorIdOf(req);
    if (id === null) {
      res.status(404).json({ error: "operator_not_found" });
      return;
    }
    const self = Number((req as AuthRequest).userId) === id;
    const patch = parsed.data;
    await runIdempotent(req, res, async () => {
      await db.lockXact("operators", "admin");
      const current = await loadOperator(id);
      if (!current) return { status: 404, body: { error: "operator_not_found" } };
      if (self && (patch.role !== undefined || patch.is_active !== undefined)) {
        return { status: 409, body: { error: "cannot_change_own_access" } };
      }
      const losesOwner =
        current.role === "owner" &&
        current.is_active &&
        ((patch.role !== undefined && patch.role !== "owner") || patch.is_active === false);
      if (losesOwner && (await enabledOwnerCount()) <= 1) {
        return { status: 409, body: { error: "last_owner" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "operator_update",
        action_category: "operator",
        step_up_kind: StepUpKinds.vendorUserAdmin,
        payload: {
          operator_id: id,
          email: current.email,
          from: { display_name: current.display_name, role: current.role, is_active: current.is_active },
          to: patch,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        `UPDATE users SET display_name = COALESCE(?, display_name), role = COALESCE(?, role),
           is_active = COALESCE(?, is_active) WHERE id = ?`,
        patch.display_name ?? null,
        patch.role ?? null,
        patch.is_active ?? null,
        id,
      );
      const sessionsEnded = patch.is_active === false ? await vendorAuth.revokeAllSessions(id, "operator_disabled") : 0;
      return {
        status: 200,
        body: { operator: toOperator((await loadOperator(id))!), sessions_ended: sessionsEnded, audit_record_id: guard.auditRecordId },
      };
    });
  });

  /** Deletes an operator (their sessions and second factor go with them; the audit trail stays). */
  app.delete("/api/v1/operators/:operatorId", authMiddleware, async (req, res) => {
    const id = operatorIdOf(req);
    if (id === null) {
      res.status(404).json({ error: "operator_not_found" });
      return;
    }
    if (Number((req as AuthRequest).userId) === id) {
      res.status(409).json({ error: "cannot_change_own_access" });
      return;
    }
    await runIdempotent(req, res, async () => {
      await db.lockXact("operators", "admin");
      const current = await loadOperator(id);
      if (!current) return { status: 404, body: { error: "operator_not_found" } };
      if (current.role === "owner" && current.is_active && (await enabledOwnerCount()) <= 1) {
        return { status: 409, body: { error: "last_owner" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "operator_delete",
        action_category: "operator",
        step_up_kind: StepUpKinds.vendorUserAdmin,
        payload: { operator_id: id, email: current.email, role: current.role },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run("DELETE FROM users WHERE id = ?", id);
      return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Resets another operator's second factor (lost phone): their authenticator and recovery codes
   * are removed and their sessions end; their next sign-in needs the returned one-time reset code
   * (give it to them out of band), then a new enrolment.
   */
  app.post("/api/v1/operators/:operatorId/mfa-reset", authMiddleware, async (req, res) => {
    const id = operatorIdOf(req);
    if (id === null) {
      res.status(404).json({ error: "operator_not_found" });
      return;
    }
    if (Number((req as AuthRequest).userId) === id) {
      res.status(409).json({ error: "cannot_change_own_access" });
      return;
    }
    await runOnce(res, async () => {
      const current = await loadOperator(id);
      if (!current) return { status: 404, body: { error: "operator_not_found" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "mfa_reset",
        action_category: "vendor_auth",
        step_up_kind: StepUpKinds.vendorUserAdmin,
        payload: { vendor_user_id: id, email: current.email, had_second_factor: current.totp_enrolled_at !== null },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const { sessionsRevoked, resetCode } = await vendorAuth.resetMfa(id, "mfa_reset_operator");
      return {
        status: 200,
        body: { ok: true, sessions_ended: sessionsRevoked, reset_code: resetCode, audit_record_id: guard.auditRecordId },
      };
    });
  });
}

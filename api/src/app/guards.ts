/**
 * Request guards bound to the API database: vendor-admin and device authentication, idempotent
 * mutations, and the privileged-action guard (reason + step-up, audited).
 */
import type express from "express";

import type { AuditEntityRefs } from "../audit-chain.js";
import { verifyDeviceActivationToken, verifyStepUpToken, verifyVendorAdminToken } from "../auth-tokens.js";
import type { Database } from "../db/database.js";
import type { VendorAuth } from "../vendor-auth/service.js";
import { ROUTE_PERMISSIONS, roleAllows } from "../vendor-auth/roles.js";
import type { StepUpActionKind } from "../vendor-auth/step-up-kinds.js";
import type { AuditAppender } from "./audit.js";
import { JWT_SECRET, PRIVILEGED_REASON_MIN_LENGTH } from "./config.js";
import { resolveActorId, type ActivationAuthContext, type AuthRequest, type IdempotentResponse } from "./http.js";
import { newId, sha256Hex, structuredLog } from "./runtime.js";
import { openOperatorScope, tenantScope } from "./scope.js";

export function createGuards(db: Database, { appendAuditRecord }: AuditAppender, vendorAuth: VendorAuth) {
  /**
   * Vendor-console operator authentication and authorisation. Only accepts vendor_admin tokens
   * (device activation, MFA-pending and step-up tokens are rejected by audience/kind), re-checks
   * that the token's session is still open for that enabled operator (logout, "log out everywhere",
   * refresh-token reuse, an MFA reset, a disabled or deleted operator stop an unexpired token
   * immediately), then checks the operator's role grants the route's permission.
   */
  async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const claims = verifyVendorAdminToken(JWT_SECRET, h.slice(7));
    if (!claims) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const role = await vendorAuth.activeSessionRole(claims.sessionId, claims.userId);
    if (!role) {
      res.status(401).json({ error: "session_ended" });
      return;
    }
    // Least privilege, server-side: the route's required permission (vendor-auth/roles.ts). A route
    // missing from the table is refused rather than left open.
    const routeKey = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requirement = ROUTE_PERMISSIONS[routeKey];
    if (!requirement) {
      structuredLog("route_permission_missing", { route: routeKey });
      res.status(500).json({ error: "route_permission_missing" });
      return;
    }
    if (!roleAllows(role, requirement)) {
      res.status(403).json({ error: "permission_denied", required_permission: requirement });
      return;
    }
    (req as AuthRequest).userId = String(claims.userId);
    (req as AuthRequest).vendorSessionId = claims.sessionId;
    (req as AuthRequest).operatorRole = role;
    // Console routes act across tenants: an explicit, recorded operator scope for this request.
    const scope = await openOperatorScope(db, resolveActorId(req), { method: req.method, path: req.path });
    db.runInScope(scope, next);
  }

  /** `last_seen_at` is written at most this often per device (the sync heartbeat runs every ~15 s). */
  const LAST_SEEN_TOUCH_INTERVAL_MS = 60_000;

  /**
   * Device requests are accepted only while the token is the one most recently issued to this
   * machine and the machine, its licence and its tenant are all still valid. Denials:
   * 401 missing_token | invalid_token | token_superseded | policy_refresh_required (sync routes only,
   * after an operator asked for a policy refresh: the desktop re-checks its licence, gets a new
   * token from POST /activation/policy-refresh and resumes);
   * 403 tenant_inactive | license_revoked | license_expired | activation_revoked.
   */
  async function activationAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const token = h.slice(7);
    const claims = verifyDeviceActivationToken(JWT_SECRET, token);
    if (!claims) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    // The token is verified: from here on only this tenant's rows are visible.
    const scope = tenantScope(claims.tenantId);
    const row = await db.runInScope(scope, () => db.get(`SELECT a.id, a.revoked_at, a.activation_token, a.last_seen_at,
                a.policy_refresh_requested_at,
                l.revoked_at AS license_revoked_at, l.expires_at AS license_expires_at,
                t.is_active AS tenant_is_active
         FROM machine_activations a
         JOIN license_keys l ON l.id = a.license_id
         JOIN tenants t ON t.id = a.tenant_id
         WHERE a.tenant_id = ? AND a.license_id = ? AND a.machine_fingerprint = ?`, claims.tenantId, claims.licenseId, claims.machineFingerprint)) as
      | {
          id: string;
          revoked_at: string | null;
          activation_token: string;
          last_seen_at: string;
          policy_refresh_requested_at: string | null;
          license_revoked_at: string | null;
          license_expires_at: string | null;
          tenant_is_active: number;
        }
      | undefined;
    const deny = (status: number, error: string) => {
      structuredLog("activation_auth_denied", {
        status,
        reason: error,
        tenant_id: claims.tenantId,
        license_id: claims.licenseId,
        machine_fingerprint: claims.machineFingerprint,
        path: req.path,
      });
      res.status(status).json({ error });
    };
    if (!row) {
      deny(403, "activation_revoked");
      return;
    }
    if (row.activation_token !== token) {
      deny(401, "token_superseded");
      return;
    }
    if (row.tenant_is_active !== 1) {
      deny(403, "tenant_inactive");
      return;
    }
    if (row.license_revoked_at) {
      deny(403, "license_revoked");
      return;
    }
    if (row.license_expires_at && new Date(row.license_expires_at) <= new Date()) {
      deny(403, "license_expired");
      return;
    }
    if (row.revoked_at) {
      deny(403, "activation_revoked");
      return;
    }
    if (row.policy_refresh_requested_at && req.path.toLowerCase().startsWith("/api/v1/sync/")) {
      deny(401, "policy_refresh_required");
      return;
    }
    const nowMs = Date.now();
    const lastSeenMs = Date.parse(row.last_seen_at);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= LAST_SEEN_TOUCH_INTERVAL_MS) {
      await db.runInScope(scope, () =>
        db.run("UPDATE machine_activations SET last_seen_at = ? WHERE id = ?", new Date(nowMs).toISOString(), row.id),
      );
    }
    (req as express.Request & { activation?: ActivationAuthContext }).activation = {
      tenantId: claims.tenantId,
      licenseId: claims.licenseId,
      machineFingerprint: claims.machineFingerprint,
      token,
      tokenIssuedAt: claims.issuedAt,
    };
    db.runInScope(scope, next);
  }

  /**
   * Runs a mutating operation in one transaction. With an Idempotency-Key header the stored response
   * is replayed for the same request (409 for a different one); the key lookup, the operation and
   * the stored response commit together, and concurrent requests with the same key are serialized.
   */
  async function runIdempotent(
    req: express.Request,
    res: express.Response,
    operation: () => Promise<IdempotentResponse>,
  ): Promise<void> {
    const idemHeader = req.header("Idempotency-Key")?.trim();
    if (!idemHeader) {
      const out = await db.tx(operation);
      res.status(out.status).json(out.body);
      return;
    }
    const actorId = resolveActorId(req);
    const requestHash = sha256Hex(
      JSON.stringify({
        body: req.body ?? null,
        query: req.query ?? null,
        params: req.params ?? null,
      }),
    );
    const scopedKey = `${actorId}:${req.method}:${req.path}:${idemHeader}`;
    const outcome = await db.tx(async (): Promise<
      { kind: "conflict" } | { kind: "replay" | "fresh"; status: number; body: unknown }
    > => {
      await db.lockXact("admin-idempotency", scopedKey);
      const existing = await db.get<{ request_hash: string; response_status: number; response_json: string }>(
        `SELECT request_hash, response_status, response_json
         FROM idempotency_keys
         WHERE idempotency_key = ?`,
        scopedKey,
      );
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return { kind: "conflict" };
        }
        return { kind: "replay", status: existing.response_status, body: JSON.parse(existing.response_json) };
      }
      const out = await operation();
      await db.run(
        `INSERT INTO idempotency_keys
          (idempotency_key, actor_id, method, path, request_hash, response_status, response_json, created_at_rfc3339)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        scopedKey,
        actorId,
        req.method,
        req.path,
        requestHash,
        out.status,
        JSON.stringify(out.body),
        new Date().toISOString(),
      );
      return { kind: "fresh", status: out.status, body: out.body };
    });
    if (outcome.kind === "conflict") {
      res.status(409).json({ error: "idempotency_key_conflict" });
      return;
    }
    res.setHeader("X-Idempotent-Replay", outcome.kind === "replay" ? "true" : "false");
    res.status(outcome.status).json(outcome.body);
  }

  async function requirePrivilegedAction(
    req: express.Request,
    input: {
      action_code: string;
      action_category: string;
      /** The only step-up kind this route accepts (shared/step-up-actions.v1.json). */
      step_up_kind: StepUpActionKind;
      scope_tenant_id?: string | null;
      entity_refs?: AuditEntityRefs;
      payload?: unknown;
    },
  ): Promise<{ ok: true; reasonCode: string | null; auditRecordId: string } | { ok: false; status: number; body: unknown }> {
    const reasonCode = req.header("X-Operator-Reason")?.trim() ?? null;
    const stepUpToken = req.header("X-Step-Up-Token")?.trim() ?? null;
    if (!reasonCode || reasonCode.length < PRIVILEGED_REASON_MIN_LENGTH) {
      return {
        ok: false,
        status: 403,
        body: { error: "privileged_action_guard_failed", reason: "missing_reason_code" },
      };
    }
    if (!stepUpToken) {
      return {
        ok: false,
        status: 403,
        body: { error: "privileged_action_guard_failed", reason: "missing_step_up_token" },
      };
    }
    const operatorId = Number((req as AuthRequest).userId);
    const sessionId = (req as AuthRequest).vendorSessionId ?? "";
    const verification = verifyStepUpToken(JWT_SECRET, stepUpToken, {
      userId: operatorId,
      sessionId,
      actionKind: input.step_up_kind,
    });
    if (!verification.ok) {
      // A presented but refused proof is security-relevant (PrivilegedActionDenied): ledger it.
      await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "privileged_action_denied",
        action_category: "vendor_auth",
        correlation_id: `priv-${newId("corr")}`,
        scope_tenant_id: input.scope_tenant_id ?? null,
        reason_code: reasonCode,
        entity_refs: input.entity_refs,
        payload: { attempted_action_code: input.action_code, step_up_kind: input.step_up_kind, denial: verification.reason },
      });
      return {
        ok: false,
        status: 403,
        body: { error: "privileged_action_guard_failed", reason: verification.reason, step_up_kind: input.step_up_kind },
      };
    }
    const stepUp = verification.claims;
    const auditRecordId = await appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: input.action_code,
      action_category: input.action_category,
      correlation_id: `priv-${newId("corr")}`,
      scope_tenant_id: input.scope_tenant_id ?? null,
      reason_code: reasonCode,
      entity_refs: input.entity_refs,
      payload: {
        ...(input.payload as Record<string, unknown> | undefined),
        privileged_step_up_present: true,
        step_up_id: stepUp.jti,
        step_up_kind: stepUp.actionKind,
      },
    });
    return { ok: true, reasonCode, auditRecordId };
  }

  return { authMiddleware, activationAuthMiddleware, runIdempotent, requirePrivilegedAction };
}

export type Guards = ReturnType<typeof createGuards>;

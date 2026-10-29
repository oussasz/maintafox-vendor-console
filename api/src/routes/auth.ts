/**
 * Vendor-console operator authentication (master plan Phase 4.1).
 *
 * Login is two steps: the password (POST /auth/login) yields a short MFA-pending token, and only a
 * TOTP code (or a recovery code) turns it into a session. An operator without a second factor is
 * led through enrolment first; nobody gets a session without one.
 *
 * A session is server-side (vendor_sessions). The console holds the 15-minute access token in
 * memory only; the refresh token lives in an httpOnly, Secure, SameSite=Strict cookie scoped to
 * /api/v1/auth and is replaced on every use (reuse of an old one revokes the session).
 *
 * Every outcome that matters for security is appended to the audit ledger (category vendor_auth).
 */
import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { CONSOLE_CORS_ORIGINS, JWT_SECRET } from "../app/config.js";
import {
  loginRateLimiter,
  mfaRateLimiter,
  refreshRateLimiter,
  sendValidationError,
  stepUpRateLimiter,
  type AuthRequest,
  type MfaPendingRequest,
} from "../app/http.js";
import { observeAuthAttempt } from "../app/observability.js";
import { newId, structuredLog } from "../app/runtime.js";
import { systemScopeMiddleware } from "../app/scope.js";
import {
  signStepUpToken,
  signVendorAdminToken,
  signVendorMfaToken,
  STEP_UP_TTL_SECONDS,
  VENDOR_ADMIN_TTL_SECONDS,
  VENDOR_MFA_PENDING_TTL_SECONDS,
  verifyVendorMfaToken,
} from "../auth-tokens.js";
import { ROLE_PERMISSIONS, type Role } from "../vendor-auth/roles.js";
import { isStepUpActionKind, StepUpKinds } from "../vendor-auth/step-up-kinds.js";

/** Permissions of a role, in the console's PermissionRecord shape. */
function permissionRecords(role: Role) {
  return ROLE_PERMISSIONS[role].map((name) => ({
    name,
    description: name,
    category: "vendor",
    is_dangerous: false,
    requires_step_up: false,
  }));
}

/** Minimum length of an operator password set through the API. */
export const OPERATOR_PASSWORD_MIN_LENGTH = 12;
/** bcrypt cost of operator passwords (as the first seeded operator, app/seed.ts). */
export const OPERATOR_PASSWORD_BCRYPT_COST = 12;

export const REFRESH_COOKIE_NAME = "mfx_vendor_refresh";
/** The refresh cookie is sent only to the auth routes, never with ordinary API calls. */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
}).strict();

/**
 * Compared against when the email is unknown, so an unknown and a known account take the same
 * time to refuse (no account discovery by timing). A bcrypt hash of a random value, cost 12 like
 * real hashes (app/seed.ts).
 */
const UNKNOWN_USER_HASH = bcrypt.hashSync(randomBytes(32).toString("hex"), 12);

const TotpCode = z.string().trim().regex(/^\d{6}$/);
const CodeBody = z.object({ code: TotpCode }).strict();
const VerifyBody = z.union([
  z.object({ code: TotpCode }).strict(),
  z.object({ recovery_code: z.string().trim().min(10).max(32) }).strict(),
]);
/** After a server-side MFA reset, enrolment needs the one-time code the reset printed. */
const EnrollStartBody = z.object({ reset_code: z.string().trim().min(10).max(32).optional() }).strict();
const ChangePasswordBody = z
  .object({
    current_password: z.string().min(1).max(1024),
    new_password: z.string().min(OPERATOR_PASSWORD_MIN_LENGTH).max(1024),
  })
  .strict();
const StepUpBody = z.object({ action_kind: z.string().min(1).max(64), code: TotpCode }).strict();

function readCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

function setRefreshCookie(res: express.Response, token: string, sessionExpiresAt: Date): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.max(0, sessionExpiresAt.getTime() - Date.now()),
  });
}

function clearRefreshCookie(res: express.Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { httpOnly: true, secure: true, sameSite: "strict", path: REFRESH_COOKIE_PATH });
}

/**
 * Routes authenticated by the refresh cookie must come from the console's own origin (CSRF
 * defence on top of SameSite=Strict). Browsers always send Origin on these cross-origin POSTs.
 */
function requireConsoleOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.header("Origin");
  if (!origin || !CONSOLE_CORS_ORIGINS.includes(origin)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }
  next();
}

function clientOf(req: express.Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.header("User-Agent") ?? null };
}

export function registerAuthRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, vendorAuth, appendAuditRecord, requirePrivilegedAction } = ctx;
  // Login, MFA and refresh act before an operator scope exists; their audit rows need one.
  const authScope = systemScopeMiddleware(db, "vendor-auth");

  async function auditAuth(input: {
    actor_id: string;
    action_code: string;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    return appendAuditRecord({
      actor_id: input.actor_id,
      action_code: input.action_code,
      action_category: "vendor_auth",
      correlation_id: `auth-${newId("corr")}`,
      payload: input.payload,
    });
  }

  /** MFA-pending token (Bearer) → req.mfa; anything else is 401. */
  function mfaPendingMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const h = req.headers.authorization;
    const claims = h?.startsWith("Bearer ") ? verifyVendorMfaToken(JWT_SECRET, h.slice(7)) : null;
    if (!claims) {
      res.status(401).json({ error: "mfa_token_invalid" });
      return;
    }
    (req as MfaPendingRequest).mfa = claims;
    next();
  }

  /** Opens a session and answers with the access token; sets the refresh cookie. */
  async function completeLogin(
    req: express.Request,
    res: express.Response,
    user: { id: number; email: string },
    extra: Record<string, unknown>,
  ): Promise<void> {
    const session = await vendorAuth.startSession(user.id, clientOf(req));
    await vendorAuth.recordLogin(user.id);
    setRefreshCookie(res, session.refreshToken, session.expiresAt);
    res.json({
      access_token: signVendorAdminToken(JWT_SECRET, user, session.sessionId),
      token_type: "Bearer",
      expires_in: VENDOR_ADMIN_TTL_SECONDS,
      session_expires_at: session.expiresAt.toISOString(),
      ...extra,
    });
  }

  app.post("/api/v1/auth/login", loginRateLimiter, authScope, async (req, res) => {
    const startedAt = Date.now();
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      observeAuthAttempt(Date.now() - startedAt, false);
      structuredLog("auth_login_failed", {
        reason: "invalid_body",
        status: 400,
        email: typeof req.body?.email === "string" ? req.body.email : null,
      });
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const { email, password } = parsed.data;
    const user = await vendorAuth.findUserByEmail(email);
    const passwordOk = await bcrypt.compare(password, user?.password_hash ?? UNKNOWN_USER_HASH);
    // A disabled operator is refused like a wrong password (nothing tells a caller the account exists).
    if (!user || !passwordOk || !user.is_active) {
      observeAuthAttempt(Date.now() - startedAt, false);
      structuredLog("auth_login_failed", { reason: "invalid_credentials", status: 401, email });
      await auditAuth({
        actor_id: user ? `user_${user.id}` : "anonymous",
        action_code: "login_failure",
        payload: { email, client_ip: req.ip ?? null, operator_disabled: user ? !user.is_active : null },
      });
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    observeAuthAttempt(Date.now() - startedAt, true);
    const stage = user.totp_enrolled ? "verify" : "enroll";
    structuredLog("auth_login_password_ok", { status: 200, user_id: user.id, mfa_stage: stage });
    await auditAuth({ actor_id: `user_${user.id}`, action_code: "login_password_accepted", payload: { mfa_stage: stage } });
    res.json({
      status: stage === "enroll" ? "mfa_enrollment_required" : "mfa_required",
      mfa_token: signVendorMfaToken(JWT_SECRET, { userId: user.id, stage }),
      expires_in: VENDOR_MFA_PENDING_TTL_SECONDS,
      reset_code_required: stage === "enroll" && user.reset_code_required,
    });
  });

  /**
   * Enrolment step 1: a new secret (QR URI + text) replacing any unconfirmed one. After a server-side
   * MFA reset the one-time reset code is required too.
   */
  app.post("/api/v1/auth/mfa/enroll/start", mfaPendingMiddleware, mfaRateLimiter, authScope, async (req, res) => {
    const parsed = EnrollStartBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const mfa = (req as MfaPendingRequest).mfa!;
    const user = await vendorAuth.getUser(mfa.userId);
    if (!user || !user.is_active) {
      res.status(401).json({ error: "mfa_token_invalid" });
      return;
    }
    if (mfa.stage !== "enroll" || user.totp_enrolled) {
      res.status(409).json({ error: "mfa_already_enrolled" });
      return;
    }
    if (user.reset_code_required) {
      const code = parsed.data.reset_code;
      if (!code || !(await vendorAuth.checkResetCode(user.id, code))) {
        await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_failure", payload: { stage: "enroll", method: "reset_code" } });
        res.status(401).json({ error: "invalid_reset_code" });
        return;
      }
    }
    const enrolment = await vendorAuth.beginTotpEnrolment(user);
    await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_enrollment_started" });
    res.json({ otpauth_uri: enrolment.otpauthUri, secret_base32: enrolment.secretBase32, account_name: user.email });
  });

  /** Enrolment step 2: a code from the new secret activates it, opens the session, returns recovery codes once. */
  app.post("/api/v1/auth/mfa/enroll/confirm", mfaPendingMiddleware, mfaRateLimiter, authScope, async (req, res) => {
    const parsed = CodeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const mfa = (req as MfaPendingRequest).mfa!;
    const user = await vendorAuth.getUser(mfa.userId);
    if (!user || !user.is_active) {
      res.status(401).json({ error: "mfa_token_invalid" });
      return;
    }
    if (mfa.stage !== "enroll" || user.totp_enrolled) {
      res.status(409).json({ error: "mfa_already_enrolled" });
      return;
    }
    const recoveryCodes = await vendorAuth.confirmTotpEnrolment(user.id, parsed.data.code, Date.now() / 1000);
    if (!recoveryCodes) {
      await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_failure", payload: { stage: "enroll" } });
      res.status(401).json({ error: "invalid_mfa_code" });
      return;
    }
    await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_enrolled", payload: { recovery_codes_issued: recoveryCodes.length } });
    await completeLogin(req, res, user, { recovery_codes: recoveryCodes });
  });

  /** Second factor of an enrolled operator: a TOTP code, or one recovery code (spent). */
  app.post("/api/v1/auth/mfa/verify", mfaPendingMiddleware, mfaRateLimiter, authScope, async (req, res) => {
    const parsed = VerifyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const mfa = (req as MfaPendingRequest).mfa!;
    const user = await vendorAuth.getUser(mfa.userId);
    if (!user || !user.is_active) {
      res.status(401).json({ error: "mfa_token_invalid" });
      return;
    }
    if (mfa.stage !== "verify" || !user.totp_enrolled) {
      // MFA was reset after the password step: start again from the login form.
      res.status(409).json({ error: "mfa_enrollment_required" });
      return;
    }
    if ("code" in parsed.data) {
      if (!(await vendorAuth.verifyTotpCode(user.id, parsed.data.code, Date.now() / 1000))) {
        await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_failure", payload: { stage: "verify", method: "totp" } });
        res.status(401).json({ error: "invalid_mfa_code" });
        return;
      }
      await auditAuth({ actor_id: `user_${user.id}`, action_code: "login_success", payload: { method: "totp" } });
      await completeLogin(req, res, user, {});
      return;
    }
    const remaining = await vendorAuth.useRecoveryCode(user.id, parsed.data.recovery_code);
    if (remaining === null) {
      await auditAuth({ actor_id: `user_${user.id}`, action_code: "mfa_failure", payload: { stage: "verify", method: "recovery_code" } });
      res.status(401).json({ error: "invalid_recovery_code" });
      return;
    }
    await auditAuth({
      actor_id: `user_${user.id}`,
      action_code: "login_success",
      payload: { method: "recovery_code", recovery_codes_remaining: remaining },
    });
    await completeLogin(req, res, user, { recovery_codes_remaining: remaining });
  });

  /** Exchanges the refresh cookie for a new access token and a new refresh cookie (rotation). */
  app.post("/api/v1/auth/refresh", refreshRateLimiter, requireConsoleOrigin, authScope, async (req, res) => {
    const token = readCookie(req, REFRESH_COOKIE_NAME);
    if (!token) {
      res.status(401).json({ error: "no_session" });
      return;
    }
    const outcome = await vendorAuth.rotateRefreshToken(token);
    if (outcome.kind === "reuse_detected") {
      clearRefreshCookie(res);
      structuredLog("auth_refresh_reuse_detected", { user_id: outcome.userId, session_id: outcome.sessionId });
      await auditAuth({
        actor_id: `user_${outcome.userId}`,
        action_code: "refresh_token_reuse_detected",
        payload: { session_id: outcome.sessionId, client_ip: req.ip ?? null, session_revoked: true },
      });
      res.status(401).json({ error: "session_ended" });
      return;
    }
    if (outcome.kind === "lost_response") {
      // The browser missed the previous answer: it must sign in again, but nothing was stolen.
      structuredLog("auth_refresh_lost_response", { user_id: outcome.userId, session_id: outcome.sessionId });
      clearRefreshCookie(res);
      res.status(401).json({ error: "session_ended" });
      return;
    }
    if (outcome.kind === "invalid") {
      clearRefreshCookie(res);
      res.status(401).json({ error: "session_ended" });
      return;
    }
    const user = await vendorAuth.getUser(outcome.userId);
    if (!user) {
      clearRefreshCookie(res);
      res.status(401).json({ error: "session_ended" });
      return;
    }
    await auditAuth({ actor_id: `user_${user.id}`, action_code: "refresh_rotated", payload: { session_id: outcome.sessionId } });
    setRefreshCookie(res, outcome.refreshToken, outcome.sessionExpiresAt);
    res.json({
      access_token: signVendorAdminToken(JWT_SECRET, user, outcome.sessionId),
      token_type: "Bearer",
      expires_in: VENDOR_ADMIN_TTL_SECONDS,
      session_expires_at: outcome.sessionExpiresAt.toISOString(),
    });
  });

  /** Ends the session of this browser (refresh cookie). Idempotent: no session is still 204. */
  app.post("/api/v1/auth/logout", requireConsoleOrigin, authScope, async (req, res) => {
    const token = readCookie(req, REFRESH_COOKIE_NAME);
    const session = token ? await vendorAuth.sessionOfRefreshToken(token) : undefined;
    if (session && (await vendorAuth.revokeSession(session.sessionId, "logout"))) {
      await auditAuth({ actor_id: `user_${session.userId}`, action_code: "logout", payload: { session_id: session.sessionId } });
    }
    clearRefreshCookie(res);
    res.status(204).end();
  });

  /** Ends every session of the signed-in operator, on every browser. */
  app.post("/api/v1/auth/logout-all", authMiddleware, async (req, res) => {
    const userId = Number((req as AuthRequest).userId);
    const revoked = await vendorAuth.revokeAllSessions(userId, "logout_all");
    await auditAuth({ actor_id: `user_${userId}`, action_code: "logout_all", payload: { sessions_revoked: revoked } });
    clearRefreshCookie(res);
    res.json({ sessions_revoked: revoked });
  });

  /** Who is signed in, until when, and how many recovery codes remain. */
  app.get("/api/v1/auth/session", authMiddleware, async (req, res) => {
    const userId = Number((req as AuthRequest).userId);
    const user = await vendorAuth.getUser(userId);
    const session = await vendorAuth.getSession((req as AuthRequest).vendorSessionId!);
    if (!user || !session) {
      res.status(401).json({ error: "session_ended" });
      return;
    }
    res.json({
      user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role },
      session: { id: session.id, created_at: session.createdAt, expires_at: session.expiresAt },
      mfa: { enrolled: user.totp_enrolled, recovery_codes_remaining: await vendorAuth.remainingRecoveryCodes(userId) },
      step_up_ttl_seconds: STEP_UP_TTL_SECONDS,
    });
  });

  /**
   * Privileged-action step-up: a fresh TOTP code yields a short-lived token for ONE action kind
   * (shared/step-up-actions.v1.json), bound to the operator and this session, sent as
   * X-Step-Up-Token on that kind's routes (requirePrivilegedAction). A code is never accepted twice.
   */
  app.post("/api/v1/auth/step-up", authMiddleware, stepUpRateLimiter, async (req, res) => {
    const parsed = StepUpBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { action_kind: actionKind, code } = parsed.data;
    if (!isStepUpActionKind(actionKind)) {
      res.status(400).json({ error: "unknown_step_up_action_kind", action_kind: actionKind });
      return;
    }
    const userId = Number((req as AuthRequest).userId);
    const sessionId = (req as AuthRequest).vendorSessionId!;
    if (!(await vendorAuth.verifyTotpCode(userId, code, Date.now() / 1000))) {
      structuredLog("auth_step_up_failed", { user_id: userId, status: 401, action_kind: actionKind });
      await auditAuth({ actor_id: `user_${userId}`, action_code: "step_up_failure", payload: { action_kind: actionKind } });
      res.status(401).json({ error: "invalid_mfa_code" });
      return;
    }
    const jti = newId("stepup");
    structuredLog("auth_step_up_success", { user_id: userId, step_up_id: jti, action_kind: actionKind });
    await auditAuth({ actor_id: `user_${userId}`, action_code: "step_up_granted", payload: { action_kind: actionKind, step_up_id: jti } });
    res.json({
      step_up_token: signStepUpToken(JWT_SECRET, { userId, sessionId, actionKind, jti }),
      token_type: "StepUp",
      action_kind: actionKind,
      expires_in: STEP_UP_TTL_SECONDS,
    });
  });

  /** Replaces the operator's recovery codes (the old ones stop working); step-up `own_mfa_change`. */
  app.post("/api/v1/auth/mfa/recovery-codes", authMiddleware, async (req, res) => {
    const userId = Number((req as AuthRequest).userId);
    const guard = await requirePrivilegedAction(req, {
      action_code: "mfa_recovery_codes_regenerated",
      action_category: "vendor_auth",
      step_up_kind: StepUpKinds.ownMfaChange,
    });
    if (!guard.ok) {
      res.status(guard.status).json(guard.body);
      return;
    }
    const codes = await vendorAuth.replaceRecoveryCodes(userId);
    res.json({ recovery_codes: codes, audit_record_id: guard.auditRecordId });
  });

  /** The signed-in operator's permissions (from their role; the server checks them on every route). */
  app.get("/api/v1/me/permissions", authMiddleware, async (req, res) => {
    res.json(permissionRecords((req as AuthRequest).operatorRole!));
  });

  /**
   * Changes the signed-in operator's password (current password required). Every other session of
   * theirs ends; this one continues. Refusals count against the step-up rate limit.
   */
  app.post("/api/v1/auth/password", authMiddleware, stepUpRateLimiter, async (req, res) => {
    const parsed = ChangePasswordBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const userId = Number((req as AuthRequest).userId);
    const user = await vendorAuth.getUser(userId);
    if (!user || !(await bcrypt.compare(parsed.data.current_password, user.password_hash))) {
      await auditAuth({ actor_id: `user_${userId}`, action_code: "password_change_refused" });
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    if (parsed.data.new_password === parsed.data.current_password) {
      res.status(400).json({ error: "password_unchanged" });
      return;
    }
    const hash = await bcrypt.hash(parsed.data.new_password, OPERATOR_PASSWORD_BCRYPT_COST);
    const otherSessionsEnded = await vendorAuth.changePassword(userId, hash, (req as AuthRequest).vendorSessionId!);
    await auditAuth({ actor_id: `user_${userId}`, action_code: "password_changed", payload: { other_sessions_ended: otherSessionsEnded } });
    res.json({ ok: true, other_sessions_ended: otherSessionsEnded });
  });
}

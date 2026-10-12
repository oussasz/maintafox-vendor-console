/**
 * Vendor-console operator authentication: password login, step-up, permissions.
 */
import bcrypt from "bcryptjs";
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { JWT_SECRET } from "../app/config.js";
import { loginRateLimiter, sendValidationError, stepUpRateLimiter, type AuthRequest } from "../app/http.js";
import { observeAuthAttempt } from "../app/observability.js";
import { newId, structuredLog } from "../app/runtime.js";
import { signStepUpToken, signVendorAdminToken, STEP_UP_TTL_SECONDS, VENDOR_ADMIN_TTL_SECONDS } from "../auth-tokens.js";

/** Matches vendor-console PermissionRecord + RBAC for console operators. */
const VENDOR_PERMISSIONS = [
  "console.view",
  "customer.manage",
  "entitlement.manage",
  "sync.operate",
  "rollout.manage",
  "platform.observe",
  "audit.view",
].map((name) => ({
  name,
  description: name,
  category: "vendor",
  is_dangerous: false,
  requires_step_up: false,
}));

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
}).strict();

const StepUpBody = z.object({ password: z.string().min(1).max(1024) }).strict();

export function registerAuthRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware } = ctx;

  app.post("/api/v1/auth/login", loginRateLimiter, async (req, res) => {
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
    const user = await db.get("SELECT id, email, password_hash FROM users WHERE lower(email) = lower(?)", email) as
      | { id: number; email: string; password_hash: string }
      | undefined;
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      observeAuthAttempt(Date.now() - startedAt, false);
      structuredLog("auth_login_failed", {
        reason: "invalid_credentials",
        status: 401,
        email,
      });
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const token = signVendorAdminToken(JWT_SECRET, user);
    observeAuthAttempt(Date.now() - startedAt, true);
    structuredLog("auth_login_success", {
      status: 200,
      user_id: user.id,
      email: user.email,
    });
    res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: VENDOR_ADMIN_TTL_SECONDS,
    });
  });

  /**
   * Privileged-action step-up: the operator re-enters their password and receives a short-lived
   * token bound to their user id, sent as X-Step-Up-Token on privileged requests
   * (see requirePrivilegedGuard). Interim control until TOTP lands (master plan Phase 4.1).
   */
  app.post("/api/v1/auth/step-up", authMiddleware, stepUpRateLimiter, async (req, res) => {
    const parsed = StepUpBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const userId = Number((req as AuthRequest).userId);
    const user = await db.get("SELECT id, password_hash FROM users WHERE id = ?", userId) as
      | { id: number; password_hash: string }
      | undefined;
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      structuredLog("auth_step_up_failed", { user_id: userId, status: 401 });
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const jti = newId("stepup");
    structuredLog("auth_step_up_success", { user_id: userId, step_up_id: jti });
    res.json({
      step_up_token: signStepUpToken(JWT_SECRET, user.id, jti),
      token_type: "StepUp",
      expires_in: STEP_UP_TTL_SECONDS,
    });
  });

  app.get("/api/v1/me/permissions", authMiddleware, async (_req, res) => {
    res.json(VENDOR_PERMISSIONS);
  });
}

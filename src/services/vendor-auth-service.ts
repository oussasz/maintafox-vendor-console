/**
 * Calls of the operator authentication API (control API routes/auth.ts, master plan Phase 4.1):
 * password → TOTP enrolment or verification → session; logout; step-up per action kind.
 * Errors carry the API's error code so the screens can explain what happened.
 */
import { z } from "zod";

import { apiBase } from "@/lib/api-base";
import { authFetch } from "@/lib/api-client";
import { endSession, setSession } from "@/lib/auth-session";
import type { StepUpActionKind } from "@/lib/step-up-kinds";

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (${status})`);
    this.name = "AuthApiError";
  }
}

const LoginResponse = z.object({
  status: z.enum(["mfa_enrollment_required", "mfa_required"]),
  mfa_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  /** After a server-side MFA reset: enrolment needs the one-time code the reset printed. */
  reset_code_required: z.boolean().optional(),
});
export type LoginStep = z.infer<typeof LoginResponse>;

const EnrolmentResponse = z.object({
  otpauth_uri: z.string().startsWith("otpauth://totp/"),
  secret_base32: z.string().min(16),
  account_name: z.string(),
});
export type TotpEnrolment = z.infer<typeof EnrolmentResponse>;

const SessionResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  session_expires_at: z.string(),
  recovery_codes: z.array(z.string()).optional(),
  recovery_codes_remaining: z.number().int().min(0).optional(),
});
export type SessionGrant = z.infer<typeof SessionResponse>;

const SessionInfo = z.object({
  user: z.object({ id: z.number(), email: z.string(), display_name: z.string().nullable().optional(), role: z.string().optional() }),
  session: z.object({ id: z.string(), created_at: z.string(), expires_at: z.string() }),
  mfa: z.object({ enrolled: z.boolean(), recovery_codes_remaining: z.number().int().min(0) }),
  step_up_ttl_seconds: z.number().int().positive(),
});
export type VendorSessionInfo = z.infer<typeof SessionInfo>;

const StepUpResponse = z.object({
  step_up_token: z.string().min(1),
  token_type: z.literal("StepUp"),
  action_kind: z.string(),
  expires_in: z.number().int().positive(),
});
export type StepUpGrant = { token: string; actionKind: StepUpActionKind; expiresAtMs: number };

async function errorOf(res: Response): Promise<AuthApiError> {
  let code = "request_failed";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) code = body.error;
  } catch {
    // Not JSON (proxy error page): keep the generic code with the status.
  }
  return new AuthApiError(res.status, code);
}

async function postAuth(path: string, init: { bearer?: string; body?: unknown }): Promise<Response> {
  return fetch(`${apiBase()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function parsed<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  if (!res.ok) throw await errorOf(res);
  return schema.parse(await res.json());
}

/** Step 1: email + password. The answer says whether to enrol or verify a TOTP code. */
export async function login(email: string, password: string): Promise<LoginStep> {
  return parsed(await postAuth("/api/v1/auth/login", { body: { email, password } }), LoginResponse);
}

export async function startTotpEnrolment(mfaToken: string, resetCode?: string): Promise<TotpEnrolment> {
  return parsed(
    await postAuth("/api/v1/auth/mfa/enroll/start", {
      bearer: mfaToken,
      body: resetCode ? { reset_code: resetCode } : undefined,
    }),
    EnrolmentResponse,
  );
}

/** Confirms enrolment; the session starts and the recovery codes are returned (shown once). */
export async function confirmTotpEnrolment(mfaToken: string, code: string): Promise<SessionGrant> {
  const grant = await parsed(await postAuth("/api/v1/auth/mfa/enroll/confirm", { bearer: mfaToken, body: { code } }), SessionResponse);
  setSession(grant.access_token, grant.expires_in);
  return grant;
}

export async function verifyTotp(mfaToken: string, code: string): Promise<SessionGrant> {
  const grant = await parsed(await postAuth("/api/v1/auth/mfa/verify", { bearer: mfaToken, body: { code } }), SessionResponse);
  setSession(grant.access_token, grant.expires_in);
  return grant;
}

export async function verifyRecoveryCode(mfaToken: string, recoveryCode: string): Promise<SessionGrant> {
  const grant = await parsed(
    await postAuth("/api/v1/auth/mfa/verify", { bearer: mfaToken, body: { recovery_code: recoveryCode } }),
    SessionResponse,
  );
  setSession(grant.access_token, grant.expires_in);
  return grant;
}

export async function getSessionInfo(): Promise<VendorSessionInfo> {
  return parsed(await authFetch("/api/v1/auth/session"), SessionInfo);
}

/** Ends this browser's session (server revokes it, cookie cleared). */
export async function logout(): Promise<void> {
  try {
    const res = await postAuth("/api/v1/auth/logout", {});
    if (!res.ok) throw await errorOf(res);
  } finally {
    endSession();
  }
}

/** Ends every session of this operator on every browser; returns how many were open. */
export async function logoutEverywhere(): Promise<number> {
  const res = await authFetch("/api/v1/auth/logout-all", { method: "POST" });
  const body = await parsed(res, z.object({ sessions_revoked: z.number().int().min(0) }));
  endSession();
  return body.sessions_revoked;
}

/** Exchanges a fresh TOTP code for a step-up token valid for `actionKind` only. */
export async function requestStepUp(actionKind: StepUpActionKind, code: string): Promise<StepUpGrant> {
  const res = await authFetch("/api/v1/auth/step-up", {
    method: "POST",
    body: JSON.stringify({ action_kind: actionKind, code }),
  });
  const body = await parsed(res, StepUpResponse);
  return { token: body.step_up_token, actionKind, expiresAtMs: Date.now() + body.expires_in * 1000 };
}

/** Replaces the operator's recovery codes (step-up `own_mfa_change`); returns the new ones. */
export async function regenerateRecoveryCodes(input: { reason: string; stepUpToken: string }): Promise<string[]> {
  const res = await authFetch("/api/v1/auth/mfa/recovery-codes", {
    method: "POST",
    headers: { "X-Operator-Reason": input.reason, "X-Step-Up-Token": input.stepUpToken },
  });
  return (await parsed(res, z.object({ recovery_codes: z.array(z.string()) }))).recovery_codes;
}

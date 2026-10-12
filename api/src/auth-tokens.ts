/**
 * JWT issuance and verification for the control API.
 *
 * Four token kinds share the HS256 `JWT_SECRET` but are cryptographically
 * scoped by `aud` + `kind`, so a token minted for one purpose is rejected
 * everywhere else:
 *   - vendor_admin       : console operators, short-lived, bound to a server-side session
 *                          (renewed through the refresh cookie, vendor-auth/service.ts)
 *   - vendor_mfa_pending : password verified, second factor not yet (TOTP enrol / verify only)
 *   - activation         : desktop machines (activation claim) → sync / activation routes
 *   - step_up            : short-lived proof of a fresh TOTP code for one privileged action kind
 */
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";

export const TOKEN_ISSUER = "maintafox-control-api";
export const AUD_VENDOR_ADMIN = "maintafox-vendor-admin";
export const AUD_DESKTOP_DEVICE = "maintafox-desktop-device";
export const AUD_STEP_UP = "maintafox-step-up";
export const AUD_VENDOR_MFA = "maintafox-vendor-mfa";

/** Access token lifetime (Rust VendorAdminSessionContract::access_token_ttl_minutes). */
export const VENDOR_ADMIN_TTL_SECONDS = 15 * 60;
/** Time to finish the second factor (or enrolment) after the password was accepted. */
export const VENDOR_MFA_PENDING_TTL_SECONDS = 10 * 60;
export const DEVICE_ACTIVATION_TTL_SECONDS = 30 * 24 * 3600;
export const STEP_UP_TTL_SECONDS = 5 * 60;

export type VendorAdminClaims = { userId: number; email: string; sessionId: string };

/** `enroll`: the operator has no second factor yet and must enrol; `verify`: they must enter a code. */
export type VendorMfaStage = "enroll" | "verify";
export type VendorMfaClaims = { userId: number; stage: VendorMfaStage };

export type DeviceActivationClaims = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
};

/** Verified device token claims plus its issue time (seconds since epoch, from `iat`). */
export type VerifiedDeviceActivationClaims = DeviceActivationClaims & { issuedAt: number };

/** A device token older than this is replaced (and the old one invalidated) on policy refresh. */
export const DEVICE_TOKEN_ROTATE_AFTER_SECONDS = 7 * 24 * 3600;

export type StepUpClaims = { userId: number; sessionId: string; actionKind: string; jti: string };

export function signVendorAdminToken(secret: string, user: { id: number; email: string }, sessionId: string): string {
  return jwt.sign({ kind: "vendor_admin", email: user.email, sid: sessionId }, secret, {
    algorithm: "HS256",
    subject: String(user.id),
    issuer: TOKEN_ISSUER,
    audience: AUD_VENDOR_ADMIN,
    expiresIn: VENDOR_ADMIN_TTL_SECONDS,
  });
}

/** Returns claims, or null when the token is invalid, expired, or not a vendor-admin token. */
export function verifyVendorAdminToken(secret: string, token: string): VendorAdminClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: AUD_VENDOR_ADMIN,
    }) as jwt.JwtPayload;
    if (payload.kind !== "vendor_admin" || typeof payload.email !== "string" || typeof payload.sid !== "string") return null;
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !payload.sid) return null;
    return { userId, email: payload.email, sessionId: payload.sid };
  } catch {
    return null;
  }
}

export function signVendorMfaToken(secret: string, claims: VendorMfaClaims): string {
  return jwt.sign({ kind: "vendor_mfa_pending", stage: claims.stage }, secret, {
    algorithm: "HS256",
    subject: String(claims.userId),
    issuer: TOKEN_ISSUER,
    audience: AUD_VENDOR_MFA,
    expiresIn: VENDOR_MFA_PENDING_TTL_SECONDS,
  });
}

/** Returns claims, or null when the token is invalid, expired, or not an MFA-pending token. */
export function verifyVendorMfaToken(secret: string, token: string): VendorMfaClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: AUD_VENDOR_MFA,
    }) as jwt.JwtPayload;
    if (payload.kind !== "vendor_mfa_pending" || (payload.stage !== "enroll" && payload.stage !== "verify")) return null;
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    return { userId, stage: payload.stage };
  } catch {
    return null;
  }
}

export function signDeviceActivationToken(secret: string, claims: DeviceActivationClaims): string {
  return jwt.sign(
    {
      kind: "activation",
      tenant_id: claims.tenantId,
      license_id: claims.licenseId,
      machine_fingerprint: claims.machineFingerprint,
    },
    secret,
    {
      algorithm: "HS256",
      issuer: TOKEN_ISSUER,
      audience: AUD_DESKTOP_DEVICE,
      expiresIn: DEVICE_ACTIVATION_TTL_SECONDS,
      // Unique per issue: a token renewed within the same second still differs (the desktop
      // resumes a refused sync only when its token changes, routes/activation.ts policy-refresh).
      jwtid: randomUUID(),
    },
  );
}

/** Returns claims, or null when the token is invalid, expired, or not a device activation token. */
export function verifyDeviceActivationToken(
  secret: string,
  token: string,
): VerifiedDeviceActivationClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: AUD_DESKTOP_DEVICE,
    }) as jwt.JwtPayload;
    if (
      payload.kind !== "activation" ||
      typeof payload.tenant_id !== "string" ||
      typeof payload.license_id !== "string" ||
      typeof payload.machine_fingerprint !== "string" ||
      typeof payload.iat !== "number" ||
      !payload.tenant_id ||
      !payload.license_id ||
      !payload.machine_fingerprint
    ) {
      return null;
    }
    return {
      tenantId: payload.tenant_id,
      licenseId: payload.license_id,
      machineFingerprint: payload.machine_fingerprint,
      issuedAt: payload.iat,
    };
  } catch {
    return null;
  }
}

export function signStepUpToken(secret: string, claims: StepUpClaims): string {
  return jwt.sign({ kind: "step_up", act: claims.actionKind, sid: claims.sessionId }, secret, {
    algorithm: "HS256",
    subject: String(claims.userId),
    issuer: TOKEN_ISSUER,
    audience: AUD_STEP_UP,
    expiresIn: STEP_UP_TTL_SECONDS,
    jwtid: claims.jti,
  });
}

export type StepUpVerification =
  | { ok: true; claims: StepUpClaims }
  | { ok: false; reason: "invalid_or_expired_step_up_token" | "step_up_action_kind_mismatch" };

/**
 * Accepts the step-up token only when it is valid, unexpired, issued to `expected.userId` in the
 * same session, and for `expected.actionKind`. Binding to the caller and session prevents replaying
 * another operator's (or a logged-out session's) proof; binding to the kind prevents spending a
 * proof given for one action on another.
 */
export function verifyStepUpToken(
  secret: string,
  token: string,
  expected: { userId: number; sessionId: string; actionKind: string },
): StepUpVerification {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: AUD_STEP_UP,
    }) as jwt.JwtPayload;
  } catch {
    return { ok: false, reason: "invalid_or_expired_step_up_token" };
  }
  if (
    payload.kind !== "step_up" ||
    typeof payload.jti !== "string" ||
    typeof payload.act !== "string" ||
    Number(payload.sub) !== expected.userId ||
    payload.sid !== expected.sessionId
  ) {
    return { ok: false, reason: "invalid_or_expired_step_up_token" };
  }
  if (payload.act !== expected.actionKind) return { ok: false, reason: "step_up_action_kind_mismatch" };
  return {
    ok: true,
    claims: { userId: expected.userId, sessionId: expected.sessionId, actionKind: payload.act, jti: payload.jti },
  };
}

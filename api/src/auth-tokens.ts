/**
 * JWT issuance and verification for the control API.
 *
 * Three token kinds share the HS256 `JWT_SECRET` but are cryptographically
 * scoped by `aud` + `kind`, so a token minted for one purpose is rejected
 * everywhere else:
 *   - vendor_admin : console operators (login)
 *   - activation   : desktop machines (activation claim) → sync / activation routes
 *   - step_up      : short-lived re-authentication proof for privileged actions
 */
import jwt from "jsonwebtoken";

export const TOKEN_ISSUER = "maintafox-control-api";
export const AUD_VENDOR_ADMIN = "maintafox-vendor-admin";
export const AUD_DESKTOP_DEVICE = "maintafox-desktop-device";
export const AUD_STEP_UP = "maintafox-step-up";

export const VENDOR_ADMIN_TTL_SECONDS = 12 * 3600;
export const DEVICE_ACTIVATION_TTL_SECONDS = 30 * 24 * 3600;
export const STEP_UP_TTL_SECONDS = 5 * 60;

export type VendorAdminClaims = { userId: number; email: string };

export type DeviceActivationClaims = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
};

/** Verified device token claims plus its issue time (seconds since epoch, from `iat`). */
export type VerifiedDeviceActivationClaims = DeviceActivationClaims & { issuedAt: number };

/** A device token older than this is replaced (and the old one invalidated) on policy refresh. */
export const DEVICE_TOKEN_ROTATE_AFTER_SECONDS = 7 * 24 * 3600;

export type StepUpClaims = { userId: number; jti: string };

export function signVendorAdminToken(secret: string, user: { id: number; email: string }): string {
  return jwt.sign({ kind: "vendor_admin", email: user.email }, secret, {
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
    if (payload.kind !== "vendor_admin" || typeof payload.email !== "string") return null;
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    return { userId, email: payload.email };
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

export function signStepUpToken(secret: string, userId: number, jti: string): string {
  return jwt.sign({ kind: "step_up" }, secret, {
    algorithm: "HS256",
    subject: String(userId),
    issuer: TOKEN_ISSUER,
    audience: AUD_STEP_UP,
    expiresIn: STEP_UP_TTL_SECONDS,
    jwtid: jti,
  });
}

/**
 * Returns claims when the step-up token is valid, unexpired, and was issued to `expectedUserId`.
 * Binding to the caller prevents one operator from replaying another operator's step-up proof.
 */
export function verifyStepUpToken(secret: string, token: string, expectedUserId: number): StepUpClaims | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: AUD_STEP_UP,
    }) as jwt.JwtPayload;
    if (payload.kind !== "step_up" || typeof payload.jti !== "string") return null;
    if (Number(payload.sub) !== expectedUserId) return null;
    return { userId: expectedUserId, jti: payload.jti };
  } catch {
    return null;
  }
}

/**
 * Vendor-console operator sessions and second factor (master plan Phase 4.1), bound to the API
 * database: TOTP enrolment and verification, recovery codes, server-side sessions with rotating
 * refresh tokens (reuse revokes the session), logout and logout everywhere, MFA reset.
 *
 * Every state change that matters for security is appended to the audit ledger by the caller
 * (routes/auth.ts, tools/vendor-mfa-reset.ts) with the outcome returned here.
 */
import { randomBytes, randomInt } from "node:crypto";

import type { Database } from "../db/database.js";
import { newId, sha256Hex } from "../app/runtime.js";
import { PayloadCipher } from "../sync/index.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";

/** Absolute session lifetime: the operator signs in again (password + TOTP) at least this often. */
export const VENDOR_SESSION_MAX_AGE_SECONDS = 12 * 3600;
/**
 * An exchanged refresh token presented again within this time, while its successor is still unused,
 * is a lost response (network drop, tab closed mid-refresh), not a stolen copy: refused, but the
 * session is not revoked and no theft is reported.
 */
export const VENDOR_REFRESH_LOST_RESPONSE_GRACE_SECONDS = 10;
/** A refresh token not exchanged within this time is dead (closed browser, idle console). */
export const VENDOR_REFRESH_IDLE_SECONDS = 2 * 3600;
export const RECOVERY_CODE_COUNT = 10;
/** Unambiguous characters (no 0/O, 1/I/L): 31 symbols, 10 per code ≈ 49.5 bits. */
const RECOVERY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RECOVERY_CODE_GROUP = 5;
const REFRESH_TOKEN_BYTES = 32;
/** Shown by authenticator apps as the account's issuer. */
export const TOTP_ISSUER = "Maintafox Vendor Console";
/** HKDF info for the subkey that seals TOTP secrets (vendor-auth only, never sync payloads). */
export const TOTP_SEAL_KEY_INFO = "maintafox/vendor-totp/v1";

export type VendorUser = {
  id: number;
  email: string;
  password_hash: string;
  totp_enrolled: boolean;
  /** Re-enrolment after a server-side MFA reset needs the one-time code the CLI printed. */
  reset_code_required: boolean;
};

export type SessionStart = { sessionId: string; refreshToken: string; expiresAt: Date };

export type RefreshOutcome =
  | { kind: "rotated"; userId: number; sessionId: string; refreshToken: string; sessionExpiresAt: Date }
  | { kind: "reuse_detected"; userId: number; sessionId: string }
  | { kind: "lost_response"; userId: number; sessionId: string }
  | { kind: "invalid" };

type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  totp_enrolled_at: string | null;
  mfa_reset_code_sha256: string | null;
};
const USER_COLUMNS = "id, email, password_hash, totp_enrolled_at, mfa_reset_code_sha256";

function toVendorUser(row: UserRow | undefined): VendorUser | undefined {
  return (
    row && {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      totp_enrolled: row.totp_enrolled_at !== null,
      reset_code_required: row.mfa_reset_code_sha256 !== null,
    }
  );
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function newRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < RECOVERY_CODE_GROUP * 2; i += 1) {
    raw += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, RECOVERY_CODE_GROUP)}-${raw.slice(RECOVERY_CODE_GROUP)}`;
}

function totpAad(userId: number): string {
  return `vendor-totp|${userId}`;
}

/** Only sealed values: a plaintext secret planted in the column must never be accepted. */
function requireSealed(stored: string): string {
  if (!PayloadCipher.isSealed(stored)) throw new Error("stored TOTP secret is not sealed; reset this operator's MFA");
  return stored;
}

export function createVendorAuth(db: Database, payloadCipher: PayloadCipher) {
  const totpCipher = payloadCipher.derive(TOTP_SEAL_KEY_INFO);

  async function findUserByEmail(email: string): Promise<VendorUser | undefined> {
    return toVendorUser(
      await db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?)`, email),
    );
  }

  async function getUser(userId: number): Promise<VendorUser | undefined> {
    return toVendorUser(await db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId));
  }

  /** Creates (or replaces) the pending secret shown during enrolment; returns the QR URI and the secret. */
  async function beginTotpEnrolment(user: VendorUser): Promise<{ otpauthUri: string; secretBase32: string }> {
    const secret = generateTotpSecret();
    await db.run(
      "UPDATE users SET totp_pending_sealed = ? WHERE id = ?",
      totpCipher.seal(secret.toString("base64"), totpAad(user.id)),
      user.id,
    );
    const uri = otpauthUri({ issuer: TOTP_ISSUER, accountName: user.email, secret });
    return { otpauthUri: uri, secretBase32: new URL(uri).searchParams.get("secret")! };
  }

  /**
   * Confirms enrolment with a code from the pending secret: the secret becomes active and a fresh
   * set of recovery codes is returned (shown once). Null when the code does not match.
   */
  async function confirmTotpEnrolment(userId: number, code: string, nowSeconds: number): Promise<string[] | null> {
    return db.tx(async () => {
      const row = await db.get<{ totp_pending_sealed: string | null }>(
        "SELECT totp_pending_sealed FROM users WHERE id = ? FOR UPDATE",
        userId,
      );
      if (!row?.totp_pending_sealed) return null;
      const secret = Buffer.from(totpCipher.open(requireSealed(row.totp_pending_sealed), totpAad(userId)), "base64");
      const step = verifyTotp(secret, code, nowSeconds, null);
      if (step === null) return null;
      await db.run(
        `UPDATE users SET totp_secret_sealed = totp_pending_sealed, totp_pending_sealed = NULL,
           totp_enrolled_at = now(), totp_last_step = ?, mfa_reset_code_sha256 = NULL WHERE id = ?`,
        step,
        userId,
      );
      return replaceRecoveryCodes(userId);
    });
  }

  /**
   * Verifies a TOTP code of an enrolled operator. The accepted step is recorded under a row lock in
   * the same transaction, so one code is never accepted twice, even by concurrent requests.
   */
  async function verifyTotpCode(userId: number, code: string, nowSeconds: number): Promise<boolean> {
    return db.tx(async () => {
      const row = await db.get<{ totp_secret_sealed: string | null; totp_last_step: string | number | null }>(
        "SELECT totp_secret_sealed, totp_last_step FROM users WHERE id = ? FOR UPDATE",
        userId,
      );
      if (!row?.totp_secret_sealed) return false;
      const secret = Buffer.from(totpCipher.open(requireSealed(row.totp_secret_sealed), totpAad(userId)), "base64");
      const lastStep = row.totp_last_step === null ? null : Number(row.totp_last_step);
      const step = verifyTotp(secret, code, nowSeconds, lastStep);
      if (step === null) return false;
      await db.run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, userId);
      return true;
    });
  }

  /** Spends one unused recovery code; returns the number left, or null when the code is not valid. */
  async function useRecoveryCode(userId: number, code: string): Promise<number | null> {
    const hash = sha256Hex(normalizeRecoveryCode(code));
    return db.tx(async () => {
      const spent = await db.run(
        "UPDATE vendor_recovery_codes SET used_at = now() WHERE user_id = ? AND code_sha256 = ? AND used_at IS NULL",
        userId,
        hash,
      );
      if (spent.changes !== 1) return null;
      return remainingRecoveryCodes(userId);
    });
  }

  async function remainingRecoveryCodes(userId: number): Promise<number> {
    const row = await db.get<{ n: string | number }>(
      "SELECT count(*) AS n FROM vendor_recovery_codes WHERE user_id = ? AND used_at IS NULL",
      userId,
    );
    return Number(row?.n ?? 0);
  }

  /** Replaces every recovery code of the operator; returns the new codes (the only time they exist in clear). */
  async function replaceRecoveryCodes(userId: number): Promise<string[]> {
    return db.tx(async () => {
      await db.run("DELETE FROM vendor_recovery_codes WHERE user_id = ?", userId);
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      for (const code of codes) {
        await db.run(
          "INSERT INTO vendor_recovery_codes (user_id, code_sha256) VALUES (?, ?)",
          userId,
          sha256Hex(normalizeRecoveryCode(code)),
        );
      }
      return codes;
    });
  }

  async function issueRefreshToken(sessionId: string): Promise<{ token: string; hash: string }> {
    const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const hash = sha256Hex(token);
    await db.run("INSERT INTO vendor_refresh_tokens (token_sha256, session_id) VALUES (?, ?)", hash, sessionId);
    return { token, hash };
  }

  async function startSession(userId: number, client: { ip: string | null; userAgent: string | null }): Promise<SessionStart> {
    return db.tx(async () => {
      const sessionId = newId("vsess");
      const expiresAt = new Date(Date.now() + VENDOR_SESSION_MAX_AGE_SECONDS * 1000);
      await db.run(
        `INSERT INTO vendor_sessions (id, user_id, expires_at, created_ip, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        sessionId,
        userId,
        expiresAt.toISOString(),
        client.ip,
        client.userAgent?.slice(0, 512) ?? null,
      );
      return { sessionId, refreshToken: (await issueRefreshToken(sessionId)).token, expiresAt };
    });
  }

  /**
   * Exchanges a refresh token for a new one. A token that was already exchanged is reuse (a stolen
   * copy, or a replay): the whole session is revoked so neither holder can continue — unless it is a
   * lost response (VENDOR_REFRESH_LOST_RESPONSE_GRACE_SECONDS, successor unused): refused only.
   */
  async function rotateRefreshToken(token: string): Promise<RefreshOutcome> {
    const hash = sha256Hex(token);
    return db.tx(async () => {
      const row = await db.get<{
        session_id: string;
        rotated_at: Date | null;
        replaced_by_sha256: string | null;
        successor_rotated_at: Date | null;
        issued_at: Date;
        user_id: number;
        expires_at: Date;
        revoked_at: string | null;
      }>(
        `SELECT r.session_id, r.rotated_at, r.replaced_by_sha256, n.rotated_at AS successor_rotated_at,
                r.issued_at, s.user_id, s.expires_at, s.revoked_at
         FROM vendor_refresh_tokens r
         JOIN vendor_sessions s ON s.id = r.session_id
         LEFT JOIN vendor_refresh_tokens n ON n.token_sha256 = r.replaced_by_sha256
         WHERE r.token_sha256 = ? FOR UPDATE OF r, s`,
        hash,
      );
      if (!row) return { kind: "invalid" };
      if (row.rotated_at !== null) {
        const lostResponse =
          row.revoked_at === null &&
          row.replaced_by_sha256 !== null &&
          row.successor_rotated_at === null &&
          Date.now() - new Date(row.rotated_at).getTime() <= VENDOR_REFRESH_LOST_RESPONSE_GRACE_SECONDS * 1000;
        if (lostResponse) return { kind: "lost_response", userId: row.user_id, sessionId: row.session_id };
        await db.run(
          "UPDATE vendor_sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse' WHERE id = ? AND revoked_at IS NULL",
          row.session_id,
        );
        return { kind: "reuse_detected", userId: row.user_id, sessionId: row.session_id };
      }
      const now = Date.now();
      const idleExpired = now - new Date(row.issued_at).getTime() > VENDOR_REFRESH_IDLE_SECONDS * 1000;
      if (row.revoked_at !== null || new Date(row.expires_at).getTime() <= now || idleExpired) {
        return { kind: "invalid" };
      }
      const successor = await issueRefreshToken(row.session_id);
      await db.run(
        "UPDATE vendor_refresh_tokens SET rotated_at = now(), replaced_by_sha256 = ? WHERE token_sha256 = ?",
        successor.hash,
        hash,
      );
      await db.run("UPDATE vendor_sessions SET last_refreshed_at = now() WHERE id = ?", row.session_id);
      return {
        kind: "rotated",
        userId: row.user_id,
        sessionId: row.session_id,
        refreshToken: successor.token,
        sessionExpiresAt: new Date(row.expires_at),
      };
    });
  }

  /** The session of a presented refresh token (logout), without exchanging it. */
  async function sessionOfRefreshToken(token: string): Promise<{ sessionId: string; userId: number } | undefined> {
    const row = await db.get<{ session_id: string; user_id: number }>(
      `SELECT r.session_id, s.user_id FROM vendor_refresh_tokens r JOIN vendor_sessions s ON s.id = r.session_id
       WHERE r.token_sha256 = ?`,
      sha256Hex(token),
    );
    return row && { sessionId: row.session_id, userId: row.user_id };
  }

  async function getSession(sessionId: string): Promise<{ id: string; createdAt: string; expiresAt: string } | undefined> {
    const row = await db.get<{ id: string; created_at: Date; expires_at: Date }>(
      "SELECT id, created_at, expires_at FROM vendor_sessions WHERE id = ?",
      sessionId,
    );
    return row && { id: row.id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  }

  /** True while the session exists, belongs to the operator, is not revoked and not expired. */
  async function isSessionActive(sessionId: string, userId: number): Promise<boolean> {
    const row = await db.get<{ ok: boolean }>(
      `SELECT (revoked_at IS NULL AND expires_at > now()) AS ok
       FROM vendor_sessions WHERE id = ? AND user_id = ?`,
      sessionId,
      userId,
    );
    return row?.ok === true;
  }

  async function revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const r = await db.run(
      "UPDATE vendor_sessions SET revoked_at = now(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL",
      reason,
      sessionId,
    );
    return r.changes === 1;
  }

  /** Revokes every open session of the operator; returns how many were open. */
  async function revokeAllSessions(userId: number, reason: string): Promise<number> {
    const r = await db.run(
      "UPDATE vendor_sessions SET revoked_at = now(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL",
      reason,
      userId,
    );
    return r.changes;
  }

  /**
   * Removes the operator's second factor and recovery codes and ends every session: the next login
   * goes through TOTP enrolment again. Used by the lost-authenticator recovery (CLI) and the
   * operator admin (4.3). Re-enrolment then needs the returned one-time reset code (given to the
   * operator out of band), so someone who only knows the password cannot claim the account.
   */
  async function resetMfa(userId: number, reason: string): Promise<{ sessionsRevoked: number; resetCode: string }> {
    const resetCode = newRecoveryCode();
    return db.tx(async () => {
      await db.run(
        `UPDATE users SET totp_secret_sealed = NULL, totp_pending_sealed = NULL, totp_enrolled_at = NULL,
           totp_last_step = NULL, mfa_reset_code_sha256 = ? WHERE id = ?`,
        sha256Hex(normalizeRecoveryCode(resetCode)),
        userId,
      );
      await db.run("DELETE FROM vendor_recovery_codes WHERE user_id = ?", userId);
      return { sessionsRevoked: await revokeAllSessions(userId, reason), resetCode };
    });
  }

  /** True when `code` is the operator's pending MFA reset code (compared by hash). */
  async function checkResetCode(userId: number, code: string): Promise<boolean> {
    const row = await db.get<{ ok: boolean }>(
      "SELECT mfa_reset_code_sha256 = ? AS ok FROM users WHERE id = ?",
      sha256Hex(normalizeRecoveryCode(code)),
      userId,
    );
    return row?.ok === true;
  }

  return {
    findUserByEmail,
    getUser,
    beginTotpEnrolment,
    confirmTotpEnrolment,
    verifyTotpCode,
    useRecoveryCode,
    remainingRecoveryCodes,
    replaceRecoveryCodes,
    startSession,
    rotateRefreshToken,
    sessionOfRefreshToken,
    getSession,
    isSessionActive,
    revokeSession,
    revokeAllSessions,
    resetMfa,
    checkResetCode,
  };
}

export type VendorAuth = ReturnType<typeof createVendorAuth>;

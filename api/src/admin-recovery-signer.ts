/**
 * Administrator recovery codes (decision register 2026-10-19, "No active administrator left on a
 * PC", part a): a vendor-signed, single-use code bound to one PC activation that lets that PC open
 * "create an administrator" once after it has lost every active administrator.
 *
 * Format agreed with the desktop licensing verifier (byte for byte):
 *
 *   MFXREC1.<payload_b64url_no_padding>.<signature_lowercase_hex>
 *
 * payload   = UTF-8 canonical JSON, keys in exactly the order of `canonicalAdminRecoveryPayload`.
 * signature = Ed25519 over `"maintafox-admin-recovery:v1\n" + payload_json` (the prefix separates
 *             these signatures from entitlement envelope signatures made with the same key).
 * Timestamps are `Date.prototype.toISOString()` (RFC 3339 UTC with milliseconds, e.g.
 * 2026-10-19T08:30:00.000Z), as for entitlement envelopes; expires_at = issued_at + 24 h.
 *
 * Signed with the entitlement signing key (same key_id, issuer "maintafox-vps"): the desktop pins
 * the same public keys. Single use is enforced by the desktop (it records the code_id it used).
 */
import { randomUUID, sign as cryptoSign } from "node:crypto";

import { ENTITLEMENT_ISSUER, loadEntitlementSigningKey, type EntitlementSigningKey } from "./entitlement-signer.js";

export const ADMIN_RECOVERY_CODE_PREFIX = "MFXREC1";
export const ADMIN_RECOVERY_VERSION = 1;
export const ADMIN_RECOVERY_PURPOSE = "admin_recovery";
export const ADMIN_RECOVERY_SIGNATURE_ALG = "ed25519:admin-recovery:v1";
/** Domain separation: prepended to the payload JSON before signing. */
export const ADMIN_RECOVERY_SIGNING_DOMAIN = "maintafox-admin-recovery:v1\n";
export const ADMIN_RECOVERY_TTL_HOURS = 24;

export type AdminRecoveryPayload = {
  v: 1;
  purpose: typeof ADMIN_RECOVERY_PURPOSE;
  code_id: string;
  tenant_id: string;
  machine_fingerprint: string;
  license_id: string;
  issuer: string;
  key_id: string;
  signature_alg: typeof ADMIN_RECOVERY_SIGNATURE_ALG;
  issued_at: string;
  expires_at: string;
};

/** Canonical payload JSON: explicit key order (the desktop re-serialises and compares bytes). */
export function canonicalAdminRecoveryPayload(p: AdminRecoveryPayload): string {
  return JSON.stringify({
    v: p.v,
    purpose: p.purpose,
    code_id: p.code_id,
    tenant_id: p.tenant_id,
    machine_fingerprint: p.machine_fingerprint,
    license_id: p.license_id,
    issuer: p.issuer,
    key_id: p.key_id,
    signature_alg: p.signature_alg,
    issued_at: p.issued_at,
    expires_at: p.expires_at,
  });
}

/** The exact bytes the signature covers. */
export function adminRecoverySignedMessage(payloadJson: string): Buffer {
  return Buffer.from(ADMIN_RECOVERY_SIGNING_DOMAIN + payloadJson, "utf8");
}

/** Ed25519 signature (lowercase hex, 128 chars) over the domain-separated payload. */
export function signAdminRecoveryPayload(payloadJson: string, key: EntitlementSigningKey): string {
  return cryptoSign(null, adminRecoverySignedMessage(payloadJson), key.privateKey).toString("hex");
}

/** `MFXREC1.<base64url(payload) without padding>.<hex signature>`. */
export function encodeAdminRecoveryCode(payloadJson: string, signatureHex: string): string {
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) throw new Error("signature must be 64 bytes of lowercase hex");
  const b64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  return `${ADMIN_RECOVERY_CODE_PREFIX}.${b64}.${signatureHex}`;
}

export function addHoursToIso(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

export type AdminRecoveryCodeInput = {
  tenantId: string;
  machineFingerprint: string;
  licenseId: string;
  /** Defaults to now. */
  issuedAt?: Date;
  /** Defaults to a fresh UUID v4 (tests and the cross-language vector pass a fixed one). */
  codeId?: string;
};

export type SignedAdminRecoveryCode = {
  code: string;
  payload: AdminRecoveryPayload;
  payloadJson: string;
  signature: string;
};

export function buildAdminRecoveryCode(
  input: AdminRecoveryCodeInput,
  key: EntitlementSigningKey = loadEntitlementSigningKey(),
): SignedAdminRecoveryCode {
  for (const [name, value] of [
    ["tenantId", input.tenantId],
    ["machineFingerprint", input.machineFingerprint],
    ["licenseId", input.licenseId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  }
  const issuedAt = (input.issuedAt ?? new Date()).toISOString();
  const payload: AdminRecoveryPayload = {
    v: ADMIN_RECOVERY_VERSION,
    purpose: ADMIN_RECOVERY_PURPOSE,
    code_id: input.codeId ?? randomUUID(),
    tenant_id: input.tenantId,
    // Byte for byte as stored in machine_activations: the desktop compares it with its claim.
    machine_fingerprint: input.machineFingerprint,
    license_id: input.licenseId,
    issuer: ENTITLEMENT_ISSUER,
    key_id: key.keyId,
    signature_alg: ADMIN_RECOVERY_SIGNATURE_ALG,
    issued_at: issuedAt,
    expires_at: addHoursToIso(issuedAt, ADMIN_RECOVERY_TTL_HOURS),
  };
  const payloadJson = canonicalAdminRecoveryPayload(payload);
  const signature = signAdminRecoveryPayload(payloadJson, key);
  return { code: encodeAdminRecoveryCode(payloadJson, signature), payload, payloadJson, signature };
}

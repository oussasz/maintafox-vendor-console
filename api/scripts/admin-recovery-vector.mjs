/**
 * Emits the cross-language test vector for administrator recovery codes, signed by the production
 * signer (api/src/admin-recovery-signer.ts) with the TEST-ONLY key. The desktop verifier checks it
 * in its tests: same canonical payload bytes, same signed message, Ed25519 accepts the signature,
 * and the tampered variant is refused.
 *
 *   pnpm run build && node scripts/admin-recovery-vector.mjs [output.json]
 *
 * Default output: api/testdata/admin-recovery-vector.json (committed; scripts/admin-recovery-signer.mjs
 * checks that regenerating gives the same file).
 */
import { sign as cryptoSign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_RECOVERY_CODE_PREFIX,
  ADMIN_RECOVERY_SIGNATURE_ALG,
  ADMIN_RECOVERY_SIGNING_DOMAIN,
  ADMIN_RECOVERY_TTL_HOURS,
  adminRecoverySignedMessage,
  addHoursToIso,
  buildAdminRecoveryCode,
  canonicalAdminRecoveryPayload,
  encodeAdminRecoveryCode,
  signAdminRecoveryPayload,
} from "../dist/admin-recovery-signer.js";
import { ENTITLEMENT_ISSUER, parseEntitlementSigningKey } from "../dist/entitlement-signer.js";
import { TEST_ENTITLEMENT_KEY_ID, TEST_ENTITLEMENT_PRIVATE_KEY_B64, TEST_ENTITLEMENT_PUBLIC_KEY_HEX } from "./lib/test-signing-key.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VECTOR_PATH = join(here, "..", "testdata", "admin-recovery-vector.json");

/** Deterministic: fixed inputs, Ed25519 signatures are deterministic. */
export function buildAdminRecoveryVector() {
  const key = parseEntitlementSigningKey(TEST_ENTITLEMENT_KEY_ID, TEST_ENTITLEMENT_PRIVATE_KEY_B64);
  const signed = buildAdminRecoveryCode(
    {
      codeId: "3f6c1d2e-9a4b-4c7d-8e1f-2a3b4c5d6e7f",
      tenantId: "ten_vector_0001",
      machineFingerprint: "fp-vector-9c41e7b2a05d",
      licenseId: "lic_vector_0001",
      issuedAt: new Date("2026-10-19T08:30:00.000Z"),
    },
    key,
  );
  // Tampered: one payload byte changed (license_id ...0001 -> ...0002), original signature kept.
  const tamperedPayloadJson = signed.payloadJson.replace('"lic_vector_0001"', '"lic_vector_0002"');
  if (tamperedPayloadJson === signed.payloadJson) throw new Error("tamper did not change the payload");
  return {
    description:
      "Administrator recovery code signed by api/src/admin-recovery-signer.ts with the TEST-ONLY key " +
      "(api/scripts/lib/test-signing-key.mjs). Never trust this key outside tests.",
    format: `${ADMIN_RECOVERY_CODE_PREFIX}.<payload base64url, no padding>.<Ed25519 signature, lowercase hex>`,
    timestamp_format: "Date.prototype.toISOString(): RFC 3339 UTC with milliseconds, e.g. 2026-10-19T08:30:00.000Z",
    ttl_hours: ADMIN_RECOVERY_TTL_HOURS,
    issuer: ENTITLEMENT_ISSUER,
    key_id: TEST_ENTITLEMENT_KEY_ID,
    signature_alg: ADMIN_RECOVERY_SIGNATURE_ALG,
    public_key_hex: TEST_ENTITLEMENT_PUBLIC_KEY_HEX,
    signing_domain: ADMIN_RECOVERY_SIGNING_DOMAIN,
    payload: signed.payload,
    payload_json: signed.payloadJson,
    payload_b64url: Buffer.from(signed.payloadJson, "utf8").toString("base64url"),
    signed_message: adminRecoverySignedMessage(signed.payloadJson).toString("utf8"),
    signed_message_hex: adminRecoverySignedMessage(signed.payloadJson).toString("hex"),
    signature_hex: signed.signature,
    code: signed.code,
    tampered: {
      description: "license_id changed in the payload (one byte), original signature kept: must be refused (signature).",
      payload_json: tamperedPayloadJson,
      code: encodeAdminRecoveryCode(tamperedPayloadJson, signed.signature),
      expected: "invalid_signature",
    },
    refusal_codes: REFUSAL_CODES,
    extra_cases: buildExtraCases(key, signed.payload),
  };
}

/**
 * Names the vector uses for the result each case must produce (the desktop may name its errors
 * differently; the point is which check refuses). "valid" = accepted, given `now` and an
 * activation claim equal to the payload's tenant_id / machine_fingerprint / license_id.
 */
export const REFUSAL_CODES = {
  valid: "Accepted.",
  invalid_signature: "Ed25519 verification of \"maintafox-admin-recovery:v1\\n\" + payload_json fails.",
  non_canonical: "Re-serialising the decoded payload in the canonical key order does not give the same bytes.",
  wrong_purpose: "purpose is not \"admin_recovery\".",
  expired: "now >= expires_at.",
  issued_in_future: "issued_at > now + 5 minutes.",
};

/** Builds one case from a payload JSON string: signed over the domain-separated message unless `sig` is given. */
function caseOf(key, name, description, payloadJson, now, expected, sig) {
  const signature = sig ?? signAdminRecoveryPayload(payloadJson, key);
  return {
    name,
    description,
    now,
    expected,
    payload_json: payloadJson,
    signed_message_hex: adminRecoverySignedMessage(payloadJson).toString("hex"),
    signature_hex: signature,
    code: encodeAdminRecoveryCode(payloadJson, signature),
  };
}

function buildExtraCases(key, base) {
  const now = "2026-10-19T09:00:00.000Z";
  const escaped = buildAdminRecoveryCode(
    {
      codeId: "8d2e4f60-1a3b-4c5d-9e7f-0a1b2c3d4e5f",
      tenantId: base.tenant_id,
      // Double quote, backslash, control characters (U+0001, newline), non-ASCII (é, emoji), slash.
      machineFingerprint: 'fp-"q"\\b\u0001c\nd/\u00e9\u{1F600}',
      licenseId: base.license_id,
      issuedAt: new Date("2026-10-19T08:45:00.000Z"),
    },
    key,
  );
  const expiredIssued = "2026-10-17T08:30:00.000Z";
  const expiredPayload = canonicalAdminRecoveryPayload({
    ...base,
    code_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    issued_at: expiredIssued,
    expires_at: addHoursToIso(expiredIssued, 24),
  });
  const futureIssued = "2026-10-19T09:10:00.000Z";
  const futurePayload = canonicalAdminRecoveryPayload({
    ...base,
    code_id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    issued_at: futureIssued,
    expires_at: addHoursToIso(futureIssued, 24),
  });
  const wrongPurpose = canonicalAdminRecoveryPayload({ ...base, code_id: "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f", purpose: "entitlement" });
  // Same fields, `purpose` before `v`: valid JSON, correctly signed, but not canonical.
  const reordered = JSON.stringify({ purpose: base.purpose, ...base, code_id: "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a" });
  const bare = canonicalAdminRecoveryPayload({ ...base, code_id: "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b" });
  return [
    caseOf(key, "escaped_fingerprint", "machine_fingerprint with a double quote, a backslash, U+0001, a newline, é, an emoji and a slash (JSON escaping parity).", escaped.payloadJson, now, "valid", escaped.signature),
    caseOf(
      key,
      "bare_payload_signature",
      "A valid Ed25519 signature over the BARE payload (no domain prefix), e.g. an entitlement-style signature.",
      bare,
      now,
      "invalid_signature",
      cryptoSign(null, Buffer.from(bare, "utf8"), key.privateKey).toString("hex"),
    ),
    caseOf(key, "expired", "Correctly signed, expires_at (2026-10-18T08:30:00.000Z) is before now.", expiredPayload, now, "expired"),
    caseOf(key, "issued_in_future", "Correctly signed, issued_at is 10 minutes after now.", futurePayload, now, "issued_in_future"),
    caseOf(key, "wrong_purpose", "Correctly signed, purpose is \"entitlement\".", wrongPurpose, now, "wrong_purpose"),
    caseOf(key, "keys_reordered", "Correctly signed over a payload whose keys are not in the canonical order (purpose before v).", reordered, now, "non_canonical"),
  ];
}

export function serializeVector(vector) {
  return `${JSON.stringify(vector, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_VECTOR_PATH;
  writeFileSync(out, serializeVector(buildAdminRecoveryVector()));
  console.log(`Wrote ${out}`);
}

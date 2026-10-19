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
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_RECOVERY_CODE_PREFIX,
  ADMIN_RECOVERY_SIGNATURE_ALG,
  ADMIN_RECOVERY_SIGNING_DOMAIN,
  ADMIN_RECOVERY_TTL_HOURS,
  adminRecoverySignedMessage,
  buildAdminRecoveryCode,
  encodeAdminRecoveryCode,
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
  };
}

export function serializeVector(vector) {
  return `${JSON.stringify(vector, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_VECTOR_PATH;
  writeFileSync(out, serializeVector(buildAdminRecoveryVector()));
  console.log(`Wrote ${out}`);
}

/**
 * Emits a cross-language entitlement test vector signed by the production signer code with the
 * TEST-ONLY key. The desktop verifies it in entitlements tests, proving that
 * canonical_payload (Rust) == canonicalPayload (Node) byte-for-byte and that Ed25519
 * verification accepts the server's signatures.
 *
 *   pnpm run build && node scripts/entitlement-ed25519-vector.mjs <output.json>
 */
import { writeFileSync } from "node:fs";

import {
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_SIGNATURE_ALG,
  canonicalPayload,
  parseEntitlementSigningKey,
  signEnvelope,
} from "../dist/entitlement-signer.js";
import {
  TEST_ENTITLEMENT_KEY_ID,
  TEST_ENTITLEMENT_PRIVATE_KEY_B64,
  TEST_ENTITLEMENT_PUBLIC_KEY_HEX,
} from "./lib/test-signing-key.mjs";

const out = process.argv[2];
if (!out) {
  console.error("Usage: node scripts/entitlement-ed25519-vector.mjs <output.json>");
  process.exit(2);
}

const key = parseEntitlementSigningKey(TEST_ENTITLEMENT_KEY_ID, TEST_ENTITLEMENT_PRIVATE_KEY_B64);
const unsigned = {
  envelope_id: "env_vector_0001",
  previous_envelope_id: null,
  lineage_version: 1,
  issuer: ENTITLEMENT_ISSUER,
  key_id: TEST_ENTITLEMENT_KEY_ID,
  signature_alg: ENTITLEMENT_SIGNATURE_ALG,
  tier: "professional",
  state: "active",
  channel: "stable",
  machine_slots: 3,
  feature_flags_json: '{"beta":false}',
  // Non-ASCII and escaped characters exercise JSON string escaping parity.
  capabilities_json: '{"equipment":true,"planning":true,"note":"Équipe \\"A\\" / maintenance"}',
  policy_json: '{"grace_allowed_modules":["sync","equipment"]}',
  issued_at: "2026-10-10T00:00:00.000Z",
  valid_from: "2026-10-10T00:00:00.000Z",
  valid_until: "2099-01-01T00:00:00.000Z",
  offline_grace_until: "2099-01-04T00:00:00.000Z",
};

const vector = {
  description: "Ed25519 entitlement envelope signed by api/src/entitlement-signer.ts with the TEST-ONLY key.",
  public_key_hex: TEST_ENTITLEMENT_PUBLIC_KEY_HEX,
  canonical_payload: canonicalPayload(unsigned),
  envelope: { ...unsigned, signature: signEnvelope(unsigned, key) },
};
writeFileSync(out, `${JSON.stringify(vector, null, 2)}\n`);
console.log(`Wrote ${out}`);

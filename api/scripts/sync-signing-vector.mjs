/**
 * Per-user sync signing, without a database (sync-signing-design.md v9 §4, §7): the desktop's
 * cross-language vector (copied from maintafox-desktop src-tauri/src/auth/testdata) encodes byte
 * for byte here, its key id matches its public key, every signature verifies with the public key
 * only, and a changed payload or signer is refused.
 *
 *   pnpm run build && node scripts/sync-signing-vector.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  changeSigningMessage,
  decodePublicKey,
  enrolProofMessage,
  keyIdOf,
  verifyEd25519,
} from "../dist/sync/signing.js";

const vector = JSON.parse(
  readFileSync(new URL("../testdata/sync-signing-vector.json", import.meta.url), "utf8"),
);

const publicKey = decodePublicKey(vector.public_key_b64);
assert.ok(publicKey, "vector public key decodes");
assert.equal(keyIdOf(publicKey), vector.key_id, "key id is derived from the public key");

assert.ok(vector.changes.length > 0, "vector carries change signatures");
for (const change of vector.changes) {
  const i = change.input;
  const input = {
    tenantId: i.tenant_id,
    entityType: i.entity_type,
    entitySyncId: i.entity_sync_id,
    operation: i.operation,
    rowVersion: i.row_version,
    baseRowVersion: i.base_row_version,
    payloadJson: i.payload_json,
    signerUserSyncId: i.signer_user_sync_id,
    keyId: i.key_id,
  };
  const message = changeSigningMessage(input);
  assert.equal(message.toString("hex"), change.message_hex, `${i.entity_type} message bytes`);
  assert.ok(verifyEd25519(publicKey, message, change.signature_b64), `${i.entity_type} verifies`);
  const tampered = changeSigningMessage({ ...input, payloadJson: `${input.payloadJson} ` });
  assert.ok(!verifyEd25519(publicKey, tampered, change.signature_b64), "changed payload refused");
  const otherSigner = changeSigningMessage({ ...input, signerUserSyncId: "someone-else" });
  assert.ok(!verifyEd25519(publicKey, otherSigner, change.signature_b64), "other signer refused");
}

const e = vector.enrol.input;
const proof = enrolProofMessage(e.tenant_id, e.user_sync_id, e.key_id, e.machine_fingerprint);
assert.equal(proof.toString("hex"), vector.enrol.message_hex, "enrol proof bytes");
assert.ok(verifyEd25519(publicKey, proof, vector.enrol.signature_b64), "enrol proof verifies");
assert.ok(
  !verifyEd25519(publicKey, enrolProofMessage(e.tenant_id, e.user_sync_id, e.key_id, "other-pc"), vector.enrol.signature_b64),
  "enrol proof is bound to the PC",
);

console.log(`sync signing vector: ${vector.changes.length} change(s) + enrol proof verified`);

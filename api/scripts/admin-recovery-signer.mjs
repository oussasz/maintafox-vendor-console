/**
 * Administrator recovery codes, without a database: canonical payload byte for byte, domain
 * separated Ed25519 signature that verifies with the PUBLIC key only, base64url without padding,
 * lowercase hex, 24 h expiry; the committed cross-language vector regenerates identically and the
 * tampered variant is refused.
 *
 *   pnpm run build && node scripts/admin-recovery-signer.mjs
 */
import assert from "node:assert/strict";
import { createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  ADMIN_RECOVERY_SIGNING_DOMAIN,
  buildAdminRecoveryCode,
  canonicalAdminRecoveryPayload,
} from "../dist/admin-recovery-signer.js";
import { parseEntitlementSigningKey } from "../dist/entitlement-signer.js";
import { buildAdminRecoveryVector, DEFAULT_VECTOR_PATH, serializeVector } from "./admin-recovery-vector.mjs";
import {
  TEST_ENTITLEMENT_KEY_ID,
  TEST_ENTITLEMENT_PRIVATE_KEY_B64,
  TEST_ENTITLEMENT_PUBLIC_KEY_HEX,
  TEST_ENTITLEMENT_SIGNING_ENV,
} from "./lib/test-signing-key.mjs";

const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(TEST_ENTITLEMENT_PUBLIC_KEY_HEX, "hex")]),
  format: "der",
  type: "spki",
});

/** What the desktop does: split, decode, re-serialise, verify the domain-separated signature. */
function verifyCode(code) {
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== "MFXREC1") return { ok: false, why: "prefix" };
  const [, b64, sigHex] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) return { ok: false, why: "base64" };
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return { ok: false, why: "signature_format" };
  const payloadJson = Buffer.from(b64, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson);
  if (canonicalAdminRecoveryPayload(payload) !== payloadJson) return { ok: false, why: "canonical" };
  const message = Buffer.from(ADMIN_RECOVERY_SIGNING_DOMAIN + payloadJson, "utf8");
  if (!verify(null, message, publicKey, Buffer.from(sigHex, "hex"))) return { ok: false, why: "signature" };
  return { ok: true, payload, payloadJson };
}

const key = parseEntitlementSigningKey(TEST_ENTITLEMENT_KEY_ID, TEST_ENTITLEMENT_PRIVATE_KEY_B64);

// ── Canonical payload: exact bytes and key order ─────────────────────────────────────────
const fixed = buildAdminRecoveryCode(
  {
    codeId: "11111111-2222-4333-8444-555555555555",
    tenantId: "ten_a",
    machineFingerprint: "fp-A b\"c",
    licenseId: "lic_a",
    issuedAt: new Date("2026-10-19T10:00:00.000Z"),
  },
  key,
);
assert.equal(
  fixed.payloadJson,
  '{"v":1,"purpose":"admin_recovery","code_id":"11111111-2222-4333-8444-555555555555","tenant_id":"ten_a",' +
    '"machine_fingerprint":"fp-A b\\"c","license_id":"lic_a","issuer":"maintafox-vps","key_id":"test-ed25519-do-not-trust",' +
    '"signature_alg":"ed25519:admin-recovery:v1","issued_at":"2026-10-19T10:00:00.000Z","expires_at":"2026-10-20T10:00:00.000Z"}',
  "canonical payload byte for byte (key order, escaping, timestamp format)",
);
// Re-ordering the keys of the object does not change the canonical bytes.
const shuffled = Object.fromEntries(Object.entries(fixed.payload).reverse());
assert.equal(canonicalAdminRecoveryPayload(shuffled), fixed.payloadJson);

// ── Code string shape ─────────────────────────────────────────────────────────────────────
const [prefix, b64, sigHex, ...rest] = fixed.code.split(".");
assert.equal(prefix, "MFXREC1");
assert.equal(rest.length, 0);
assert.match(b64, /^[A-Za-z0-9_-]+$/, "base64url alphabet, no padding");
assert.ok(!b64.includes("="), "no padding");
assert.equal(Buffer.from(b64, "base64url").toString("utf8"), fixed.payloadJson);
assert.match(sigHex, /^[0-9a-f]{128}$/, "64-byte signature, lowercase hex");
assert.equal(sigHex, fixed.signature);

// ── Signature: domain separated, verifies with the public key only ───────────────────────
assert.ok(verifyCode(fixed.code).ok, "verifies with the public key");
assert.equal(
  verify(null, Buffer.from(fixed.payloadJson, "utf8"), publicKey, Buffer.from(sigHex, "hex")),
  false,
  "the signature does not verify over the bare payload (domain prefix is part of the message)",
);
assert.ok(
  verify(null, Buffer.from(`maintafox-admin-recovery:v1\n${fixed.payloadJson}`, "utf8"), publicKey, Buffer.from(sigHex, "hex")),
);
// An entitlement-style signature over the payload (no domain) is not a valid recovery code.
const sneaky = `MFXREC1.${b64}.${sign(null, Buffer.from(fixed.payloadJson), key.privateKey).toString("hex")}`;
assert.equal(verifyCode(sneaky).why, "signature");

// ── Expiry 24 h, defaults ─────────────────────────────────────────────────────────────────
Object.assign(process.env, TEST_ENTITLEMENT_SIGNING_ENV);
const before = Date.now();
const fresh = buildAdminRecoveryCode({ tenantId: "t", machineFingerprint: "fp", licenseId: "l" });
assert.equal(Date.parse(fresh.payload.expires_at) - Date.parse(fresh.payload.issued_at), 24 * 3_600_000);
assert.ok(Math.abs(Date.parse(fresh.payload.issued_at) - before) < 5_000);
assert.match(fresh.payload.issued_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
assert.match(fresh.payload.code_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUID v4");
assert.equal(fresh.payload.key_id, TEST_ENTITLEMENT_KEY_ID);
assert.equal(fresh.payload.issuer, "maintafox-vps");
assert.notEqual(buildAdminRecoveryCode({ tenantId: "t", machineFingerprint: "fp", licenseId: "l" }).payload.code_id, fresh.payload.code_id);
assert.throws(() => buildAdminRecoveryCode({ tenantId: "", machineFingerprint: "fp", licenseId: "l" }, key));

// ── Cross-language vector: committed file == regenerated, code verifies, tampered refused ──
const vector = buildAdminRecoveryVector();
const committed = readFileSync(DEFAULT_VECTOR_PATH, "utf8").replace(/\r\n/g, "\n");
assert.equal(committed, serializeVector(vector), "api/testdata/admin-recovery-vector.json is up to date (regenerate with scripts/admin-recovery-vector.mjs)");
const ok = verifyCode(vector.code);
assert.ok(ok.ok, "vector code verifies");
assert.equal(ok.payloadJson, vector.payload_json);
assert.equal(Buffer.from(vector.signed_message_hex, "hex").toString("utf8"), vector.signed_message);
assert.equal(vector.signed_message, ADMIN_RECOVERY_SIGNING_DOMAIN + vector.payload_json);
assert.ok(verify(null, Buffer.from(vector.signed_message_hex, "hex"), publicKey, Buffer.from(vector.signature_hex, "hex")));
assert.equal(vector.public_key_hex, TEST_ENTITLEMENT_PUBLIC_KEY_HEX);
assert.equal(verifyCode(vector.tampered.code).why, "signature", "tampered vector is refused");

// The primary vector is what the desktop pinned first: it must never change.
assert.equal(
  vector.code,
  "MFXREC1.eyJ2IjoxLCJwdXJwb3NlIjoiYWRtaW5fcmVjb3ZlcnkiLCJjb2RlX2lkIjoiM2Y2YzFkMmUtOWE0Yi00YzdkLThlMWYtMmEzYjRjNWQ2ZTdmIiwidGVuYW50X2lkIjoidGVuX3ZlY3Rvcl8wMDAxIiwibWFjaGluZV9maW5nZXJwcmludCI6ImZwLXZlY3Rvci05YzQxZTdiMmEwNWQiLCJsaWNlbnNlX2lkIjoibGljX3ZlY3Rvcl8wMDAxIiwiaXNzdWVyIjoibWFpbnRhZm94LXZwcyIsImtleV9pZCI6InRlc3QtZWQyNTUxOS1kby1ub3QtdHJ1c3QiLCJzaWduYXR1cmVfYWxnIjoiZWQyNTUxOTphZG1pbi1yZWNvdmVyeTp2MSIsImlzc3VlZF9hdCI6IjIwMjYtMTAtMTlUMDg6MzA6MDAuMDAwWiIsImV4cGlyZXNfYXQiOiIyMDI2LTEwLTIwVDA4OjMwOjAwLjAwMFoifQ.c8fcd87bbe8824f9c58badedd5f4470cfde793fca305963167bfbe7660b0003ad057f9ffb05059882acdb5fcb68f329f3652604a3f0c75eb3536bed38748b406",
);

// ── Extra cases: a reference verifier (the desktop's checks that need no local state) ──────
/** Result name of REFUSAL_CODES for `code` at `now`, the claim being the payload's own ids. */
function judge(code, nowIso) {
  const r = verifyCodeFull(code);
  if (r.why) return r.why;
  const now = Date.parse(nowIso);
  if (now >= Date.parse(r.payload.expires_at)) return "expired";
  if (Date.parse(r.payload.issued_at) > now + 5 * 60_000) return "issued_in_future";
  return "valid";
}
function verifyCodeFull(code) {
  const [, b64, sigHex] = code.split(".");
  const payloadJson = Buffer.from(b64, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson);
  if (canonicalAdminRecoveryPayload(payload) !== payloadJson) return { why: "non_canonical" };
  if (payload.purpose !== "admin_recovery") return { why: "wrong_purpose" };
  const message = Buffer.from(ADMIN_RECOVERY_SIGNING_DOMAIN + payloadJson, "utf8");
  if (!verify(null, message, publicKey, Buffer.from(sigHex, "hex"))) return { why: "invalid_signature" };
  return { payload };
}
assert.deepEqual(
  vector.extra_cases.map((c) => c.name),
  ["escaped_fingerprint", "bare_payload_signature", "expired", "issued_in_future", "wrong_purpose", "keys_reordered"],
);
for (const c of vector.extra_cases) {
  assert.ok(c.expected in vector.refusal_codes, `${c.name}: expected result is documented`);
  assert.equal(judge(c.code, c.now), c.expected, c.name);
  assert.equal(Buffer.from(c.code.split(".")[1], "base64url").toString("utf8"), c.payload_json, `${c.name}: code carries payload_json`);
  assert.equal(c.signed_message_hex, Buffer.from(ADMIN_RECOVERY_SIGNING_DOMAIN + c.payload_json, "utf8").toString("hex"));
}
assert.equal(judge(vector.code, "2026-10-19T09:00:00.000Z"), "valid");
const esc = vector.extra_cases[0];
assert.equal(JSON.parse(esc.payload_json).machine_fingerprint, 'fp-"q"\\b\u0001c\nd/\u00e9\u{1F600}');
assert.ok(esc.payload_json.includes('fp-\\"q\\"\\\\b\\u0001c\\nd/é😀'), "JSON escaping: \\\", \\\\, \\u0001, \\n; é, emoji and / raw");

console.log("admin-recovery-signer: OK");

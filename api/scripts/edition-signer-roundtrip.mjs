/**
 * Round-trip check: edition catalog + Ed25519 signer produce envelopes whose signature verifies
 * against the public key over the canonical payload the desktop rebuilds; tampering is detected.
 */
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";

import {
  capabilitiesJsonForEdition,
  listFactoryEditionCatalog,
  parseEditionId,
} from "../dist/edition-catalog.js";
import {
  buildSignedEntitlementEnvelope,
  canonicalPayload,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_SIGNATURE_ALG,
} from "../dist/entitlement-signer.js";
import {
  TEST_ENTITLEMENT_KEY_ID,
  TEST_ENTITLEMENT_PUBLIC_KEY_HEX,
  TEST_ENTITLEMENT_SIGNING_ENV,
} from "./lib/test-signing-key.mjs";

// The signer has no built-in key; tests configure the TEST-ONLY key explicitly.
Object.assign(process.env, TEST_ENTITLEMENT_SIGNING_ENV);

const catalog = listFactoryEditionCatalog();
assert.equal(catalog.length, 4);
assert.equal(parseEditionId("enterprise"), "enterprise");
assert.equal(capabilitiesJsonForEdition("core").includes('"planning":false'), true);
assert.equal(capabilitiesJsonForEdition("core").includes('"training":false'), true);
assert.equal(capabilitiesJsonForEdition("professional").includes('"planning":true'), true);
assert.equal(capabilitiesJsonForEdition("professional").includes('"training":false'), true);
assert.equal(capabilitiesJsonForEdition("enterprise").includes('"finance":true'), true);
assert.equal(capabilitiesJsonForEdition("enterprise").includes('"training":true'), true);

const envelope = buildSignedEntitlementEnvelope({
  edition: "core",
  lineageVersion: 1,
  previousEnvelopeId: null,
  channel: "stable",
  machineSlots: 2,
  deviceClass: "desktop",
  issuedAt: "2026-07-26T10:00:00.000Z",
  validFrom: "2026-07-26T10:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z",
  offlineGraceUntil: "2099-01-04T00:00:00.000Z",
});

assert.equal(envelope.issuer, ENTITLEMENT_ISSUER);
assert.equal(envelope.key_id, TEST_ENTITLEMENT_KEY_ID);
assert.equal(envelope.signature_alg, ENTITLEMENT_SIGNATURE_ALG);
assert.equal(envelope.tier, "core");
assert.equal(envelope.lineage_version, 1);
assert.equal(envelope.previous_envelope_id, null);
assert.match(envelope.signature, /^[0-9a-f]{128}$/, "Ed25519 signature is 64 bytes hex");

// Verify with the PUBLIC key only (what the desktop holds). SPKI = 12-byte header + raw key.
const spki = Buffer.concat([
  Buffer.from("302a300506032b6570032100", "hex"),
  Buffer.from(TEST_ENTITLEMENT_PUBLIC_KEY_HEX, "hex"),
]);
const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
const { signature, ...unsigned } = envelope;
const canonical = Buffer.from(canonicalPayload(unsigned), "utf8");
assert.equal(verify(null, canonical, publicKey, Buffer.from(signature, "hex")), true, "signature must verify");

// Any field change must invalidate the signature.
const tampered = Buffer.from(canonicalPayload({ ...unsigned, machine_slots: 99 }), "utf8");
assert.equal(verify(null, tampered, publicKey, Buffer.from(signature, "hex")), false, "tampering must be detected");

assert.ok(canonicalPayload(unsigned).includes('"previous_envelope_id":null'));
assert.ok(canonicalPayload(unsigned).includes('"capabilities_json":'));

// The device class is signed inside policy_json (migration 019); desktops read only
// grace_allowed_modules from it.
assert.equal(JSON.parse(envelope.policy_json).device_class, "desktop");
assert.ok(Array.isArray(JSON.parse(envelope.policy_json).grace_allowed_modules));
const reclassed = Buffer.from(
  canonicalPayload({ ...unsigned, policy_json: unsigned.policy_json.replace('"device_class":"desktop"', '"device_class":"mobile"') }),
  "utf8",
);
assert.equal(verify(null, reclassed, publicKey, Buffer.from(signature, "hex")), false, "a re-classed envelope must not verify");
const mobileEnvelope = buildSignedEntitlementEnvelope({
  edition: "core",
  lineageVersion: 1,
  channel: "stable",
  machineSlots: 3,
  deviceClass: "mobile",
  validUntil: "2099-01-01T00:00:00.000Z",
  offlineGraceUntil: "2099-01-04T00:00:00.000Z",
});
assert.equal(JSON.parse(mobileEnvelope.policy_json).device_class, "mobile");
assert.equal(mobileEnvelope.machine_slots, 3);
assert.throws(
  () =>
    buildSignedEntitlementEnvelope({
      edition: "core",
      lineageVersion: 1,
      channel: "stable",
      machineSlots: 1,
      validUntil: "2099-01-01T00:00:00.000Z",
      offlineGraceUntil: "2099-01-04T00:00:00.000Z",
    }),
  /deviceClass must be one of/,
  "an envelope without a device class is refused",
);

console.log("edition-signer round-trip ok (Ed25519)");

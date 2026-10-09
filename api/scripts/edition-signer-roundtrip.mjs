/**
 * Round-trip check: edition catalog + signer produce digests/signatures
 * matching the desktop canonical payload algorithm.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  capabilitiesJsonForEdition,
  listFactoryEditionCatalog,
  parseEditionId,
} from "../dist/edition-catalog.js";
import {
  buildSignedEntitlementEnvelope,
  canonicalPayload,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_KEY_ID_V1,
  payloadHash,
  signEnvelope,
} from "../dist/entitlement-signer.js";

const secret = "MAINTAFOX_TRUSTED_ISSUER_KEY_V1";

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
  issuedAt: "2026-07-26T10:00:00.000Z",
  validFrom: "2026-07-26T10:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z",
  offlineGraceUntil: "2099-01-04T00:00:00.000Z",
});

assert.equal(envelope.issuer, ENTITLEMENT_ISSUER);
assert.equal(envelope.key_id, ENTITLEMENT_KEY_ID_V1);
assert.equal(envelope.tier, "core");
assert.equal(envelope.lineage_version, 1);
assert.equal(envelope.previous_envelope_id, null);

const { signature, ...unsigned } = envelope;
const expected = signEnvelope(unsigned, secret);
assert.equal(signature, expected);

const hash = payloadHash(unsigned);
const material = `${unsigned.issuer}:${unsigned.key_id}:${hash}:${secret}`;
const manual = createHash("sha256").update(material).digest("hex");
assert.equal(signature, manual);

const canonical = canonicalPayload(unsigned);
assert.ok(canonical.includes('"previous_envelope_id":null'));
assert.ok(canonical.includes('"capabilities_json":'));

console.log("edition-signer round-trip ok");

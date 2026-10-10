/**
 * Signs entitlement envelopes with Ed25519 over the canonical payload that desktop
 * `entitlements/queries.rs::canonical_payload` rebuilds byte-for-byte.
 *
 * The private key exists only in the control-plane environment; desktops embed the matching
 * public keys (by key_id), so a licence cannot be forged from anything shipped in the binary.
 */
import { createHash, createPrivateKey, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";

import {
  capabilitiesJsonForEdition,
  featureFlagsJsonForEdition,
  isSystemEditionId,
  policyJsonForEdition,
} from "./edition-catalog.js";

export const ENTITLEMENT_SIGNATURE_ALG = "ed25519:v2";
export const ENTITLEMENT_ISSUER = "maintafox-vps";

export type EntitlementSigningKey = { keyId: string; privateKey: KeyObject };

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * Parses a signing key from base64-encoded PKCS#8 DER (single line, fits in .env).
 * Generate with `node scripts/generate-entitlement-signing-key.mjs`.
 */
export function parseEntitlementSigningKey(keyId: string, privateKeyPkcs8Base64: string): EntitlementSigningKey {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("ENTITLEMENT_SIGNING_KEY_ID must be 3-64 chars of [a-z0-9._-].");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8Base64, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch (err) {
    throw new Error(`ENTITLEMENT_SIGNING_PRIVATE_KEY is not a valid base64 PKCS#8 key: ${(err as Error).message}`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`ENTITLEMENT_SIGNING_PRIVATE_KEY must be an Ed25519 key (got ${privateKey.asymmetricKeyType}).`);
  }
  return { keyId, privateKey };
}

let cachedKey: EntitlementSigningKey | null = null;

/** Loads (once) the signing key from ENTITLEMENT_SIGNING_KEY_ID + ENTITLEMENT_SIGNING_PRIVATE_KEY. */
export function loadEntitlementSigningKey(): EntitlementSigningKey {
  if (cachedKey) return cachedKey;
  const keyId = process.env.ENTITLEMENT_SIGNING_KEY_ID?.trim();
  const material = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY?.trim();
  if (!keyId || !material) {
    throw new Error("ENTITLEMENT_SIGNING_KEY_ID and ENTITLEMENT_SIGNING_PRIVATE_KEY are required.");
  }
  cachedKey = parseEntitlementSigningKey(keyId, material);
  return cachedKey;
}

export type EntitlementEnvelopePayload = {
  envelope_id: string;
  previous_envelope_id: string | null;
  lineage_version: number;
  issuer: string;
  key_id: string;
  signature_alg: string;
  tier: string;
  state: string;
  channel: string;
  machine_slots: number;
  feature_flags_json: string;
  capabilities_json: string;
  policy_json: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  offline_grace_until: string;
  signature: string;
};

type UnsignedEnvelope = Omit<EntitlementEnvelopePayload, "signature">;

/** Must match serde_json::json!({...}).to_string() key order used by desktop. */
export function canonicalPayload(input: UnsignedEnvelope): string {
  return JSON.stringify({
    envelope_id: input.envelope_id,
    previous_envelope_id: input.previous_envelope_id,
    lineage_version: input.lineage_version,
    issuer: input.issuer,
    key_id: input.key_id,
    signature_alg: input.signature_alg,
    tier: input.tier,
    state: input.state,
    channel: input.channel,
    machine_slots: input.machine_slots,
    feature_flags_json: input.feature_flags_json,
    capabilities_json: input.capabilities_json,
    policy_json: input.policy_json,
    issued_at: input.issued_at,
    valid_from: input.valid_from,
    valid_until: input.valid_until,
    offline_grace_until: input.offline_grace_until,
  });
}

export function payloadHash(input: UnsignedEnvelope): string {
  return createHash("sha256").update(canonicalPayload(input)).digest("hex");
}

/** Ed25519 signature (hex, 64 bytes) over the UTF-8 canonical payload. */
export function signEnvelope(
  input: UnsignedEnvelope,
  key: EntitlementSigningKey = loadEntitlementSigningKey(),
): string {
  if (input.key_id !== key.keyId) {
    throw new Error(`Envelope key_id '${input.key_id}' does not match signing key '${key.keyId}'.`);
  }
  return cryptoSign(null, Buffer.from(canonicalPayload(input), "utf8"), key.privateKey).toString("hex");
}

export function capabilitiesDigest(capabilitiesJson: string): string {
  return createHash("sha256").update(capabilitiesJson).digest("hex");
}

export type BuildEnvelopeInput = {
  /** Catalog edition id (system or custom). Used as envelope `tier`. */
  edition: string;
  lineageVersion: number;
  previousEnvelopeId?: string | null;
  channel: string;
  machineSlots: number;
  issuedAt?: string;
  validFrom?: string;
  validUntil: string;
  offlineGraceUntil: string;
  state?: string;
  /**
   * Snapshot from edition_catalog at sign time (required for custom editions).
   * When omitted, factory defaults are used for system editions only (scripts/tests).
   */
  capabilities_json?: string;
};

export function buildSignedEntitlementEnvelope(input: BuildEnvelopeInput): EntitlementEnvelopePayload {
  const tier = input.edition.trim();
  let capabilitiesJson = input.capabilities_json;
  if (!capabilitiesJson) {
    if (!isSystemEditionId(tier)) {
      throw new Error(
        `capabilities_json is required when signing non-system edition '${tier}'`,
      );
    }
    capabilitiesJson = capabilitiesJsonForEdition(tier);
  }
  const signingKey = loadEntitlementSigningKey();
  const now = input.issuedAt ?? new Date().toISOString();
  const unsigned: UnsignedEnvelope = {
    envelope_id: `env_${randomBytes(8).toString("hex")}`,
    previous_envelope_id: input.previousEnvelopeId ?? null,
    lineage_version: input.lineageVersion,
    issuer: ENTITLEMENT_ISSUER,
    key_id: signingKey.keyId,
    signature_alg: ENTITLEMENT_SIGNATURE_ALG,
    tier,
    state: input.state ?? "active",
    channel: input.channel,
    machine_slots: input.machineSlots,
    feature_flags_json: featureFlagsJsonForEdition(),
    capabilities_json: capabilitiesJson,
    policy_json: policyJsonForEdition(),
    issued_at: now,
    valid_from: input.validFrom ?? now,
    valid_until: input.validUntil,
    offline_grace_until: input.offlineGraceUntil,
  };
  return {
    ...unsigned,
    signature: signEnvelope(unsigned, signingKey),
  };
}

export function addHoursIso(baseIso: string, hours: number): string {
  const d = new Date(baseIso);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

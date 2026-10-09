/**
 * Signs entitlement envelopes using the same canonical payload + SHA256 scheme
 * as desktop `entitlements/queries.rs` (issuer maintafox-vps / key-v1).
 */
import { createHash, randomBytes } from "node:crypto";

import {
  capabilitiesJsonForEdition,
  featureFlagsJsonForEdition,
  isSystemEditionId,
  policyJsonForEdition,
} from "./edition-catalog.js";

export const ENTITLEMENT_SIGNATURE_ALG_V1 = "sha256:issuer-key-v1";
export const ENTITLEMENT_ISSUER = "maintafox-vps";
export const ENTITLEMENT_KEY_ID_V1 = "key-v1";

/** Default matches desktop trusted_issuer_secrets() material string. */
const DEFAULT_SECRET_V1 = "MAINTAFOX_TRUSTED_ISSUER_KEY_V1";

function issuerSecretV1(): string {
  const fromEnv = process.env.ENTITLEMENT_ISSUER_SECRET_V1?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SECRET_V1;
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

export function signEnvelope(input: UnsignedEnvelope, secret = issuerSecretV1()): string {
  const hash = payloadHash(input);
  const material = `${input.issuer}:${input.key_id}:${hash}:${secret}`;
  return createHash("sha256").update(material).digest("hex");
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
  const now = input.issuedAt ?? new Date().toISOString();
  const unsigned: UnsignedEnvelope = {
    envelope_id: `env_${randomBytes(8).toString("hex")}`,
    previous_envelope_id: input.previousEnvelopeId ?? null,
    lineage_version: input.lineageVersion,
    issuer: ENTITLEMENT_ISSUER,
    key_id: ENTITLEMENT_KEY_ID_V1,
    signature_alg: ENTITLEMENT_SIGNATURE_ALG_V1,
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
    signature: signEnvelope(unsigned),
  };
}

export function addHoursIso(baseIso: string, hours: number): string {
  const d = new Date(baseIso);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

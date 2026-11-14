/**
 * Per-user signatures on sync changes (design: sync-signing-design.md v9, §3–§7).
 *
 * Every verifier (this server and every PC) rebuilds the signed message from the item itself:
 * an ASCII tag, then each field as <u32 big-endian byte length><UTF-8 bytes>, so no field value
 * can be confused with a separator. The payload digest is always recomputed from payload_json,
 * never taken from the item's payload_hash.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { argon2Verify } from "hash-wasm";

export const CHANGE_SIGNATURE_TAG = "mfx-sync-sig-v1";
export const ENROL_PROOF_TAG = "mfx-user-key-enrol-v1";

/** Ed25519 public keys and signatures are fixed-size. */
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** Argon2id parameter caps checked BEFORE verifying a mirrored PHC string (memory/CPU bound). */
export const PHC_MAX_MEMORY_KIB = 65536;
export const PHC_MAX_TIME_COST = 4;
export const PHC_MAX_PARALLELISM = 4;

/** Length-prefixed encoding of `tag` followed by `fields`. */
export function encodeSigned(tag: string, fields: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of [tag, ...fields]) {
    const bytes = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    parts.push(len, bytes);
  }
  return Buffer.concat(parts);
}

export type ChangeSigningInput = {
  tenantId: string;
  entityType: string;
  entitySyncId: string;
  operation: string;
  rowVersion: number;
  baseRowVersion: number | null;
  payloadJson: string;
  signerUserSyncId: string;
  keyId: string;
};

/** The bytes a user signs for one change (design §7). */
export function changeSigningMessage(input: ChangeSigningInput): Buffer {
  return encodeSigned(CHANGE_SIGNATURE_TAG, [
    input.tenantId,
    input.entityType,
    input.entitySyncId,
    input.operation,
    String(input.rowVersion),
    input.baseRowVersion === null ? "" : String(input.baseRowVersion),
    createHash("sha256").update(input.payloadJson, "utf8").digest("hex"),
    input.signerUserSyncId,
    input.keyId,
  ]);
}

/** The bytes signed at enrolment to prove possession of the private key (design §4). */
export function enrolProofMessage(tenantId: string, userSyncId: string, keyId: string, machineFingerprint: string): Buffer {
  return encodeSigned(ENROL_PROOF_TAG, [tenantId, userSyncId, keyId, machineFingerprint]);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodes a standard base64 Ed25519 public key; null when not exactly 32 bytes. */
export function decodePublicKey(b64: string): Buffer | null {
  if (!BASE64.test(b64)) return null;
  const raw = Buffer.from(b64, "base64");
  return raw.length === PUBLIC_KEY_BYTES ? raw : null;
}

/** key_id = hex of the first 16 bytes of SHA-256(raw public key). */
export function keyIdOf(rawPublicKey: Buffer): string {
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 32);
}

function publicKeyObject(rawPublicKey: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawPublicKey.toString("base64url") },
    format: "jwk",
  });
}

/** True only for a well-formed 64-byte Ed25519 signature that verifies. Never throws. */
export function verifyEd25519(rawPublicKey: Buffer, message: Buffer, signatureB64: string): boolean {
  if (rawPublicKey.length !== PUBLIC_KEY_BYTES) return false;
  if (!BASE64.test(signatureB64)) return false;
  const signature = Buffer.from(signatureB64, "base64");
  if (signature.length !== SIGNATURE_BYTES) return false;
  try {
    return cryptoVerify(null, message, publicKeyObject(rawPublicKey), signature);
  } catch {
    return false;
  }
}

export type PhcCheck = { ok: true } | { ok: false; reason: string };

/**
 * Accepts only `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt>$<hash>` within the caps. A mirrored hash
 * comes from a device, so oversized parameters would let a paired PC exhaust the server.
 */
export function checkArgon2idPhc(phc: string): PhcCheck {
  const m = /^\$argon2id\$v=19\$m=(\d{1,10}),t=(\d{1,3}),p=(\d{1,3})\$[A-Za-z0-9+/]{8,88}\$[A-Za-z0-9+/]{16,88}$/.exec(phc);
  if (!m) return { ok: false, reason: "not an argon2id v19 PHC string" };
  const memory = Number(m[1]);
  const time = Number(m[2]);
  const parallelism = Number(m[3]);
  if (memory < 8 || memory > PHC_MAX_MEMORY_KIB) return { ok: false, reason: "memory cost out of bounds" };
  if (time < 1 || time > PHC_MAX_TIME_COST) return { ok: false, reason: "time cost out of bounds" };
  if (parallelism < 1 || parallelism > PHC_MAX_PARALLELISM) return { ok: false, reason: "parallelism out of bounds" };
  return { ok: true };
}

/** Verifies a password against a PHC string that passes checkArgon2idPhc. Never throws. */
export async function verifyArgon2idPassword(password: string, phc: string): Promise<boolean> {
  if (!checkArgon2idPhc(phc).ok) return false;
  try {
    return await argon2Verify({ password, hash: phc });
  } catch {
    return false;
  }
}

/**
 * Verification of Tauri updater signatures (minisign format) before a release is registered: the
 * desktop refuses an update whose signature does not match its built-in public key, so a release
 * signed with another key would fail on every device. Checking it here keeps such a release out of
 * the catalog instead.
 *
 * Formats (both as written by `tauri signer`, base64 of the text):
 * - public key: "untrusted comment: ...\n" + base64("Ed" | key id (8) | Ed25519 public key (32))
 * - signature:  "untrusted comment: ...\n" + base64(alg (2) | key id (8) | signature (64)) + "\n"
 *               + "trusted comment: ...\n" + base64(global signature (64))
 *   alg "ED" signs BLAKE2b-512(file) (Tauri's default), "Ed" signs the file itself. The global
 *   signature covers signature || trusted comment.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type UpdaterPublicKey = { keyId: Buffer; key: KeyObject };

function decodeLines(base64Text: string, what: string): string[] {
  const text = Buffer.from(base64Text.trim(), "base64").toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2 || !lines[0]!.startsWith("untrusted comment:")) {
    throw new Error(`${what} is not a minisign ${what} (base64 of the file written by tauri signer)`);
  }
  return lines;
}

export function parseUpdaterPublicKey(base64Text: string): UpdaterPublicKey {
  const lines = decodeLines(base64Text, "public key");
  const raw = Buffer.from(lines[1]!, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("public key is not an Ed25519 minisign key");
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: "der", type: "spki" }),
  };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: "malformed" | "key_mismatch" | "bad_signature" };

/**
 * Checks `signatureBase64` (the .sig file content) against the artifact. `fileBlake2b512` is the
 * BLAKE2b-512 of the artifact (computed while streaming it); the legacy non-prehashed form ("Ed")
 * needs the whole file in `fileBytes` and is refused when it is null.
 */
export function verifyUpdaterSignature(
  publicKey: UpdaterPublicKey,
  signatureBase64: string,
  fileBlake2b512: Buffer,
  fileBytes: Buffer | null,
): SignatureCheck {
  let lines: string[];
  try {
    lines = decodeLines(signatureBase64, "signature");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2];
  const globalSig = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || !trusted?.startsWith("trusted comment: ") || globalSig.length !== 64) {
    return { ok: false, reason: "malformed" };
  }
  const alg = sig.subarray(0, 2).toString("latin1");
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) return { ok: false, reason: "key_mismatch" };
  let message: Buffer;
  if (alg === "ED") message = fileBlake2b512;
  else if (alg === "Ed" && fileBytes) message = fileBytes;
  else return { ok: false, reason: "malformed" };
  const signature = sig.subarray(10);
  if (!verify(null, message, publicKey.key, signature)) return { ok: false, reason: "bad_signature" };
  const trustedComment = Buffer.from(trusted.slice("trusted comment: ".length), "utf8");
  if (!verify(null, Buffer.concat([signature, trustedComment]), publicKey.key, globalSig)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * The `file:` field of the signature's trusted comment ("timestamp:<n>\tfile:<name>", written by
 * `tauri signer sign`; the global signature covers it, so it cannot be edited without the key).
 * Null when the signature is malformed or has no file field. Only meaningful after
 * verifyUpdaterSignature succeeded.
 */
export function signedFileName(signatureBase64: string): string | null {
  let lines: string[];
  try {
    lines = decodeLines(signatureBase64, "signature");
  } catch {
    return null;
  }
  const trusted = lines[2];
  if (!trusted?.startsWith("trusted comment: ")) return null;
  const field = trusted
    .slice("trusted comment: ".length)
    .split("\t")
    .find((part) => part.startsWith("file:"));
  return field === undefined ? null : field.slice("file:".length);
}

export function blake2b512(bytes: Buffer): Buffer {
  return createHash("blake2b512").update(bytes).digest();
}

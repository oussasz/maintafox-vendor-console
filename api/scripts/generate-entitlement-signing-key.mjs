/**
 * Generates an Ed25519 entitlement signing key and stores it in an .env file.
 *
 *   node scripts/generate-entitlement-signing-key.mjs --env-file ../.env --key-id mfx-ed25519-2026-10
 *   node scripts/generate-entitlement-signing-key.mjs --env-file ../.env --key-id mfx-ed25519-2027-01 --rotate
 *
 * The PRIVATE key is written only to --env-file (ENTITLEMENT_SIGNING_PRIVATE_KEY) and is never
 * printed. Stdout shows the key id and the PUBLIC key (hex, 32 bytes) to embed in the desktop
 * trusted-key list (src-tauri/src/entitlements/trusted_keys.rs). Refuses to replace an existing
 * key unless --rotate is given (rotation = new key id; keep the old public key trusted until
 * every desktop holds an envelope signed with the new one).
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const envFile = arg("--env-file");
const keyId = arg("--key-id");
const rotate = process.argv.includes("--rotate");

if (!envFile || !keyId) {
  console.error("Usage: --env-file <path> --key-id <id> [--rotate]");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(keyId)) {
  console.error("key id must be 3-64 chars of [a-z0-9._-]");
  process.exit(2);
}

const original = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const existing = original.match(/^ENTITLEMENT_SIGNING_PRIVATE_KEY=(.*)$/m)?.[1]?.trim() ?? "";
// The .env.example placeholder ("replace-by-running-the-generator") does not count as a key.
const hasKey = existing.length > 0 && !existing.startsWith("replace-");
if (hasKey && !rotate) {
  console.error(`${envFile} already has ENTITLEMENT_SIGNING_PRIVATE_KEY; pass --rotate to replace it.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privateB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
// SPKI DER for Ed25519 is a fixed 12-byte header followed by the 32-byte raw public key.
const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

function upsert(text, name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
  return `${text}${sep}${line}${eol}`;
}

let next = upsert(original, "ENTITLEMENT_SIGNING_KEY_ID", keyId);
next = upsert(next, "ENTITLEMENT_SIGNING_PRIVATE_KEY", privateB64);
writeFileSync(envFile, next, { mode: 0o600 });

console.log(`Wrote ENTITLEMENT_SIGNING_KEY_ID and ENTITLEMENT_SIGNING_PRIVATE_KEY to ${envFile}`);
console.log(`key_id:          ${keyId}`);
console.log(`public_key_hex:  ${publicHex}`);
console.log("Embed key_id + public_key_hex in the desktop trusted key list; keep the private key secret.");

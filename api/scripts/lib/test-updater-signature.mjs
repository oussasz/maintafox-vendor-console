/**
 * TEST-ONLY updater signing for the release integration script.
 *
 * - TAURI_VECTOR: a real signature written by `tauri signer sign` (tauri-cli 2, throwaway key
 *   generated for this vector only, password "test-vector-only"; it signs nothing else). It proves
 *   the server's verifier reads the exact format the release workflow uploads.
 * - testUpdaterKey(): a fresh Ed25519 key in the same minisign format (algorithm "ED": BLAKE2b-512
 *   prehash, like tauri signer), so the script can sign as many artifacts as it needs.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const TAURI_VECTOR = {
  publicKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU0QzU3MjI4MUVFOTE5NEQKUldSTkdla2VLSExGVkdiZXFTZUFSY2R5UC9KcXovQm5oVXdzWTkvUzA2b3RRcGVmZE1LR2IzZ0UK",
  signature:
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSTkdla2VLSExGVkZzdTdhZ3R4VWFSNXFIQTFmV09QN0MraWNJZmNiR0tJOUVENVY0L2VWVzBqMndQaHZZNHZVSHZGQ3F4UEdKTDNUMTZ6MlA0MndkaktualIvcC92VXdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxODU4MTk2CWZpbGU6YXJ0aWZhY3QuYmluCjFLSVBKcVBvbUZDUU9wQm1ML2hZcldwcjAwMlVnRVlOdmRRbkFFQzMzN254ZE5mTSt0L3A5SUhSbEE3T3Q2b3I1MnRxZFRJd3VqUEtHRUpLTHQ3b0NnPT0K",
  file: Buffer.from("maintafox release artifact test vector\n", "utf8"),
};

export function testUpdaterKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = randomBytes(8);
  const publicKeyText = `untrusted comment: minisign public key: ${keyId.toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPublic]).toString("base64")}\n`;
  return {
    /** Value for RELEASE_UPDATER_PUBLIC_KEY (same encoding as tauri.conf.json `pubkey`). */
    publicKeyBase64: Buffer.from(publicKeyText).toString("base64"),
    /** Content of the .sig file for `bytes` (same encoding as `tauri build` writes). */
    sign(bytes, fileName = "artifact.exe") {
      const digest = createHash("blake2b512").update(bytes).digest();
      const signature = sign(null, digest, privateKey);
      const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${fileName}`;
      const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
      const text = [
        "untrusted comment: signature from tauri secret key",
        Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
        `trusted comment: ${trusted}`,
        global.toString("base64"),
        "",
      ].join("\n");
      return Buffer.from(text).toString("base64");
    },
  };
}

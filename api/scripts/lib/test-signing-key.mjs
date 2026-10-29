/**
 * TEST-ONLY Ed25519 entitlement signing key, derived from a fixed public seed so integration
 * scripts and the desktop cross-language test vector agree. Anyone can recompute it: it must
 * never be trusted outside tests (desktop registers it under #[cfg(test)] only).
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

export const TEST_ENTITLEMENT_KEY_ID = "test-ed25519-do-not-trust";

const seed = createHash("sha256").update("maintafox-entitlement-TEST-ONLY-seed-v1").digest();
// PKCS#8 DER for Ed25519 = fixed 16-byte header + 32-byte seed.
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);

export const TEST_ENTITLEMENT_PRIVATE_KEY_B64 = pkcs8.toString("base64");
export const TEST_ENTITLEMENT_PUBLIC_KEY_HEX = createPublicKey(
  createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

/** Spread into a spawned API's env. */
export const TEST_ENTITLEMENT_SIGNING_ENV = {
  ENTITLEMENT_SIGNING_KEY_ID: TEST_ENTITLEMENT_KEY_ID,
  ENTITLEMENT_SIGNING_PRIVATE_KEY: TEST_ENTITLEMENT_PRIVATE_KEY_B64,
};

/**
 * Test helper: a tenant's founding administrator whose changes are signed (sync-signing-design.md
 * §4, §5, §8), for integration tests that need signed user or role rows but do not test signing
 * itself. sync-user-signing.integration.mjs builds the signed message independently of the server;
 * this helper reuses the server's own encoding.
 */
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";

import { argon2id } from "hash-wasm";

import { changeSigningMessage, enrolProofMessage } from "../../dist/sync/signing.js";

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** A v2 outbox item (create when baseRowVersion is null). */
export function syncItem(entityType, entitySyncId, payload, baseRowVersion = null) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: baseRowVersion === null ? "create" : "update",
    row_version: baseRowVersion === null ? 1 : baseRowVersion + 1,
    base_row_version: baseRowVersion,
    payload_json,
    payload_hash: sha256Hex(payload_json),
  };
}

async function phcOf(password) {
  return argon2id({
    password,
    salt: Buffer.from(randomUUID().replace(/-/g, ""), "hex"),
    parallelism: 1,
    iterations: 2,
    memorySize: 1024,
    hashLength: 32,
    outputType: "encoded",
  });
}

/**
 * Creates the tenant's founding administrator from its first-activated PC and enrols a key for it.
 * `exchange(items)` pushes a v2 outbox from that PC and returns the response JSON; `enrol(body)`
 * POSTs /api/v1/sync/user-keys/enrol from that PC and returns { status, json }. Returns `sign(item)`,
 * which adds the administrator's signature to an item.
 */
export async function foundingSigner({ tenantId, machineFingerprint, exchange, enrol, userSyncId = "u-founder" }) {
  const password = `Founder-${randomUUID()}`;
  const account = syncItem("user_accounts", userSyncId, {
    username: userSyncId,
    display_name: "Founding administrator",
    is_active: 1,
    is_admin: 1,
    deleted_at: null,
    force_password_change: 0,
    password_hash: await phcOf(password),
    password_changed_at: null,
    password_changed_by_sync_id: null,
    status_changed_by_sync_id: null,
  });
  const pushed = await exchange([account]);
  if (pushed.acknowledged_items?.length !== 1) throw new Error(`founding administrator refused: ${JSON.stringify(pushed)}`);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  const proof = edSign(null, enrolProofMessage(tenantId, userSyncId, keyId, machineFingerprint), privateKey);
  const enrolled = await enrol({
    user_sync_id: userSyncId,
    public_key: raw.toString("base64"),
    password,
    proof_signature: proof.toString("base64"),
  });
  if (enrolled.status !== 200) throw new Error(`founding administrator key refused: ${JSON.stringify(enrolled.json)}`);

  return {
    userSyncId,
    sign(it) {
      const message = changeSigningMessage({
        tenantId,
        entityType: it.entity_type,
        entitySyncId: it.entity_sync_id,
        operation: it.operation,
        rowVersion: it.row_version,
        baseRowVersion: it.base_row_version,
        payloadJson: it.payload_json,
        signerUserSyncId: userSyncId,
        keyId,
      });
      const signature = edSign(null, message, privateKey).toString("base64");
      return { ...it, signatures: [{ user_sync_id: userSyncId, key_id: keyId, signature }] };
    },
  };
}

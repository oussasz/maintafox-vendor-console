/**
 * Per-user signing keys (sync-signing-design.md v9 §3, §4, §6): the server's key directory,
 * enrolment by password, revocation, and the server-originated `user_signing_keys` rows that tell
 * every PC which key belongs to whom.
 *
 * Enrolment proves the password against the server's own judged copy of the account (authority
 * data is judged at ingest, authority.ts), so a hash forged by a paired PC never reaches it.
 * The password is never stored, logged or echoed; rate limits run before any Argon2 work.
 */
import { randomUUID } from "node:crypto";

import type { Database } from "../db/database.js";
import { accountUsable, assignmentClock, livePayload, unchangedBuiltin } from "./authority.js";
import type { PayloadCipher } from "./payload-crypto.js";
import {
  checkArgon2idPhc,
  decodePublicKey,
  enrolProofMessage,
  keyIdOf,
  verifyArgon2idPassword,
  verifyEd25519,
} from "./signing.js";
import { getEntityState, insertIngress, lockTenantSync, upsertEntityState } from "./store.js";
import { sha256Hex, SyncRequestError, type ActivationSyncContext } from "./types.js";

export const USER_SIGNING_KEYS_TYPE = "user_signing_keys";
/** Device that publishes server-originated rows (never a real fingerprint). */
export const SERVER_ORIGIN = "server";

/** Hard lockout per (tenant, user, device); growing delay per (tenant, user), never a lockout. */
export const ENROL_DEVICE_MAX_FAILURES = 5;
export const ENROL_WINDOW_MINUTES = 15;
export const ENROL_USER_DELAY_STEP_MS = 2000;
export const ENROL_USER_DELAY_MAX_MS = 30000;

const KEY_COLUMNS = `tenant_id, key_id, user_sync_id, public_key, machine_fingerprint, enrolled_at, enrolled_seq,
  revoked_at, revoked_seq, revoked_reason`;

export type SigningKeyRow = {
  tenant_id: string;
  key_id: string;
  user_sync_id: string;
  public_key: string;
  machine_fingerprint: string;
  enrolled_at: Date;
  enrolled_seq: number | string | null;
  revoked_at: Date | null;
  revoked_seq: number | string | null;
  revoked_reason: string | null;
};

export async function signatureCutoverSeq(db: Database): Promise<number> {
  const row = await db.get<{ cutover_seq: number | string }>("SELECT cutover_seq FROM sync_signing_cutover WHERE id = 1");
  if (!row) throw new Error("sync_signing_cutover is missing (migration 022)");
  return Number(row.cutover_seq);
}

export async function getSigningKey(db: Database, tenantId: string, keyId: string): Promise<SigningKeyRow | undefined> {
  return db.get<SigningKeyRow>(
    `SELECT ${KEY_COLUMNS} FROM sync_user_signing_keys WHERE tenant_id = $1 AND key_id = $2`,
    tenantId,
    keyId,
  );
}

/** The `user_signing_keys` row payload (row.v1, so the desktop applies it like any synced row). */
function keyRowPayload(key: SigningKeyRow): string {
  return JSON.stringify({
    _sync_format: "row.v1",
    enrolled_at: new Date(key.enrolled_at).toISOString(),
    key_id: key.key_id,
    machine_fingerprint: key.machine_fingerprint,
    public_key: key.public_key,
    revoked_at: key.revoked_at ? new Date(key.revoked_at).toISOString() : null,
    revoked_reason: key.revoked_reason,
    revoked_seq: key.revoked_seq === null ? null : Number(key.revoked_seq),
    user_sync_id: key.user_sync_id,
  });
}

/** Publishes the current form of one key as a server-originated row; returns its server_seq. */
async function publishKeyRow(db: Database, cipher: PayloadCipher, key: SigningKeyRow): Promise<number> {
  const previous = await getEntityState(db, cipher, key.tenant_id, USER_SIGNING_KEYS_TYPE, key.key_id);
  const payloadJson = keyRowPayload(key);
  const ingress = {
    tenantId: key.tenant_id,
    idempotencyKey: `server:${USER_SIGNING_KEYS_TYPE}:${randomUUID()}`,
    entityType: USER_SIGNING_KEYS_TYPE,
    entitySyncId: key.key_id,
    operation: "upsert" as const,
    rowVersion: (previous?.row_version ?? 0) + 1,
    baseRowVersion: previous ? previous.row_version : null,
    ownerUserSyncId: null,
    payloadJson,
    payloadHash: sha256Hex(payloadJson),
    machineFingerprint: SERVER_ORIGIN,
    receivedAt: new Date().toISOString(),
    protocolVersion: "v2" as const,
    signaturesJson: null,
  };
  const seq = await insertIngress(db, cipher, ingress);
  if (seq === null) throw new Error("server key row idempotency key collided");
  await upsertEntityState(db, cipher, seq, ingress);
  return seq;
}

export type RevokeReason = "password_changed" | "account_disabled" | "account_deleted" | "operator";

/**
 * Revokes every unrevoked key of a user, effective from `fromSeq` (items ingested at or after it
 * are refused). Runs in the caller's transaction, under the tenant lock.
 */
export async function revokeUserKeys(
  db: Database,
  cipher: PayloadCipher,
  tenantId: string,
  userSyncId: string,
  reason: RevokeReason,
  fromSeq: number,
): Promise<number> {
  const keys = await db.all<SigningKeyRow>(
    `UPDATE sync_user_signing_keys SET revoked_at = now(), revoked_seq = $3, revoked_reason = $4
     WHERE tenant_id = $1 AND user_sync_id = $2 AND revoked_at IS NULL
     RETURNING ${KEY_COLUMNS}`,
    tenantId,
    userSyncId,
    fromSeq,
    reason,
  );
  for (const key of keys) await publishKeyRow(db, cipher, key);
  return keys.length;
}

/** Operator revocation of one key. */
export async function revokeOneKey(db: Database, cipher: PayloadCipher, tenantId: string, keyId: string): Promise<boolean> {
  return db.tx(async () => {
    await lockTenantSync(db, tenantId);
    const next = await db.get<{ next: string | number }>("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM sync_mirror_ingress");
    const key = await db.get<SigningKeyRow>(
      `UPDATE sync_user_signing_keys SET revoked_at = now(), revoked_seq = $3, revoked_reason = 'operator'
       WHERE tenant_id = $1 AND key_id = $2 AND revoked_at IS NULL
       RETURNING ${KEY_COLUMNS}`,
      tenantId,
      keyId,
      Number(next?.next ?? 1),
    );
    if (!key) return false;
    await publishKeyRow(db, cipher, key);
    return true;
  });
}

export type EnrolRequest = {
  user_sync_id: string;
  public_key: string;
  password: string;
  proof_signature: string;
};

export type EnrolOutcome = { key_id: string; enrolled_seq: number };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordAttempt(db: Database, act: ActivationSyncContext, userSyncId: string, succeeded: boolean) {
  await db.run(
    `INSERT INTO sync_user_key_enrol_attempts (tenant_id, user_sync_id, machine_fingerprint, attempted_at, succeeded)
     VALUES ($1,$2,$3,now(),$4)`,
    act.tenantId,
    userSyncId,
    act.machineFingerprint,
    succeeded,
  );
}

/** A refusal that must not tell which part failed (account, password or proof). */
const refused = () => new SyncRequestError(403, "enrolment_refused", "The user, password or key proof was not accepted.");

async function failures(db: Database, sql: string, ...params: Array<string>): Promise<number> {
  return Number((await db.get<{ n: string | number }>(sql, ...params))?.n ?? 0);
}

/** Design §4. Throws SyncRequestError on every refusal. */
export async function enrolUserKey(
  db: Database,
  cipher: PayloadCipher,
  act: ActivationSyncContext,
  body: EnrolRequest,
): Promise<EnrolOutcome> {
  const rawPublicKey = decodePublicKey(body.public_key);
  if (!rawPublicKey) throw new SyncRequestError(400, "validation_error", "public_key must be a base64 Ed25519 key.");
  const keyId = keyIdOf(rawPublicKey);

  // 1. Rate limits before any hashing.
  const window = `${ENROL_WINDOW_MINUTES} minutes`;
  const deviceFailures = await failures(
    db,
    `SELECT COUNT(*) AS n FROM sync_user_key_enrol_attempts
     WHERE tenant_id = $1 AND user_sync_id = $2 AND machine_fingerprint = $3 AND NOT succeeded
       AND attempted_at > now() - $4::interval`,
    act.tenantId,
    body.user_sync_id,
    act.machineFingerprint,
    window,
  );
  if (deviceFailures >= ENROL_DEVICE_MAX_FAILURES) {
    throw new SyncRequestError(429, "enrolment_locked", "Too many failed attempts on this PC; try again later.");
  }
  const userFailures = await failures(
    db,
    `SELECT COUNT(*) AS n FROM sync_user_key_enrol_attempts
     WHERE tenant_id = $1 AND user_sync_id = $2 AND NOT succeeded AND attempted_at > now() - $3::interval`,
    act.tenantId,
    body.user_sync_id,
    window,
  );
  if (userFailures > 0) await delay(Math.min(ENROL_USER_DELAY_MAX_MS, userFailures * ENROL_USER_DELAY_STEP_MS));

  // 2. The account, as judged by the server.
  const ctx = { db, cipher, tenantId: act.tenantId, now: assignmentClock(new Date()) };
  const account = await livePayload(ctx, "user_accounts", body.user_sync_id);
  const phc = account && typeof account["password_hash"] === "string" ? account["password_hash"] : null;
  if (!accountUsable(account) || unchangedBuiltin(account) || phc === null || !checkArgon2idPhc(phc).ok) {
    await recordAttempt(db, act, body.user_sync_id, false);
    throw refused();
  }

  // 3–4. Password, then proof of possession of the private key.
  const passwordOk = await verifyArgon2idPassword(body.password, phc);
  const proofOk = verifyEd25519(
    rawPublicKey,
    enrolProofMessage(act.tenantId, body.user_sync_id, keyId, act.machineFingerprint),
    body.proof_signature,
  );
  if (!passwordOk || !proofOk) {
    await recordAttempt(db, act, body.user_sync_id, false);
    throw refused();
  }

  // 5. Store and publish, under the tenant lock; the hash must still be the one verified.
  const outcome = await db.tx(async (): Promise<EnrolOutcome | "changed" | "exists"> => {
    await lockTenantSync(db, act.tenantId);
    const current = await livePayload(ctx, "user_accounts", body.user_sync_id);
    if (!accountUsable(current) || current["password_hash"] !== phc) return "changed";
    if (await getSigningKey(db, act.tenantId, keyId)) return "exists";
    const key = await db.get<SigningKeyRow>(
      `INSERT INTO sync_user_signing_keys (tenant_id, key_id, user_sync_id, public_key, machine_fingerprint, enrolled_at)
       VALUES ($1,$2,$3,$4,$5,now())
       RETURNING ${KEY_COLUMNS}`,
      act.tenantId,
      keyId,
      body.user_sync_id,
      rawPublicKey.toString("base64"),
      act.machineFingerprint,
    );
    if (!key) throw new Error("signing key insert returned nothing");
    const seq = await publishKeyRow(db, cipher, key);
    await db.run(
      "UPDATE sync_user_signing_keys SET enrolled_seq = $3 WHERE tenant_id = $1 AND key_id = $2",
      act.tenantId,
      keyId,
      seq,
    );
    await recordAttempt(db, act, body.user_sync_id, true);
    return { key_id: keyId, enrolled_seq: seq };
  });
  if (outcome === "changed") {
    await recordAttempt(db, act, body.user_sync_id, false);
    throw refused();
  }
  if (outcome === "exists") {
    throw new SyncRequestError(409, "key_already_enrolled", "This key is already enrolled; make a new key.");
  }
  return outcome;
}

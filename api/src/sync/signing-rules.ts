/**
 * Signing rules at ingest (sync-signing-design.md v9 §5, §8), applied by the v2 exchange to each
 * pushed item after the existing validation and conflict checks, inside the exchange transaction
 * (tenant lock held), so every rule is judged on the state as it is after the items before it.
 *
 * Order per item: server-only type → signatures (each must verify with an unrevoked key of its
 * user) → maker required (types with author fields, authority types) → authors (each author field
 * set or changed, or whose guarded columns changed, names a signer of this item) → authority
 * (authority.ts). Founding and recovery items are authenticated by the device slot / the vendor
 * code instead of a maker signature.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import {
  ADMIN_RECOVERY_CODE_PREFIX,
  ADMIN_RECOVERY_PURPOSE,
  ADMIN_RECOVERY_SIGNATURE_ALG,
  adminRecoverySignedMessage,
  canonicalAdminRecoveryPayload,
  type AdminRecoveryPayload,
} from "../admin-recovery-signer.js";
import type { Database } from "../db/database.js";
import { loadEntitlementSigningKey } from "../entitlement-signer.js";
import { ARCHIVED_ATTACHMENT_TYPES } from "./attachment-archive.js";
import {
  ELEVATED_ADMIN_ROLES,
  judgeAuthorityChange,
  livePayload,
  parsePayloadObject,
  type AuthorityCtx,
} from "./authority.js";
import type { SyncEntityRegistry } from "./registry.js";
import { changeSigningMessage, decodePublicKey, verifyEd25519 } from "./signing.js";
import { getSigningKey } from "./user-keys.js";
import type { ActivationSyncContext, SyncOutboxItemV2, SyncSignature } from "./types.js";

type Fail = { ok: false; code: string; message: string };
const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

/** Recovery codes are accepted at most this long after issue (the PC checked the 24 h validity). */
export const RECOVERY_INGEST_GRACE_DAYS = 7;

type Payload = Record<string, unknown>;

function truthy(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function blank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── Founding administrator slot (design §8) ─────────────────────────────────────────────────

type FoundingRow = { founding_machine_fingerprint: string; slot_open: boolean };

/**
 * The tenant's founding slot. Created on first use from the tenant's earliest activation: open for
 * a tenant without data, closed for one that has data (its authority is legacy state).
 */
export async function foundingSlot(db: Database, tenantId: string): Promise<FoundingRow | undefined> {
  const select = () =>
    db.get<FoundingRow>("SELECT founding_machine_fingerprint, slot_open FROM sync_tenant_founding WHERE tenant_id = $1", tenantId);
  const existing = await select();
  if (existing) return existing;
  const first = await db.get<{ machine_fingerprint: string }>(
    `SELECT machine_fingerprint FROM machine_activations WHERE tenant_id = $1 ORDER BY activated_at ASC, id ASC LIMIT 1`,
    tenantId,
  );
  if (!first) return undefined;
  const hasData = await db.get<{ one: number }>("SELECT 1 AS one FROM sync_entity_state WHERE tenant_id = $1 LIMIT 1", tenantId);
  const open = !hasData;
  await db.run(
    `INSERT INTO sync_tenant_founding (tenant_id, founding_machine_fingerprint, slot_open, closed_at, closed_reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO NOTHING`,
    tenantId,
    first.machine_fingerprint,
    open,
    open ? null : new Date(),
    open ? null : "existing_tenant",
  );
  return select();
}

/** Closes the slot once any other device pushes for the tenant (design §8). */
export async function closeFoundingSlotForOtherDevice(db: Database, act: ActivationSyncContext): Promise<void> {
  const slot = await foundingSlot(db, act.tenantId);
  if (slot?.slot_open && slot.founding_machine_fingerprint !== act.machineFingerprint) {
    await db.run(
      `UPDATE sync_tenant_founding SET slot_open = false, closed_at = now(), closed_reason = 'other_device_pushed'
       WHERE tenant_id = $1 AND slot_open`,
      act.tenantId,
    );
  }
}

async function isFoundingItem(
  db: Database,
  act: ActivationSyncContext,
  item: SyncOutboxItemV2,
  payload: Payload | null,
  previous: Payload | null,
): Promise<boolean> {
  if (item.entity_type !== "user_accounts" || previous !== null || !payload || !truthy(payload["is_admin"])) return false;
  if (item.operation === "delete" || item.operation === "archive") return false;
  if ((item.signatures ?? []).length > 0) return false;
  const slot = await foundingSlot(db, act.tenantId);
  return Boolean(slot?.slot_open && slot.founding_machine_fingerprint === act.machineFingerprint);
}

async function closeFoundingSlot(db: Database, tenantId: string, accountSyncId: string): Promise<void> {
  await db.run(
    `UPDATE sync_tenant_founding
     SET slot_open = false, closed_at = now(), closed_reason = 'founding_admin_created', founding_account_sync_id = $2
     WHERE tenant_id = $1 AND slot_open`,
    tenantId,
    accountSyncId,
  );
}

// ── Recovery unit (design §8) ───────────────────────────────────────────────────────────────

/**
 * The unit's items are held by identity (the exact objects of the batch), never by idempotency
 * key: another item reusing a recovery item's key must not inherit the recovery exemption.
 */
export type RecoveryUnit =
  | { kind: "none" }
  | { kind: "valid"; codeId: string; accountSyncId: string; items: ReadonlySet<SyncOutboxItemV2> }
  | { kind: "invalid"; items: ReadonlySet<SyncOutboxItemV2>; code: string; message: string };

function decodeRecoveryCode(code: string): { payloadJson: string; payload: AdminRecoveryPayload; signatureHex: string } | null {
  const parts = code.split(".");
  if (parts.length !== 3 || parts[0] !== ADMIN_RECOVERY_CODE_PREFIX) return null;
  const [, body, signatureHex] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[0-9a-f]{128}$/.test(signatureHex)) return null;
  const payloadJson = Buffer.from(body, "base64url").toString("utf8");
  const payload = parsePayloadObject(payloadJson) as AdminRecoveryPayload | null;
  if (!payload) return null;
  return { payloadJson, payload, signatureHex };
}

/**
 * Finds the batch's recovery unit (items carrying `recovery_code`) and judges it as a whole: the
 * two items of `auth/recovery_code.rs::write_recovery` (account create + Administrator grant to
 * it), one valid, unconsumed vendor code issued to this PC at most 7 days ago.
 */
export async function judgeRecoveryUnit(
  ctx: AuthorityCtx,
  act: ActivationSyncContext,
  batch: SyncOutboxItemV2[],
  now: Date,
): Promise<RecoveryUnit> {
  const items = batch.filter((i) => i.recovery_code !== undefined);
  if (items.length === 0) return { kind: "none" };
  const unitItems: ReadonlySet<SyncOutboxItemV2> = new Set(items);
  const invalid = (message: string): RecoveryUnit => ({
    kind: "invalid",
    items: unitItems,
    code: "recovery_refused",
    message,
  });

  const codes = new Set(items.map((i) => i.recovery_code));
  if (codes.size !== 1 || items.length !== 2) return invalid("a recovery is exactly two items carrying the same code");
  for (const unitItem of items) {
    if (batch.filter((i) => i.idempotency_key === unitItem.idempotency_key).length !== 1) {
      return invalid("a recovery item's idempotency_key must be unique in the batch");
    }
  }
  const decoded = decodeRecoveryCode(items[0]!.recovery_code!);
  if (!decoded) return invalid("the recovery code is malformed");
  const { payload, payloadJson, signatureHex } = decoded;
  if (payloadJson !== canonicalAdminRecoveryPayload(payload) || payload.purpose !== ADMIN_RECOVERY_PURPOSE) {
    return invalid("the recovery code is not canonical");
  }
  if (payload.signature_alg !== ADMIN_RECOVERY_SIGNATURE_ALG) return invalid("unknown recovery signature algorithm");
  const signingKey = loadEntitlementSigningKey();
  if (payload.key_id !== signingKey.keyId) return invalid("the recovery code was signed with another key");
  const signatureOk = cryptoVerify(
    null,
    adminRecoverySignedMessage(payloadJson),
    createPublicKey(signingKey.privateKey),
    Buffer.from(signatureHex, "hex"),
  );
  if (!signatureOk) return invalid("the recovery code signature does not verify");
  if (
    payload.tenant_id !== act.tenantId ||
    payload.license_id !== act.licenseId ||
    payload.machine_fingerprint !== act.machineFingerprint
  ) {
    return invalid("the recovery code was issued to another PC");
  }
  const issued = await ctx.db.get<{ issued_at: string; consumed_at: Date | null }>(
    `SELECT issued_at, consumed_at FROM admin_recovery_codes
     WHERE code_id = $1 AND tenant_id = $2 AND license_id = $3 AND machine_fingerprint = $4`,
    payload.code_id,
    act.tenantId,
    act.licenseId,
    act.machineFingerprint,
  );
  if (!issued || issued.issued_at !== payload.issued_at) return invalid("the recovery code is not one this server issued");
  if (issued.consumed_at !== null) return invalid("the recovery code was already used");
  const ageMs = now.getTime() - Date.parse(payload.issued_at);
  if (!(ageMs >= -5 * 60_000 && ageMs <= RECOVERY_INGEST_GRACE_DAYS * 24 * 3600_000)) {
    return invalid("the recovery code is too old");
  }

  const account = items.find((i) => i.entity_type === "user_accounts");
  const grant = items.find((i) => i.entity_type === "user_scope_assignments");
  if (!account || !grant) return invalid("a recovery is an account create and its Administrator grant");
  const accountPayload = parsePayloadObject(account.payload_json);
  const grantPayload = parsePayloadObject(grant.payload_json);
  if (
    account.base_row_version !== null ||
    grant.base_row_version !== null ||
    !accountPayload ||
    !grantPayload ||
    (await livePayload(ctx, "user_accounts", account.entity_sync_id)) !== null
  ) {
    return invalid("a recovery creates a new account");
  }
  if (!truthy(accountPayload["is_active"]) || !blank(accountPayload["deleted_at"]) || truthy(accountPayload["is_admin"])) {
    return invalid("the recovered account must be an active, ordinary account");
  }
  // Recovery items carry no maker signature: every "<who>_by_sync_id" attribution on the recovered
  // account and on its grant may only name the account itself.
  for (const [field, author] of [...Object.entries(accountPayload), ...Object.entries(grantPayload)]) {
    if (field.endsWith("_by_sync_id") && !blank(author) && author !== account.entity_sync_id) {
      return invalid("the recovered account may only name itself as an author");
    }
  }
  const roleSyncId = grantPayload["role_sync_id"];
  const role = typeof roleSyncId === "string" ? await livePayload(ctx, "roles", roleSyncId) : null;
  if (
    grantPayload["user_sync_id"] !== account.entity_sync_id ||
    grantPayload["scope_type"] !== "tenant" ||
    truthy(grantPayload["is_emergency"]) ||
    !blank(grantPayload["deleted_at"]) ||
    !role ||
    !blank(role["deleted_at"]) ||
    typeof role["name"] !== "string" ||
    !ELEVATED_ADMIN_ROLES.has(role["name"])
  ) {
    return invalid("the recovery grant must give the Administrator role, plant-wide, to the recovered account");
  }
  return { kind: "valid", codeId: payload.code_id, accountSyncId: account.entity_sync_id, items: unitItems };
}

/** Marks the code used by the unit; false when it was consumed meanwhile. */
export async function consumeRecoveryCode(db: Database, codeId: string, seq: number, accountSyncId: string): Promise<boolean> {
  const row = await db.get<{ code_id: string }>(
    `UPDATE admin_recovery_codes SET consumed_at = now(), consumed_seq = $2, consumed_entity_sync_id = $3
     WHERE code_id = $1 AND consumed_at IS NULL RETURNING code_id`,
    codeId,
    seq,
    accountSyncId,
  );
  return row !== undefined;
}

// ── Per-item rules ──────────────────────────────────────────────────────────────────────────

async function verifySignatures(
  db: Database,
  act: ActivationSyncContext,
  item: SyncOutboxItemV2,
  signatures: SyncSignature[],
): Promise<Fail | null> {
  const users = new Set<string>();
  for (const sig of signatures) {
    if (users.has(sig.user_sync_id)) return fail("signature_invalid", "two signatures by the same user");
    users.add(sig.user_sync_id);
    const key = await getSigningKey(db, act.tenantId, sig.key_id);
    if (!key || key.user_sync_id !== sig.user_sync_id) {
      return fail("signing_key_unknown", "a signature names a key that is not enrolled for that user");
    }
    if (key.revoked_at !== null) return fail("signing_key_revoked", "a signature was made with a revoked key");
    const raw = decodePublicKey(key.public_key);
    const message = changeSigningMessage({
      tenantId: act.tenantId,
      entityType: item.entity_type,
      entitySyncId: item.entity_sync_id,
      operation: item.operation,
      rowVersion: item.row_version,
      baseRowVersion: item.base_row_version,
      payloadJson: item.payload_json,
      signerUserSyncId: sig.user_sync_id,
      keyId: sig.key_id,
    });
    if (!raw || !verifyEd25519(raw, message, sig.signature)) {
      return fail("signature_invalid", "a signature does not verify for this change");
    }
  }
  return null;
}

/**
 * Rule 4: every author field set/changed, or whose guarded or vouched columns changed, names a
 * signer. Clearing the author withdraws what it vouched for (allowed), but not while a guarded
 * column still holds a claim.
 */
export function checkAuthors(
  registry: SyncEntityRegistry,
  entityType: string,
  payload: Payload,
  previous: Payload | null,
  signers: ReadonlySet<string>,
): Fail | null {
  for (const author of registry.authorFieldsOf(entityType)) {
    const value = payload[author.field];
    const fieldChanged = !same(value, previous?.[author.field]);
    const guardsChanged = author.guards.some((g) => !same(payload[g], previous?.[g]));
    const vouchedChanged = (author.vouches ?? []).some((g) => !same(payload[g], previous?.[g]));
    if (!fieldChanged && !guardsChanged && !vouchedChanged) continue;
    if (blank(value)) {
      // On an update, the author may not be emptied, or left empty while what it vouches for
      // changes, as long as any guarded column still holds a value (design §5 rule 4). A signed
      // create without this author is answered for by its maker (and authority); an unsigned one
      // (a background write) may not record a guarded claim that nobody answers for.
      if ((previous !== null || signers.size === 0) && author.guards.some((g) => !blank(payload[g]))) {
        return fail("author_not_signer", `${author.field} must name the signer of a change to what it vouches for`);
      }
      // Withdrawing a recorded claim (the author and its guarded columns emptied) is a person's
      // act: an unsigned item may not wipe it (it would delete the record's attribution unsigned).
      if (signers.size === 0 && previous !== null && author.guards.length > 0 && !blank(previous[author.field])) {
        return fail("signature_required", `withdrawing ${author.field} must be signed by the person who does it`);
      }
      continue;
    }
    if (typeof value !== "string" || !signers.has(value)) {
      return fail("author_not_signer", `${author.field} names someone who did not sign this change`);
    }
  }
  return null;
}

/**
 * How an accepted item without a maker signature was authenticated by the server, delivered to the
 * PCs so their own arrival checks can accept it: the tenant's founding administrator slot, or a
 * vendor recovery unit.
 */
export type ServerAttestation = "founding" | "recovery";

export type ItemJudgement =
  | { ok: true; signaturesJson: string | null; attestation: ServerAttestation | null }
  | Fail;

/**
 * Judges one validated item that is about to be applied (rules 2–5). `previous` is the server's
 * current payload of the entity (null when absent or deleted).
 */
export async function judgeItem(
  ctx: AuthorityCtx,
  registry: SyncEntityRegistry,
  act: ActivationSyncContext,
  item: SyncOutboxItemV2,
  previous: Payload | null,
  recovery: RecoveryUnit,
  /** The server holds a tombstone of this entity (previous is then null). */
  tombstoned = false,
): Promise<ItemJudgement> {
  if (registry.isServerOnly(item.entity_type)) {
    return fail("server_only_entity_type", `${item.entity_type} is published by the server only`);
  }
  const payload = parsePayloadObject(item.payload_json);
  const signatures = item.signatures ?? [];

  if (recovery.kind !== "none" && item.recovery_code !== undefined && recovery.items.has(item)) {
    if (recovery.kind === "invalid") return fail(recovery.code, recovery.message);
    return { ok: true, signaturesJson: null, attestation: "recovery" };
  }
  if (item.recovery_code !== undefined) {
    return fail("recovery_refused", "recovery_code on an item outside the recovery unit");
  }

  if (await isFoundingItem(ctx.db, act, item, payload, previous)) {
    await closeFoundingSlot(ctx.db, act.tenantId, item.entity_sync_id);
    return { ok: true, signaturesJson: null, attestation: "founding" };
  }

  const bad = await verifySignatures(ctx.db, act, item, signatures);
  if (bad) return bad;
  const signers = new Set(signatures.map((s) => s.user_sync_id));
  const authority = registry.authorityOf(item.entity_type);
  // Rule 3: an authority change always needs its maker's signature, and so does deleting a row
  // that records who did something (its author fields go with it, unchecked by rule 4), except an
  // attachment, whose delete the server archives with its device and can restore. Other changes
  // may arrive unsigned (a scheduler or background write); rule 4 below still refuses any author
  // field the item sets or changes, or whose guarded column it changes, without that person's
  // signature.
  const hasAuthors = registry.authorFieldsOf(item.entity_type).length > 0;
  // "archive" removes the row on every PC like "delete" (row_codec.rs is_delete).
  const removes = item.operation === "delete" || item.operation === "archive";
  const deletesRecord = removes && hasAuthors && !ARCHIVED_ATTACHMENT_TYPES.has(item.entity_type);
  const needsMaker = authority !== undefined || deletesRecord;
  const authorChecked = authority !== undefined || hasAuthors;
  if (needsMaker && signatures.length === 0) {
    return fail(
      "signature_required",
      `${item.entity_type} changes must be signed by the person who made them (update this PC)`,
    );
  }

  if (item.operation !== "delete") {
    // Every operation that carries a row (create, update, upsert, archive) is author-checked; a
    // type that must be signed carries an object payload.
    if (authorChecked && !payload) {
      return fail("invalid_payload", `${item.entity_type} payload_json must be a JSON object`);
    }
    if (payload) {
      const authors = checkAuthors(registry, item.entity_type, payload, previous, signers);
      if (authors) return authors;
    }
  }

  if (authority !== undefined) {
    const verdict = await judgeAuthorityChange(
      ctx,
      {
        entityType: item.entity_type,
        entitySyncId: item.entity_sync_id,
        operation: item.operation,
        payload,
        previous,
        recreatesDeleted: tombstoned && previous === null && item.operation !== "delete",
        right: authority,
      },
      signatures[0]!.user_sync_id,
    );
    if (!verdict.ok) return fail(verdict.code, verdict.message);
  }

  return {
    ok: true,
    signaturesJson: signatures.length > 0 ? JSON.stringify(signatures) : null,
    attestation: null,
  };
}

/** Why a judged user_accounts change revokes that user's keys (design §6), or null. */
export function revocationReason(
  operation: string,
  previous: Payload | null,
  next: Payload | null,
): "password_changed" | "account_disabled" | "account_deleted" | null {
  if (!previous) return null;
  if (operation === "delete" || operation === "archive" || (next && !blank(next["deleted_at"]) && blank(previous["deleted_at"]))) {
    return "account_deleted";
  }
  if (!next) return null;
  if (truthy(previous["is_active"]) && !truthy(next["is_active"])) return "account_disabled";
  if (!same(previous["password_hash"], next["password_hash"])) return "password_changed";
  return null;
}

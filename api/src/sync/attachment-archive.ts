/**
 * Undoable attachment deletes and the forensic device log (CMMS Advisor decision 2026-10-20,
 * migration 017, deploy/SYNC_OPERATIONS.md "Deleted attachments").
 *
 * The sync server knows the sending device (activation: licence + machine fingerprint), never the
 * user, so it cannot prove who deleted a photo. Photos and attachments are the only history that
 * sync may delete; when the server accepts such a delete it keeps the prior row (archive) and an
 * operator can put it back. Separately, every accepted change of the safety settings is kept with
 * its sending device in an append-only log that retention never compacts.
 *
 * Both hooks run inside the exchange transaction, under the per-tenant sync lock, BEFORE the
 * current state is overwritten. They never change what a device is told (accepted / rejected /
 * conflict): they only add rows.
 */
import type { Database } from "../db/database.js";
import { deliveredPayload, insertIngress, upsertEntityState, type IngressInsert } from "./store.js";
import type { PayloadCipher } from "./payload-crypto.js";
import { sha256Hex, type ActivationSyncContext, type SyncOperation } from "./types.js";

/**
 * Attachment types whose sync deletes are archived (and can be restored). The desktop lets sync
 * delete these rows: media_attachments is the one append-only type whose delete is replicated
 * (row_codec.rs apply_row), the other three are OperatorReview types holding a photo or file
 * (registry.rs). Every other deletable type is ordinary operational data, not history.
 */
export const ARCHIVED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "media_attachments",
  "asset_photos",
  "di_attachments",
  "work_order_attachments",
]);

/**
 * Types whose every accepted change is kept with its sending device, durably: per-site safety rules
 * (site_settings, including the three-person lock-removal rule), their change history
 * (site_setting_events) and permit types.
 */
export const FORENSIC_DEVICE_LOG_TYPES: ReadonlySet<string> = new Set(["site_settings", "site_setting_events", "permit_types"]);

/**
 * `origin_machine_fingerprint` / ingress `machine_fingerprint` of a restore. It is no device's
 * fingerprint, so the restored row is delivered to every device, the one that deleted it included.
 */
export const SERVER_RESTORE_ORIGIN = "server:attachment-restore";

/** Payload fields that locate the file (never its content). */
const OBJECT_REF_FIELDS = ["object_key", "content_sha256", "byte_size", "relative_path"] as const;

/** Operations a desktop applies as a removal (row_codec.rs is_delete). */
export function isDeleteOperation(operation: string): boolean {
  return operation === "delete" || operation === "archive";
}

type RawStateRow = {
  row_version: number;
  operation: SyncOperation;
  payload_raw: string;
  payload_hash: string;
  deleted: boolean;
  owner_user_sync_id: string | null;
  origin_machine_fingerprint: string;
  last_ingress_id: number;
};

function objectRefsOf(payloadJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, unknown> = {};
  for (const field of OBJECT_REF_FIELDS) {
    const v = (parsed as Record<string, unknown>)[field];
    if (typeof v === "string" || typeof v === "number") out[field] = v;
  }
  return out;
}

/**
 * Called for every change the exchange (v1 or v2) accepts and appends to the log, before the
 * current state is written. `serverSeq` is the new log row id.
 */
export async function recordAcceptedChange(
  db: Database,
  cipher: PayloadCipher,
  act: ActivationSyncContext,
  ingress: IngressInsert,
  serverSeq: number,
): Promise<void> {
  if (FORENSIC_DEVICE_LOG_TYPES.has(ingress.entityType)) {
    await db.run(
      `INSERT INTO sync_forensic_change_log
         (tenant_id, entity_type, entity_sync_id, operation, row_version, base_row_version, server_seq,
          payload_hash, license_id, machine_fingerprint, protocol_version, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      ingress.tenantId,
      ingress.entityType,
      ingress.entitySyncId,
      ingress.operation,
      ingress.rowVersion,
      ingress.baseRowVersion,
      serverSeq,
      ingress.payloadHash,
      act.licenseId,
      act.machineFingerprint,
      ingress.protocolVersion,
      ingress.receivedAt,
    );
  }
  if (ARCHIVED_ATTACHMENT_TYPES.has(ingress.entityType) && isDeleteOperation(ingress.operation)) {
    await archiveAcceptedDelete(db, cipher, act, ingress, serverSeq);
  }
}

async function archiveAcceptedDelete(
  db: Database,
  cipher: PayloadCipher,
  act: ActivationSyncContext,
  ingress: IngressInsert,
  serverSeq: number,
): Promise<void> {
  // The stored state as is (sealed payloads stay sealed in the archive too).
  const prior = await db.get<RawStateRow>(
    `SELECT row_version, operation, payload_raw, payload_hash, deleted, owner_user_sync_id,
            origin_machine_fingerprint, last_ingress_id
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
    ingress.tenantId,
    ingress.entityType,
    ingress.entitySyncId,
  );
  const priorState = !prior ? "unknown" : prior.deleted || isDeleteOperation(prior.operation) ? "already_deleted" : "present";

  const objectRefs: Record<string, unknown> = {};
  if (prior) {
    try {
      const refs = objectRefsOf(deliveredPayload(cipher, ingress.tenantId, ingress.entityType, ingress.entitySyncId, prior.payload_raw));
      if (Object.keys(refs).length > 0) objectRefs["payload"] = refs;
    } catch {
      // An unreadable sealed value: the raw payload is still archived as stored.
    }
  }
  const manifest = await db.get<{ object_key: string; content_sha256: string; byte_size: number }>(
    `SELECT object_key, content_sha256, byte_size FROM sync_media_manifest WHERE tenant_id = $1 AND entity_sync_id = $2`,
    ingress.tenantId,
    ingress.entitySyncId,
  );
  if (manifest) objectRefs["media_manifest"] = manifest;

  await db.run(
    `INSERT INTO sync_deleted_attachment_archive
       (tenant_id, entity_type, entity_sync_id, prior_state, prior_operation, prior_row_version, prior_payload_raw,
        prior_payload_hash, prior_owner_user_sync_id, prior_origin_machine_fingerprint, prior_last_ingress_id,
        object_refs, delete_operation, delete_row_version, delete_ingress_id, delete_payload_hash,
        deleted_by_license_id, deleted_by_machine_fingerprint, protocol_version, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20)`,
    ingress.tenantId,
    ingress.entityType,
    ingress.entitySyncId,
    priorState,
    prior?.operation ?? null,
    prior?.row_version ?? null,
    prior?.payload_raw ?? null,
    prior?.payload_hash ?? null,
    prior?.owner_user_sync_id ?? null,
    prior?.origin_machine_fingerprint ?? null,
    prior?.last_ingress_id ?? null,
    JSON.stringify(objectRefs),
    ingress.operation,
    ingress.rowVersion,
    serverSeq,
    ingress.payloadHash,
    act.licenseId,
    act.machineFingerprint,
    ingress.protocolVersion,
    ingress.receivedAt,
  );
}

// ── Console: listing and restore ────────────────────────────────────────────────────────────────

export type ArchivedDeleteRow = {
  id: number;
  tenant_id: string;
  entity_type: string;
  entity_sync_id: string;
  prior_state: "present" | "already_deleted" | "unknown";
  prior_operation: string | null;
  prior_row_version: number | null;
  prior_payload_raw: string | null;
  prior_payload_hash: string | null;
  prior_owner_user_sync_id: string | null;
  object_refs: Record<string, unknown>;
  delete_operation: string;
  delete_row_version: number;
  delete_ingress_id: number;
  deleted_by_license_id: string;
  deleted_by_machine_fingerprint: string;
  deleted_at: Date;
  restored_at: Date | null;
  restored_by: string | null;
  restore_reason: string | null;
  restore_audit_record_id: string | null;
  restore_row_version: number | null;
};

const ARCHIVE_COLUMNS = `a.id, a.tenant_id, a.entity_type, a.entity_sync_id, a.prior_state, a.prior_operation,
  a.prior_row_version, a.prior_payload_raw, a.prior_payload_hash, a.prior_owner_user_sync_id, a.object_refs,
  a.delete_operation, a.delete_row_version, a.delete_ingress_id, a.deleted_by_license_id,
  a.deleted_by_machine_fingerprint, a.deleted_at, a.restored_at, a.restored_by, a.restore_reason,
  a.restore_audit_record_id, a.restore_row_version`;

/** Why an archive entry cannot be restored now (null: it can). */
export type RestoreBlocker = "already_restored" | "nothing_to_restore" | "entity_changed_since_delete";

function blockerOf(
  row: Pick<ArchivedDeleteRow, "restored_at" | "prior_state" | "delete_ingress_id" | "delete_row_version">,
  current: { last_ingress_id: number; row_version: number } | null,
): RestoreBlocker | null {
  if (row.restored_at) return "already_restored";
  if (row.prior_state !== "present") return "nothing_to_restore";
  // Restorable only while the current state is still exactly the delete this entry followed: a
  // later change (re-created, updated, deleted again, another restore) wins.
  if (!current || Number(current.last_ingress_id) !== Number(row.delete_ingress_id) || current.row_version !== row.delete_row_version) {
    return "entity_changed_since_delete";
  }
  return null;
}

/** Archive entries of a tenant, newest first, without payloads. */
export async function listArchivedDeletes(
  db: Database,
  input: { tenantId: string; status: "all" | "open" | "restored"; limit: number },
) {
  const statusFilter =
    input.status === "open" ? " AND a.restored_at IS NULL" : input.status === "restored" ? " AND a.restored_at IS NOT NULL" : "";
  const rows = await db.all<ArchivedDeleteRow & { current_last_ingress_id: number | null; current_row_version: number | null }>(
    `SELECT ${ARCHIVE_COLUMNS}, s.last_ingress_id AS current_last_ingress_id, s.row_version AS current_row_version
     FROM sync_deleted_attachment_archive a
     LEFT JOIN sync_entity_state s
       ON s.tenant_id = a.tenant_id AND s.entity_type = a.entity_type AND s.entity_sync_id = a.entity_sync_id
     WHERE a.tenant_id = $1${statusFilter}
     ORDER BY a.deleted_at DESC, a.id DESC
     LIMIT $2`,
    input.tenantId,
    input.limit,
  );
  return rows.map((r) => {
    const current =
      r.current_last_ingress_id === null || r.current_row_version === null
        ? null
        : { last_ingress_id: r.current_last_ingress_id, row_version: r.current_row_version };
    const manifest = (r.object_refs["media_manifest"] ?? null) as { content_sha256?: string; byte_size?: number } | null;
    const fromPayload = (r.object_refs["payload"] ?? null) as { content_sha256?: string; byte_size?: number } | null;
    return {
      id: String(r.id),
      entity_type: r.entity_type,
      entity_sync_id: r.entity_sync_id,
      deleted_at: new Date(r.deleted_at).toISOString(),
      deleted_by: { license_id: r.deleted_by_license_id, machine_fingerprint: r.deleted_by_machine_fingerprint },
      delete_row_version: r.delete_row_version,
      prior_state: r.prior_state,
      prior_row_version: r.prior_row_version,
      // Identifies the file (to compare with a device's copy); never its content or name.
      content_sha256: fromPayload?.content_sha256 ?? manifest?.content_sha256 ?? null,
      byte_size: fromPayload?.byte_size ?? manifest?.byte_size ?? null,
      restored: r.restored_at
        ? {
            at: new Date(r.restored_at).toISOString(),
            by: r.restored_by,
            reason: r.restore_reason,
            audit_record_id: r.restore_audit_record_id,
            row_version: r.restore_row_version,
          }
        : null,
      restore_blocker: blockerOf(r, current),
    };
  });
}

export type RestoreCheck =
  | { ok: true; archive: ArchivedDeleteRow; currentRowVersion: number }
  | { ok: false; status: number; error: "archive_not_found" | RestoreBlocker };

/**
 * Loads an archive entry for restore and checks it may be restored. The caller holds the tenant
 * sync lock (lockTenantSync), so the state cannot change before emitRestore runs.
 */
export async function checkRestorable(db: Database, tenantId: string, archiveId: string): Promise<RestoreCheck> {
  if (!/^\d{1,18}$/.test(archiveId)) return { ok: false, status: 404, error: "archive_not_found" };
  const archive = await db.get<ArchivedDeleteRow>(
    `SELECT ${ARCHIVE_COLUMNS} FROM sync_deleted_attachment_archive a WHERE a.tenant_id = $1 AND a.id = $2 FOR UPDATE`,
    tenantId,
    archiveId,
  );
  if (!archive) return { ok: false, status: 404, error: "archive_not_found" };
  const current = await db.get<{ last_ingress_id: number; row_version: number }>(
    `SELECT last_ingress_id, row_version FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
    tenantId,
    archive.entity_type,
    archive.entity_sync_id,
  );
  const blocker = blockerOf(archive, current ?? null);
  if (blocker) return { ok: false, status: 409, error: blocker };
  return { ok: true, archive, currentRowVersion: current!.row_version };
}

/**
 * Re-issues the archived row to every device: a new log row and current state with the prior
 * payload byte for byte (same payload_hash) at row_version = current + 1 (base = current, the v2
 * rule), from SERVER_RESTORE_ORIGIN. Devices receive it like any other change from another device
 * (exchange delta, snapshot, v1 log). Then marks the archive entry restored.
 */
export async function emitRestore(
  db: Database,
  cipher: PayloadCipher,
  input: {
    archive: ArchivedDeleteRow;
    currentRowVersion: number;
    restoredBy: string;
    reason: string;
    auditRecordId: string;
  },
): Promise<{ serverSeq: number; rowVersion: number }> {
  const a = input.archive;
  const payloadJson = deliveredPayload(cipher, a.tenant_id, a.entity_type, a.entity_sync_id, a.prior_payload_raw!);
  if (sha256Hex(payloadJson) !== a.prior_payload_hash) {
    throw new Error(`archive ${a.id}: prior payload does not match its hash`);
  }
  const now = new Date();
  const rowVersion = input.currentRowVersion + 1;
  const ingress: IngressInsert = {
    tenantId: a.tenant_id,
    idempotencyKey: `server-restore:${a.id}`,
    entityType: a.entity_type,
    entitySyncId: a.entity_sync_id,
    operation: a.prior_operation && !isDeleteOperation(a.prior_operation) ? (a.prior_operation as SyncOperation) : "upsert",
    rowVersion,
    baseRowVersion: input.currentRowVersion,
    ownerUserSyncId: a.prior_owner_user_sync_id,
    payloadJson,
    payloadHash: a.prior_payload_hash!,
    machineFingerprint: SERVER_RESTORE_ORIGIN,
    receivedAt: now.toISOString(),
    protocolVersion: "v2",
  };
  const serverSeq = await insertIngress(db, cipher, ingress);
  if (serverSeq === null) throw new Error(`archive ${a.id} was already re-issued (idempotency key exists)`);
  await upsertEntityState(db, cipher, serverSeq, ingress);
  await db.run(
    `UPDATE sync_deleted_attachment_archive
     SET restored_at = $1, restored_by = $2, restore_reason = $3, restore_audit_record_id = $4,
         restore_ingress_id = $5, restore_row_version = $6
     WHERE tenant_id = $7 AND id = $8 AND restored_at IS NULL`,
    now,
    input.restoredBy,
    input.reason,
    input.auditRecordId,
    serverSeq,
    rowVersion,
    a.tenant_id,
    a.id,
  );
  return { serverSeq, rowVersion };
}

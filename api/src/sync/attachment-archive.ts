/**
 * Undoable attachment deletes / overwrites and the forensic device log (CMMS Advisor decision
 * 2026-10-20, migration 017, deploy/SYNC_OPERATIONS.md "Deleted attachments").
 *
 * The sync server knows the sending device (activation: licence + machine fingerprint), never the
 * user, so it cannot prove who deleted a photo. Photos and attachments are the only history that
 * sync may delete. Rule ("hide but never destroy"): every replacement of a LIVE row of an archived
 * type is archived — a device delete, a device overwrite with another payload, and an operator
 * restore that replaces a live row. Any archived live version can be restored, at any time, as
 * often as needed. Separately, every accepted change of the safety settings is kept with its
 * sending device in an append-only log that retention never compacts.
 *
 * The exchange hooks run inside the exchange transaction, under the per-tenant sync lock, BEFORE
 * the current state is overwritten. They never change what a device is told (accepted / rejected /
 * conflict): they only add rows.
 */
import { randomUUID } from "node:crypto";

import type { Database } from "../db/database.js";
import { deliveredPayload, insertIngress, upsertEntityState, type IngressInsert } from "./store.js";
import type { PayloadCipher } from "./payload-crypto.js";
import { sha256Hex, type ActivationSyncContext, type SyncOperation } from "./types.js";

/**
 * Attachment and document types whose deletes and overwrites are archived (and can be restored).
 * media_attachments is the one append-only type whose delete the desktop replicates
 * (row_codec.rs apply_row; the server refuses deletes of every other append-only type, see
 * registry `append_only`); the others are OperatorReview types holding a photo, a file or a link to
 * a document (registry.rs).
 */
export const ARCHIVED_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "media_attachments",
  "asset_photos",
  "di_attachments",
  "work_order_attachments",
  "library_documents",
  "asset_document_links",
  "inventory_document_links",
]);

/**
 * Types whose every accepted change is kept with its sending device, durably: per-site safety rules
 * (site_settings, including the three-person lock-removal rule), their change history
 * (site_setting_events) and permit types.
 */
export const FORENSIC_DEVICE_LOG_TYPES: ReadonlySet<string> = new Set(["site_settings", "site_setting_events", "permit_types"]);

/**
 * `origin_machine_fingerprint` / ingress `machine_fingerprint` of a restore. It is no device's
 * fingerprint, so the restored row is delivered to every device, the one that changed it included.
 */
export const SERVER_RESTORE_ORIGIN = "server:attachment-restore";

/**
 * Payload fields that reference the file, per the desktop tables: media_attachments object_key /
 * content_sha256 / relative_path; asset_photos, di_attachments, work_order_attachments and
 * library_documents relative_path; asset_document_links and inventory_document_links document_ref.
 * A change of any of them moves or drops the file (locator_changed); other edits (caption, title,
 * notes) do not.
 */
const LOCATOR_FIELDS = ["object_key", "content_sha256", "relative_path", "document_ref"] as const;
/**
 * Locator fields plus the size, copied into object_refs (never file content). The size field per
 * desktop table: media_attachments byte_size, asset_photos file_size_bytes, di_attachments /
 * work_order_attachments / library_documents size_bytes (document links have none).
 */
const SIZE_FIELDS = ["byte_size", "file_size_bytes", "size_bytes"] as const;
const OBJECT_REF_FIELDS = [...LOCATOR_FIELDS, ...SIZE_FIELDS] as const;

/** Records the highest row_version the server accepted for an entity of an archived type. */
async function raiseHighWater(db: Database, ingress: Pick<IngressInsert, "tenantId" | "entityType" | "entitySyncId" | "rowVersion">) {
  await db.run(
    `INSERT INTO sync_attachment_version_high_water (tenant_id, entity_type, entity_sync_id, max_row_version)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, entity_type, entity_sync_id)
       DO UPDATE SET max_row_version = GREATEST(sync_attachment_version_high_water.max_row_version, EXCLUDED.max_row_version)`,
    ingress.tenantId,
    ingress.entityType,
    ingress.entitySyncId,
    ingress.rowVersion,
  );
}

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

function parseObject(payloadJson: string | null): Record<string, unknown> | null {
  if (payloadJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function objectRefsOf(payload: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of OBJECT_REF_FIELDS) {
    const v = payload?.[field];
    if (typeof v === "string" || typeof v === "number") out[field] = v;
  }
  return out;
}

function locatorChanged(before: Record<string, unknown> | null, after: Record<string, unknown> | null): boolean {
  if (!before || !after) return true;
  return LOCATOR_FIELDS.some((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
}

/** Who made a change: a device, or (restore) the server on behalf of an operator. */
type ChangeSource =
  | { kind: "device"; licenseId: string; machineFingerprint: string }
  | { kind: "restore"; operator: string };

/**
 * Archives the state the change is about to replace when that is required: a delete/archive
 * (always), or a non-delete change replacing a live row with a different payload. Returns the new
 * archive id, or null when nothing was archived. Runs before the state write.
 */
async function archiveReplacement(
  db: Database,
  cipher: PayloadCipher,
  ingress: IngressInsert,
  serverSeq: number,
  source: ChangeSource,
): Promise<number | null> {
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
  const isDelete = isDeleteOperation(ingress.operation);
  const changeKind = isDelete ? "delete" : source.kind === "restore" ? "restore" : "overwrite";
  if (!isDelete && (priorState !== "present" || prior!.payload_hash === ingress.payloadHash)) return null;

  let priorPayload: Record<string, unknown> | null = null;
  if (prior) {
    try {
      priorPayload = parseObject(deliveredPayload(cipher, ingress.tenantId, ingress.entityType, ingress.entitySyncId, prior.payload_raw));
    } catch {
      // An unreadable sealed value: the raw payload is still archived as stored.
    }
  }
  const objectRefs: Record<string, unknown> = {};
  const refs = objectRefsOf(priorPayload);
  if (Object.keys(refs).length > 0) objectRefs["payload"] = refs;
  const manifest = await db.get<{ object_key: string; content_sha256: string; byte_size: number }>(
    `SELECT object_key, content_sha256, byte_size FROM sync_media_manifest WHERE tenant_id = $1 AND entity_sync_id = $2`,
    ingress.tenantId,
    ingress.entitySyncId,
  );
  if (manifest) objectRefs["media_manifest"] = manifest;

  const row = await db.get<{ id: number }>(
    `INSERT INTO sync_deleted_attachment_archive
       (tenant_id, entity_type, entity_sync_id, change_kind, prior_state, prior_operation, prior_row_version,
        prior_payload_raw, prior_payload_hash, prior_owner_user_sync_id, prior_origin_machine_fingerprint,
        prior_last_ingress_id, object_refs, locator_changed, change_operation, change_row_version, change_ingress_id,
        change_payload_hash, changed_by_license_id, changed_by_machine_fingerprint, changed_by_operator,
        protocol_version, changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id`,
    ingress.tenantId,
    ingress.entityType,
    ingress.entitySyncId,
    changeKind,
    priorState,
    prior?.operation ?? null,
    prior?.row_version ?? null,
    prior?.payload_raw ?? null,
    prior?.payload_hash ?? null,
    prior?.owner_user_sync_id ?? null,
    prior?.origin_machine_fingerprint ?? null,
    prior?.last_ingress_id ?? null,
    JSON.stringify(objectRefs),
    isDelete ? true : locatorChanged(priorPayload, parseObject(ingress.payloadJson)),
    ingress.operation,
    ingress.rowVersion,
    serverSeq,
    ingress.payloadHash,
    source.kind === "device" ? source.licenseId : null,
    source.kind === "device" ? source.machineFingerprint : SERVER_RESTORE_ORIGIN,
    source.kind === "restore" ? source.operator : null,
    ingress.protocolVersion,
    ingress.receivedAt,
  );
  return row!.id;
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
  if (ARCHIVED_ATTACHMENT_TYPES.has(ingress.entityType)) {
    await raiseHighWater(db, ingress);
    await archiveReplacement(db, cipher, ingress, serverSeq, {
      kind: "device",
      licenseId: act.licenseId,
      machineFingerprint: act.machineFingerprint,
    });
  }
}

// ── Console: listing and restore ────────────────────────────────────────────────────────────────

export type ArchiveRow = {
  id: number;
  tenant_id: string;
  entity_type: string;
  entity_sync_id: string;
  change_kind: "delete" | "overwrite" | "restore";
  prior_state: "present" | "already_deleted" | "unknown";
  prior_operation: string | null;
  prior_row_version: number | null;
  prior_payload_raw: string | null;
  prior_payload_hash: string | null;
  prior_owner_user_sync_id: string | null;
  object_refs: Record<string, unknown>;
  locator_changed: boolean;
  change_operation: string;
  change_row_version: number;
  change_ingress_id: number;
  change_payload_hash: string;
  changed_by_license_id: string | null;
  changed_by_machine_fingerprint: string;
  changed_by_operator: string | null;
  changed_at: Date;
  prior_origin_machine_fingerprint: string | null;
};

const ARCHIVE_COLUMNS = `a.id, a.tenant_id, a.entity_type, a.entity_sync_id, a.change_kind, a.prior_state, a.prior_operation,
  a.prior_row_version, a.prior_payload_raw, a.prior_payload_hash, a.prior_owner_user_sync_id, a.object_refs,
  a.locator_changed, a.change_operation, a.change_row_version, a.change_ingress_id, a.change_payload_hash,
  a.changed_by_license_id, a.changed_by_machine_fingerprint, a.changed_by_operator, a.changed_at,
  a.prior_origin_machine_fingerprint`;

/** The entity's current state on the server (what a restore would replace). */
export type CurrentState = { row_version: number; payload_hash: string; deleted: boolean } | null;

type CurrentStateRow = { row_version: number; payload_hash: string; deleted: boolean; operation: string };

function currentOf(row: CurrentStateRow | undefined | null): CurrentState {
  if (!row) return null;
  return { row_version: Number(row.row_version), payload_hash: row.payload_hash, deleted: row.deleted || isDeleteOperation(row.operation) };
}

type Companion = {
  entity_sync_id: string;
  /** Latest restorable archive entry of the companion when it is not live. */
  archive_id: string | null;
  /** The companion row is live on the server now. */
  live: boolean;
  file_on_server: boolean;
};

export type ListFilter = {
  tenantId: string;
  /**
   * "kept" (default): entries that kept a version (every delete or replacement of a live row);
   * "nothing_kept": deletes of items the server never held or had already deleted; "all": both.
   */
  view: "kept" | "nothing_kept" | "all";
  /** Changes at or after `since` and strictly before `before` (either may be null). */
  since: Date | null;
  before: Date | null;
  /** Opaque cursor from a previous page (next_cursor). */
  cursor: string | null;
  /** Exact item filter. */
  entityType: string | null;
  entitySyncId: string | null;
  /** Only changes sent by this device (fingerprint, or server:attachment-restore). */
  machineFingerprint: string | null;
  /**
   * Only changes of a version that another device (or the server) wrote: a device cannot bury a
   * real entry under entries about rows it wrote and then deleted itself.
   */
  crossDevice: boolean;
  limit: number;
};

/** Page size bounds of the console listing. */
export const ARCHIVE_PAGE_MAX = 200;

/** Position after the last entry of a page: changed_at in epoch microseconds (digits) and id. */
type Cursor = { us: string; id: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Null when the cursor is not one this API issued (the route answers 400 invalid_cursor). */
export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (c === null || typeof c !== "object" || Array.isArray(c)) return null;
    const { us, id } = c as Record<string, unknown>;
    if (Object.keys(c).length !== 2 || typeof us !== "string" || !/^\d{1,16}$/.test(us)) return null;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
    return { us, id };
  } catch {
    return null;
  }
}

/**
 * Archive entries of a tenant, newest first, without payloads. For each: the entity's current
 * state (what a restore would replace, and the expected values the restore must send), its
 * restores, whether a copy of the file is on the server (media manifest), and for an equipment /
 * request / work order attachment its companion "Photo or file" (media_attachments) entry, paired
 * by the same relative_path (the desktop writes both rows with it, assets/photos.rs).
 */
export async function listArchivedChanges(db: Database, input: ListFilter) {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  // Filters shared by the page and the summaries ($1..$5).
  const common = `a.tenant_id = $1
       AND ($2::timestamptz IS NULL OR a.changed_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR a.changed_at < $3::timestamptz)
       AND ($4::text IS NULL OR a.entity_type = $4::text)
       AND ($5::text IS NULL OR a.entity_sync_id = $5::text)`;
  const commonParams = [input.tenantId, input.since, input.before, input.entityType, input.entitySyncId] as const;
  const viewFilter =
    input.view === "kept" ? "AND a.prior_state = 'present'" : input.view === "nothing_kept" ? "AND a.prior_state <> 'present'" : "";
  const deviceFilter = `AND ($9::text IS NULL OR a.changed_by_machine_fingerprint = $9::text)
       AND (NOT $10::boolean OR a.prior_origin_machine_fingerprint IS DISTINCT FROM a.changed_by_machine_fingerprint)`;
  const fetched = await db.all<
    ArchiveRow & {
      cursor_us: string;
      cur_row_version: number | null;
      cur_payload_hash: string | null;
      cur_deleted: boolean | null;
      cur_operation: string | null;
    }
  >(
    `SELECT ${ARCHIVE_COLUMNS}, (extract(epoch FROM a.changed_at) * 1000000)::bigint::text AS cursor_us,
            s.row_version AS cur_row_version,
            s.payload_hash AS cur_payload_hash, s.deleted AS cur_deleted, s.operation AS cur_operation
     FROM sync_deleted_attachment_archive a
     LEFT JOIN sync_entity_state s
       ON s.tenant_id = a.tenant_id AND s.entity_type = a.entity_type AND s.entity_sync_id = a.entity_sync_id
     WHERE ${common} ${viewFilter} ${deviceFilter}
       AND ($6::bigint IS NULL
            OR (a.changed_at, a.id) < ('epoch'::timestamptz + $6::bigint * interval '1 microsecond', $7::bigint))
     ORDER BY a.changed_at DESC, a.id DESC
     LIMIT $8`,
    ...commonParams,
    cursor?.us ?? null,
    cursor?.id ?? null,
    input.limit + 1,
    input.machineFingerprint,
    input.crossDevice,
  );
  const rows = fetched.slice(0, input.limit);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > input.limit && last ? encodeCursor({ us: last.cursor_us, id: Number(last.id) }) : null;
  // Entries that kept nothing (deletes of items the server never held or had already deleted):
  // counts per sending device and type, so a flood of them never hides the real entries.
  const nothingKept = (
    await db.all<{
      changed_by_machine_fingerprint: string;
      changed_by_license_id: string | null;
      entity_type: string;
      n: number;
      last_at: Date;
    }>(
      `SELECT a.changed_by_machine_fingerprint, a.changed_by_license_id, a.entity_type, count(*)::int AS n,
              max(a.changed_at) AS last_at
       FROM sync_deleted_attachment_archive a
       WHERE ${common} AND a.prior_state <> 'present'
       GROUP BY a.changed_by_machine_fingerprint, a.changed_by_license_id, a.entity_type
       ORDER BY n DESC, a.changed_by_machine_fingerprint, a.entity_type
       LIMIT 100`,
      ...commonParams,
    )
  ).map((r) => ({
    machine_fingerprint: r.changed_by_machine_fingerprint,
    license_id: r.changed_by_license_id,
    entity_type: r.entity_type,
    count: r.n,
    last_at: new Date(r.last_at).toISOString(),
  }));
  const ids = rows.map((r) => String(r.id));
  const restores = new Map<number, { at: string; by: string; reason: string; audit_record_id: string; row_version: number }[]>();
  if (ids.length > 0) {
    const log = await db.all<{
      archive_id: number;
      restored_at: Date;
      restored_by: string;
      reason: string;
      audit_record_id: string;
      restore_row_version: number;
    }>(
      `SELECT archive_id, restored_at, restored_by, reason, audit_record_id, restore_row_version
       FROM sync_attachment_restore_log WHERE tenant_id = $1 AND archive_id = ANY($2::bigint[]) ORDER BY id`,
      input.tenantId,
      ids,
    );
    for (const l of log) {
      const list = restores.get(Number(l.archive_id)) ?? [];
      list.push({
        at: new Date(l.restored_at).toISOString(),
        by: l.restored_by,
        reason: l.reason,
        audit_record_id: l.audit_record_id,
        row_version: Number(l.restore_row_version),
      });
      restores.set(Number(l.archive_id), list);
    }
  }

  const refsOf = (r: ArchiveRow) =>
    (r.object_refs["payload"] ?? null) as { content_sha256?: string; byte_size?: number; relative_path?: string } | null;

  // Companions by relative path: live media rows first, else their latest restorable archive entry.
  const paths = [
    ...new Set(rows.filter((r) => r.entity_type !== "media_attachments").map((r) => refsOf(r)?.relative_path).filter((p): p is string => !!p)),
  ];
  const companions = new Map<string, Companion>();
  if (paths.length > 0) {
    const live = await db.all<{ entity_sync_id: string; relative_path: string }>(
      `SELECT entity_sync_id, payload_json ->> 'relative_path' AS relative_path FROM sync_entity_state
       WHERE tenant_id = $1 AND entity_type = 'media_attachments' AND NOT deleted
         AND payload_json ->> 'relative_path' = ANY($2::text[])`,
      input.tenantId,
      paths,
    );
    for (const m of live) companions.set(m.relative_path, { entity_sync_id: m.entity_sync_id, archive_id: null, live: true, file_on_server: false });
    const archived = await db.all<{ id: number; entity_sync_id: string; relative_path: string }>(
      `SELECT DISTINCT ON (object_refs -> 'payload' ->> 'relative_path')
              id, entity_sync_id, object_refs -> 'payload' ->> 'relative_path' AS relative_path
       FROM sync_deleted_attachment_archive
       WHERE tenant_id = $1 AND entity_type = 'media_attachments' AND prior_state = 'present'
         AND object_refs -> 'payload' ->> 'relative_path' = ANY($2::text[])
       ORDER BY object_refs -> 'payload' ->> 'relative_path', id DESC`,
      input.tenantId,
      paths,
    );
    for (const m of archived) {
      if (!companions.has(m.relative_path)) {
        companions.set(m.relative_path, { entity_sync_id: m.entity_sync_id, archive_id: String(m.id), live: false, file_on_server: false });
      }
    }
  }
  const mediaIds = [
    ...new Set([...rows.filter((r) => r.entity_type === "media_attachments").map((r) => r.entity_sync_id), ...[...companions.values()].map((c) => c.entity_sync_id)]),
  ];
  const onServer = new Set(
    mediaIds.length === 0
      ? []
      : (
          await db.all<{ entity_sync_id: string }>(
            "SELECT entity_sync_id FROM sync_media_manifest WHERE tenant_id = $1 AND entity_sync_id = ANY($2::text[])",
            input.tenantId,
            mediaIds,
          )
        ).map((m) => m.entity_sync_id),
  );
  for (const c of companions.values()) c.file_on_server = onServer.has(c.entity_sync_id);

  // Entries that kept a version, per sending device (with how many are about a version another
  // device wrote): builds the console's device picker and shows a device flooding its own rows.
  const keptSummary = (
    await db.all<{ changed_by_machine_fingerprint: string; changed_by_license_id: string | null; n: number; cross: number; last_at: Date }>(
      `SELECT a.changed_by_machine_fingerprint, a.changed_by_license_id, count(*)::int AS n,
              count(*) FILTER (WHERE a.prior_origin_machine_fingerprint IS DISTINCT FROM a.changed_by_machine_fingerprint)::int AS cross,
              max(a.changed_at) AS last_at
       FROM sync_deleted_attachment_archive a
       WHERE ${common} AND a.prior_state = 'present'
       GROUP BY a.changed_by_machine_fingerprint, a.changed_by_license_id
       ORDER BY n DESC, a.changed_by_machine_fingerprint
       LIMIT 100`,
      ...commonParams,
    )
  ).map((r) => ({
    machine_fingerprint: r.changed_by_machine_fingerprint,
    license_id: r.changed_by_license_id,
    count: r.n,
    cross_device_count: r.cross,
    last_at: new Date(r.last_at).toISOString(),
  }));

  const items = rows.map((r) => {
    const manifest = (r.object_refs["media_manifest"] ?? null) as { content_sha256?: string; byte_size?: number } | null;
    const fromPayload = refsOf(r) as (ReturnType<typeof refsOf> & { file_size_bytes?: number; size_bytes?: number }) | null;
    const isMedia = r.entity_type === "media_attachments";
    const companion = isMedia || !fromPayload?.relative_path ? null : (companions.get(fromPayload.relative_path) ?? null);
    const current = currentOf(
      r.cur_row_version === null
        ? null
        : { row_version: r.cur_row_version, payload_hash: r.cur_payload_hash!, deleted: r.cur_deleted!, operation: r.cur_operation! },
    );
    return {
      id: String(r.id),
      entity_type: r.entity_type,
      entity_sync_id: r.entity_sync_id,
      change_kind: r.change_kind,
      locator_changed: r.locator_changed,
      changed_at: new Date(r.changed_at).toISOString(),
      /** The device (or server) that wrote the archived version. */
      prior_origin: r.prior_origin_machine_fingerprint,
      changed_by: {
        license_id: r.changed_by_license_id,
        machine_fingerprint: r.changed_by_machine_fingerprint,
        operator: r.changed_by_operator,
      },
      change_row_version: Number(r.change_row_version),
      prior_state: r.prior_state,
      prior_row_version: r.prior_row_version === null ? null : Number(r.prior_row_version),
      prior_payload_hash: r.prior_payload_hash,
      // Identifies the file (to compare with a device's copy); never its content or name.
      content_sha256: fromPayload?.content_sha256 ?? manifest?.content_sha256 ?? null,
      byte_size: fromPayload?.byte_size ?? fromPayload?.file_size_bytes ?? fromPayload?.size_bytes ?? manifest?.byte_size ?? null,
      // A copy of the file is on the server (media manifest): for a media row its own, otherwise
      // its companion's; null when unknown (no companion found).
      file_on_server: isMedia ? onServer.has(r.entity_sync_id) || manifest !== null : companion ? companion.file_on_server : null,
      companion,
      /** Only an entry that archived a live row has something to bring back. */
      restorable: r.prior_state === "present",
      /** The entity now; a restore must send these values back (expected_current_*). */
      current,
      restores: restores.get(Number(r.id)) ?? [],
    };
  });
  return { items, next_cursor: nextCursor, nothing_kept_summary: nothingKept, kept_summary: keptSummary };
}

export type RestoreExpectation = { row_version: number | null; payload_hash: string | null; deleted: boolean | null };

export type RestoreCheck =
  | { ok: true; archive: ArchiveRow; current: CurrentState }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Loads an archive entry for restore. Any entry that archived a live row can be restored, whatever
 * happened since; the operator confirms what it replaces by sending back the entity's current
 * version and hash from the listing (optimistic concurrency). The caller holds the tenant sync
 * lock (lockTenantSync), so the state cannot change before emitRestore runs.
 */
export async function checkRestorable(
  db: Database,
  tenantId: string,
  archiveId: string,
  expected: RestoreExpectation,
): Promise<RestoreCheck> {
  if (!/^\d{1,18}$/.test(archiveId)) return { ok: false, status: 404, body: { error: "archive_not_found" } };
  const archive = await db.get<ArchiveRow>(
    `SELECT ${ARCHIVE_COLUMNS} FROM sync_deleted_attachment_archive a WHERE a.tenant_id = $1 AND a.id = $2`,
    tenantId,
    archiveId,
  );
  if (!archive) return { ok: false, status: 404, body: { error: "archive_not_found" } };
  if (archive.prior_state !== "present") return { ok: false, status: 409, body: { error: "nothing_to_restore" } };
  const current = currentOf(
    await db.get<CurrentStateRow>(
      `SELECT row_version, payload_hash, deleted, operation FROM sync_entity_state
       WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
      tenantId,
      archive.entity_type,
      archive.entity_sync_id,
    ),
  );
  if (
    (current?.row_version ?? null) !== expected.row_version ||
    (current?.payload_hash ?? null) !== expected.payload_hash ||
    (current?.deleted ?? null) !== expected.deleted
  ) {
    return { ok: false, status: 409, body: { error: "entity_changed_since_listing", current } };
  }
  return { ok: true, archive, current };
}

/**
 * Re-issues the archived prior row to every device: a new log row and current state with the
 * prior payload byte for byte (same payload_hash) at row_version = (highest version seen: current,
 * prior, every archived version) + 1 with
 * base = current (a v1 change may carry a lower version than the row it replaced), from
 * SERVER_RESTORE_ORIGIN. If it replaces a live row with another payload, that row is archived first
 * (change_kind 'restore'), so a restore never destroys a version either. Then records the restore.
 */
export async function emitRestore(
  db: Database,
  cipher: PayloadCipher,
  input: {
    archive: ArchiveRow;
    current: CurrentState;
    operator: string;
    reason: string;
    auditRecordId: string;
  },
): Promise<{ serverSeq: number; rowVersion: number; replacedArchiveId: number | null }> {
  const a = input.archive;
  const payloadJson = deliveredPayload(cipher, a.tenant_id, a.entity_type, a.entity_sync_id, a.prior_payload_raw!);
  if (sha256Hex(payloadJson) !== a.prior_payload_hash) {
    throw new Error(`archive ${a.id}: prior payload does not match its hash`);
  }
  const now = new Date();
  const currentVersion = input.current?.row_version ?? 0;
  // Above every version the server has seen for this entity (a v1 device can write versions back
  // down, ABA, also with identical re-sends that are not archived): the current one, every archived
  // one and the durable high-water mark (kept when the ingress log is compacted; migration 017
  // backfilled it from the log and the current state, so older history is covered too).
  const seen = await db.get<{ archived: number | null; high_water: number | null }>(
    `SELECT
       (SELECT MAX(GREATEST(COALESCE(prior_row_version, 0), change_row_version)) FROM sync_deleted_attachment_archive
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3) AS archived,
       (SELECT max_row_version FROM sync_attachment_version_high_water
         WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3) AS high_water`,
    a.tenant_id,
    a.entity_type,
    a.entity_sync_id,
  );
  const rowVersion =
    Math.max(
      currentVersion,
      Number(a.prior_row_version ?? 0),
      Number(seen?.archived ?? 0),
      Number(seen?.high_water ?? 0),
    ) + 1;
  const ingress: IngressInsert = {
    tenantId: a.tenant_id,
    idempotencyKey: `server-restore:${a.id}:${randomUUID()}`,
    entityType: a.entity_type,
    entitySyncId: a.entity_sync_id,
    operation: a.prior_operation && !isDeleteOperation(a.prior_operation) ? (a.prior_operation as SyncOperation) : "upsert",
    rowVersion,
    baseRowVersion: input.current ? currentVersion : null,
    ownerUserSyncId: a.prior_owner_user_sync_id,
    payloadJson,
    payloadHash: a.prior_payload_hash!,
    machineFingerprint: SERVER_RESTORE_ORIGIN,
    receivedAt: now.toISOString(),
    protocolVersion: "v2",
  };
  const serverSeq = await insertIngress(db, cipher, ingress);
  if (serverSeq === null) throw new Error(`archive ${a.id}: restore idempotency key collision`);
  await raiseHighWater(db, ingress);
  const replacedArchiveId = await archiveReplacement(db, cipher, ingress, serverSeq, { kind: "restore", operator: input.operator });
  await upsertEntityState(db, cipher, serverSeq, ingress);
  await db.run(
    `INSERT INTO sync_attachment_restore_log
       (tenant_id, archive_id, restored_at, restored_by, reason, audit_record_id, restore_ingress_id,
        restore_row_version, replaced_archive_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    a.tenant_id,
    a.id,
    now,
    input.operator,
    input.reason,
    input.auditRecordId,
    serverSeq,
    rowVersion,
    replacedArchiveId,
  );
  return { serverSeq, rowVersion, replacedArchiveId };
}

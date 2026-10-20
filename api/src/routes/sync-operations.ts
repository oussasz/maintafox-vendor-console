/**
 * Sync operations per device (master plan Phase 4.5): a timeline built only from what the sync
 * store recorded (exchanges, retries, refused items, conflicts, resynchronisations, operator
 * actions on the machine), and the repair action — a full resynchronisation of the device.
 *
 * Why resynchronisation is the repair: the server keeps no payload of refused items (only their
 * ids and reasons), so it cannot replay them; the device keeps them (its dead letters) and replays
 * them from its Sync Center. What the server can do is make the device rebuild its copy from a full
 * snapshot, which also resends its unsent changes (exchange-v2.ts, snapshot.ts).
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { PRIVILEGED_REASON_MIN_LENGTH } from "../app/config.js";
import { resolveActorId, sendValidationError } from "../app/http.js";
import { structuredLog } from "../app/runtime.js";
import { collectSyncHealth } from "../ops/sync-health.js";
import { checkRestorable, emitRestore, listArchivedDeletes } from "../sync/attachment-archive.js";
import { lockTenantSync } from "../sync/store.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

/** Default and maximum span of the timeline. */
export const DEVICE_TIMELINE_DEFAULT_HOURS = 72;
export const DEVICE_TIMELINE_MAX_HOURS = 24 * 30;
/** Events of each kind returned at most (newest first). */
export const DEVICE_TIMELINE_MAX_EVENTS_PER_KIND = 200;

/** Archived attachment deletes returned at most (newest first). */
export const DELETED_ATTACHMENTS_MAX_ROWS = 500;

const DeletedAttachmentsQuery = z
  .object({ status: z.enum(["all", "open", "restored"]).optional() })
  .strict();

const TimelineQuery = z
  .object({ hours: z.coerce.number().int().min(1).max(DEVICE_TIMELINE_MAX_HOURS).optional() })
  .strict();

type TimelineEvent = {
  at: string;
  kind: "exchange" | "rejection" | "conflict" | "resync_requested" | "resync_completed" | "operator_action";
  detail: Record<string, unknown>;
};

const iso = (v: Date | string): string => new Date(v).toISOString();

export function registerSyncOperationsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, requirePrivilegedAction, runIdempotent, payloadCipher } = ctx;

  async function loadActivation(tenantId: string, fp: string) {
    return db.get<{
      machine_fingerprint: string;
      app_version: string | null;
      activated_at: string;
      last_seen_at: string;
      revoked_at: string | null;
      revocation_kind: string | null;
    }>(
      `SELECT machine_fingerprint, app_version, activated_at, last_seen_at, revoked_at, revocation_kind
       FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`,
      tenantId,
      fp,
    );
  }

  app.get("/api/v1/ops/devices/:tenantId/:machineFingerprint/timeline", authMiddleware, async (req, res) => {
    const parsed = TimelineQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed, "query");
      return;
    }
    const { tenantId, machineFingerprint: fp } = req.params;
    const activation = await loadActivation(tenantId, fp);
    if (!activation) {
      res.status(404).json({ error: "activation_not_found" });
      return;
    }
    const hours = parsed.data.hours ?? DEVICE_TIMELINE_DEFAULT_HOURS;
    const since = new Date(Date.now() - hours * 3600_000);
    const limit = DEVICE_TIMELINE_MAX_EVENTS_PER_KIND;
    const events: TimelineEvent[] = [];

    const exchanges = await db.all<{ created_at: Date; server_batch_id: string; replay_count: number; last_replay_at: Date | null }>(
      `SELECT created_at, server_batch_id, replay_count, last_replay_at FROM sync_exchange_idempotency_v2
       WHERE tenant_id = ? AND machine_fingerprint = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ${limit}`,
      tenantId,
      fp,
      since,
    );
    for (const e of exchanges) {
      events.push({
        at: iso(e.created_at),
        kind: "exchange",
        detail: { server_batch_id: e.server_batch_id, retries: e.replay_count, last_retry_at: e.last_replay_at ? iso(e.last_replay_at) : null },
      });
    }
    const rejections = await db.all<{
      created_at_rfc3339: string;
      entity_type: string | null;
      entity_sync_id: string;
      rejection_code: string;
      server_batch_id: string | null;
    }>(
      `SELECT created_at_rfc3339, entity_type, entity_sync_id, rejection_code, server_batch_id FROM sync_rejection_log
       WHERE tenant_id = ? AND machine_fingerprint = ? AND created_at_rfc3339 >= ? ORDER BY id DESC LIMIT ${limit}`,
      tenantId,
      fp,
      since.toISOString(),
    );
    for (const r of rejections) {
      events.push({
        at: r.created_at_rfc3339,
        kind: "rejection",
        detail: { entity_type: r.entity_type, entity_sync_id: r.entity_sync_id, code: r.rejection_code, server_batch_id: r.server_batch_id },
      });
    }
    const conflicts = await db.all<{
      created_at: Date;
      entity_type: string;
      entity_sync_id: string;
      local_row_version: number;
      server_row_version: number;
    }>(
      `SELECT created_at, entity_type, entity_sync_id, local_row_version, server_row_version FROM sync_conflict_log
       WHERE tenant_id = ? AND machine_fingerprint = ? AND created_at >= ? ORDER BY id DESC LIMIT ${limit}`,
      tenantId,
      fp,
      since,
    );
    for (const c of conflicts) {
      events.push({
        at: iso(c.created_at),
        kind: "conflict",
        detail: {
          entity_type: c.entity_type,
          entity_sync_id: c.entity_sync_id,
          device_version: c.local_row_version,
          server_version: c.server_row_version,
        },
      });
    }
    const resyncs = await db.all<{ requested_at: Date; requested_by: string; reason: string; completed_at: Date | null }>(
      `SELECT requested_at, requested_by, reason, completed_at FROM sync_device_resync_request
       WHERE tenant_id = ? AND machine_fingerprint = ? AND (requested_at >= ? OR completed_at >= ? OR completed_at IS NULL)
       ORDER BY requested_at DESC LIMIT ${limit}`,
      tenantId,
      fp,
      since,
      since,
    );
    for (const r of resyncs) {
      events.push({ at: iso(r.requested_at), kind: "resync_requested", detail: { by: r.requested_by, reason: r.reason } });
      if (r.completed_at) events.push({ at: iso(r.completed_at), kind: "resync_completed", detail: {} });
    }
    const actions = await db.all<{ occurred_at_rfc3339: string; actor_id: string; action_code: string; reason_code: string | null }>(
      `SELECT occurred_at_rfc3339, actor_id, action_code, reason_code FROM audit_records
       WHERE scope_tenant_id = ? AND entity_refs_json::jsonb ->> 'machine_id' = ? AND occurred_at_rfc3339 >= ?
       ORDER BY sequence DESC LIMIT ${limit}`,
      tenantId,
      fp,
      since.toISOString(),
    );
    for (const a of actions) {
      events.push({ at: a.occurred_at_rfc3339, kind: "operator_action", detail: { actor: a.actor_id, action: a.action_code, reason: a.reason_code } });
    }
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    const health = await collectSyncHealth(db);
    const measured = health.devices.find((d) => d.tenant_id === tenantId && d.machine_id === fp) ?? null;
    const openResync = resyncs.find((r) => r.completed_at === null) ?? null;
    res.json({
      tenant_id: tenantId,
      machine_id: fp,
      hours,
      device: {
        app_version: activation.app_version,
        activated_at: activation.activated_at,
        last_seen_at: activation.last_seen_at,
        revoked_at: activation.revoked_at,
        revocation_kind: activation.revocation_kind,
      },
      measured,
      open_resync: openResync
        ? { requested_at: iso(openResync.requested_at), requested_by: openResync.requested_by, reason: openResync.reason }
        : null,
      events,
    });
  });

  /**
   * Repair: full resynchronisation of one device (step-up `sync_repair`, reason, audited). Its next
   * exchange is refused with invalid_checkpoint_token; the desktop keeps its unsent changes, drops
   * its checkpoint, downloads a full snapshot, then sends them. Closed by that snapshot.
   */
  app.post("/api/v1/ops/devices/:tenantId/:machineFingerprint/resync", authMiddleware, async (req, res) => {
    const { tenantId, machineFingerprint: fp } = req.params;
    const reason = req.header("X-Operator-Reason")?.trim() ?? "";
    if (reason.length < PRIVILEGED_REASON_MIN_LENGTH) {
      res.status(403).json({ error: "privileged_action_guard_failed", reason: "missing_reason_code" });
      return;
    }
    await runIdempotent(req, res, async () => {
      const activation = await loadActivation(tenantId, fp);
      if (!activation) return { status: 404, body: { error: "activation_not_found" } };
      if (activation.revoked_at) {
        return { status: 409, body: { error: "slot_not_held", revocation_kind: activation.revocation_kind } };
      }
      const open = await db.get<{ id: number }>(
        "SELECT id FROM sync_device_resync_request WHERE tenant_id = ? AND machine_fingerprint = ? AND completed_at IS NULL",
        tenantId,
        fp,
      );
      if (open) return { status: 409, body: { error: "resync_already_requested" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "sync_device_resync",
        action_category: "sync_repair",
        step_up_kind: StepUpKinds.syncRepair,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, machine_id: fp },
        payload: { reason },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        `INSERT INTO sync_device_resync_request (tenant_id, machine_fingerprint, requested_by, reason, audit_record_id)
         VALUES (?, ?, ?, ?, ?)`,
        tenantId,
        fp,
        resolveActorId(req),
        reason,
        guard.auditRecordId,
      );
      structuredLog("sync_device_resync_requested", { tenant_id: tenantId, machine_fingerprint: fp });
      return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
    });
  });

  /**
   * Photos, attachments and document links deleted or replaced by synchronisation (archive,
   * migration 017), newest first: entity, when, the device that sent the change, whether a copy of
   * the file is on the server, the companion "Photo or file" entry, whether it was restored and whether it can be
   * restored now. Never the payload or the file.
   */
  app.get("/api/v1/tenants/:tenantId/sync/deleted-attachments", authMiddleware, async (req, res) => {
    const parsed = DeletedAttachmentsQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "query");
      return;
    }
    const { tenantId } = req.params;
    const tenant = await db.get<{ id: string }>("SELECT id FROM tenants WHERE id = ?", tenantId);
    if (!tenant) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    const items = await listArchivedDeletes(db, {
      tenantId,
      status: parsed.data.status ?? "all",
      limit: DELETED_ATTACHMENTS_MAX_ROWS,
    });
    // Operator reasons and device ids: not for shared caches.
    res.setHeader("Cache-Control", "no-store");
    res.json({ tenant_id: tenantId, items });
  });

  /**
   * Restore: re-issues the archived row to every device as a new server-originated change (same
   * payload, row_version = current + 1). Reason + step-up `sync_attachment_restore`, audited
   * (sync_attachment_restored). Refusals: 404 tenant_not_found | archive_not_found;
   * 409 already_restored | nothing_to_restore (no live row before the delete) |
   * entity_changed_since_delete (re-created, updated or deleted again since the archived change).
   */
  app.post("/api/v1/tenants/:tenantId/sync/deleted-attachments/:archiveId/restore", authMiddleware, async (req, res) => {
    const { tenantId, archiveId } = req.params;
    const reason = req.header("X-Operator-Reason")?.trim() ?? "";
    if (reason.length < PRIVILEGED_REASON_MIN_LENGTH) {
      res.status(403).json({ error: "privileged_action_guard_failed", reason: "missing_reason_code" });
      return;
    }
    await runIdempotent(req, res, async () => {
      // The tenant sync lock first (like every sync writer: exchanges append under it, so server_seq
      // values become visible in order and the state checked below cannot change before the
      // restore is written), then the guard's audit-chain lock.
      await lockTenantSync(db, tenantId);
      const tenant = await db.get<{ id: string }>("SELECT id FROM tenants WHERE id = ?", tenantId);
      if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
      const check = await checkRestorable(db, tenantId, archiveId);
      if (!check.ok) return { status: check.status, body: { error: check.error } };
      const { archive } = check;
      const guard = await requirePrivilegedAction(req, {
        action_code: "sync_attachment_restored",
        action_category: "sync_repair",
        step_up_kind: StepUpKinds.syncAttachmentRestore,
        scope_tenant_id: tenantId,
        entity_refs: { tenant_id: tenantId, machine_id: archive.changed_by_machine_fingerprint },
        // Identifiers only, never the payload.
        payload: {
          archive_id: String(archive.id),
          entity_type: archive.entity_type,
          entity_sync_id: archive.entity_sync_id,
          change_kind: archive.change_kind,
          changed_by_machine_fingerprint: archive.changed_by_machine_fingerprint,
          changed_by_license_id: archive.changed_by_license_id,
          change_row_version: archive.change_row_version,
          payload_hash: archive.prior_payload_hash,
          reason,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const emitted = await emitRestore(db, payloadCipher, {
        archive,
        currentRowVersion: check.currentRowVersion,
        restoredBy: resolveActorId(req),
        reason,
        auditRecordId: guard.auditRecordId,
      });
      structuredLog("sync_attachment_restored", {
        tenant_id: tenantId,
        archive_id: String(archive.id),
        entity_type: archive.entity_type,
        server_seq: emitted.serverSeq,
      });
      return {
        status: 200,
        body: {
          ok: true,
          archive_id: String(archive.id),
          entity_type: archive.entity_type,
          entity_sync_id: archive.entity_sync_id,
          row_version: emitted.rowVersion,
          server_seq: emitted.serverSeq,
          audit_record_id: guard.auditRecordId,
        },
      };
    });
  });
}

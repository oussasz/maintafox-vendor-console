/**
 * Phone enrolment as the customer's desktop manages it (migration 020, owner-approved 2026-10-29):
 * issue an enrolment for one person at one site, follow or cancel it, list the enrolled phones and
 * revoke them (one phone, or every phone of a person whose account was disabled). A removed phone
 * confirms its wipe here too. The phone side (redeem) is in routes/activation.ts.
 *
 * Who may do this is decided on the desktop: these routes need an activated desktop of the tenant,
 * and the desktop requires its user-admin right and a fresh step-up before calling them (the same
 * trust as sync, where the desktop's checks decide what its users may change). Each step is kept
 * on the tenant's rows and appended to the vendor audit ledger.
 */
import type express from "express";

import type { ApiContext } from "../app/context.js";
import { JWT_SECRET } from "../app/config.js";
import { MOBILE_NOT_LICENSED_BODY } from "../app/device-class.js";
import { deviceRateLimiter, sendValidationError, type ActivationAuthContext } from "../app/http.js";
import {
  ActorBody,
  appendEnrolmentAudit,
  finalUploadOpen,
  ENROLMENT_TTL_SECONDS,
  enrolmentSecretHash,
  formatEnrolmentCode,
  IssueEnrolmentBody,
  newEnrolmentCode,
  newEnrolmentToken,
  RevokeDeviceBody,
  RevokePersonBody,
} from "../app/mobile-enrolment.js";
import { newId, structuredLog } from "../app/runtime.js";

type MobileDeviceRow = {
  id: string;
  machine_fingerprint: string;
  machine_label: string | null;
  person_sync_id: string | null;
  person_label: string | null;
  site_sync_id: string | null;
  site_label: string | null;
  enrolled_by_label: string | null;
  enrolled_at: string | null;
  activated_at: string;
  last_seen_at: string;
  last_exchange_at: string | null;
  app_version: string | null;
  revoked_at: string | null;
  revoked_by_label: string | null;
  revoke_reason: string | null;
  revocation_kind: string | null;
  wiped_at: string | null;
};

type RevokedPhone = { id: string; machine_fingerprint: string; license_id: string };

type RevokeReason = "admin" | "user_disabled" | "lost";

/** How many times issuing retries when a new secret collides with an existing one. */
const ISSUE_ATTEMPTS = 3;

function activationOf(req: express.Request): ActivationAuthContext | undefined {
  return (req as express.Request & { activation?: ActivationAuthContext }).activation;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "23505";
}

function enrolmentStatus(row: {
  expires_at: string;
  cancelled_at: string | null;
  redeemed_at: string | null;
}): "pending" | "redeemed" | "cancelled" | "expired" {
  if (row.redeemed_at) return "redeemed";
  if (row.cancelled_at) return "cancelled";
  return new Date(row.expires_at) <= new Date() ? "expired" : "pending";
}

function isoOrNull(v: string | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

export function registerMobileEnrolmentRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, activationAuthMiddleware, countActiveActivations, appendAuditRecord } = ctx;

  /** Desktop routes are refused to phones (403 desktop_only). Undefined after answering. */
  function requireDesktop(req: express.Request, res: express.Response): ActivationAuthContext | undefined {
    const act = activationOf(req);
    if (!act) {
      res.status(401).json({ error: "missing_token" });
      return undefined;
    }
    if (act.deviceClass !== "desktop") {
      res.status(403).json({ error: "desktop_only", message: "Phones are managed from a desktop." });
      return undefined;
    }
    return act;
  }

  /** Open (not used, not cancelled, not expired) enrolments of a licence: slots promised but not taken. */
  async function countOpenEnrolments(licenseId: string): Promise<number> {
    const row = await db.get<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_enrolments
       WHERE license_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > now()`,
      licenseId,
    );
    return row?.n ?? 0;
  }

  /**
   * Issues an enrolment. Refused early when the licence has no free phone slot, counting the
   * phones enrolled and the enrolments still open (redeem checks the slot again). A previous open
   * enrolment of the same person is cancelled first: one QR per person at a time.
   */
  app.post("/api/v1/mobile-enrolments", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const parsed = IssueEnrolmentBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;
    const outcome = await db.tx(async () => {
      await db.lockXact("license-slots", act.licenseId);
      const lic = await db.get<{ max_mobile_devices: number }>(
        "SELECT max_mobile_devices FROM license_keys WHERE id = ? AND tenant_id = ?",
        act.licenseId,
        act.tenantId,
      );
      if (!lic || lic.max_mobile_devices <= 0) {
        return { ok: false as const, status: 403, body: { ...MOBILE_NOT_LICENSED_BODY } as Record<string, unknown> };
      }
      const issuedAt = new Date();
      // This person's open enrolment is replaced by the new one, so it does not count as used.
      const personOpen = await db.get<{ n: number }>(
        `SELECT count(*)::int AS n FROM mobile_enrolments
         WHERE license_id = ? AND person_sync_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > now()`,
        act.licenseId,
        input.person_sync_id,
      );
      const used =
        (await countActiveActivations(act.licenseId, "mobile")) +
        (await countOpenEnrolments(act.licenseId)) -
        (personOpen?.n ?? 0);
      if (used >= lic.max_mobile_devices) {
        return {
          ok: false as const,
          status: 409,
          body: {
            error: "slot_limit_reached",
            device_class: "mobile",
            limit: lic.max_mobile_devices,
            max_mobile_devices: lic.max_mobile_devices,
          } as Record<string, unknown>,
        };
      }
      const replaced = await db.all<{ id: string }>(
        `UPDATE mobile_enrolments SET cancelled_at = ?, cancelled_by_label = ?, cancelled_by_sync_id = ?
         WHERE tenant_id = ? AND person_sync_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > ?
         RETURNING id`,
        issuedAt.toISOString(),
        input.issued_by_label,
        input.issued_by_sync_id,
        act.tenantId,
        input.person_sync_id,
        issuedAt.toISOString(),
      );
      const expiresAt = new Date(issuedAt.getTime() + ENROLMENT_TTL_SECONDS * 1000);
      for (let attempt = 1; ; attempt += 1) {
        const id = newId("enr");
        const token = newEnrolmentToken();
        const code = newEnrolmentCode();
        try {
          await db.savepoint(() =>
            db.run(
              `INSERT INTO mobile_enrolments
                 (id, tenant_id, license_id, token_hash, code_hash, person_sync_id, person_label, site_sync_id,
                  site_label, issued_by_sync_id, issued_by_label, issued_by_machine, issued_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              act.tenantId,
              act.licenseId,
              enrolmentSecretHash(JWT_SECRET, "token", token),
              enrolmentSecretHash(JWT_SECRET, "code", code),
              input.person_sync_id,
              input.person_label,
              input.site_sync_id,
              input.site_label,
              input.issued_by_sync_id,
              input.issued_by_label,
              act.machineFingerprint,
              issuedAt.toISOString(),
              expiresAt.toISOString(),
            ),
          );
        } catch (e) {
          if (isUniqueViolation(e) && attempt < ISSUE_ATTEMPTS) continue;
          throw e;
        }
        return {
          ok: true as const,
          enrolment: {
            enrolment_id: id,
            token,
            code: formatEnrolmentCode(code),
            issued_at: issuedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          },
          replacedIds: replaced.map((r) => r.id),
        };
      }
    });
    if (!outcome.ok) {
      structuredLog("mobile_enrolment_issue_refused", {
        tenant_id: act.tenantId,
        license_id: act.licenseId,
        status: outcome.status,
        error: outcome.body.error,
      });
      res.status(outcome.status).json(outcome.body);
      return;
    }
    structuredLog("mobile_enrolment_issued", {
      tenant_id: act.tenantId,
      license_id: act.licenseId,
      enrolment_id: outcome.enrolment.enrolment_id,
      issued_by_machine: act.machineFingerprint,
    });
    await appendEnrolmentAudit(db, appendAuditRecord, {
      action_code: "mobile_enrolment_issued",
      actor: `device:${act.machineFingerprint}`,
      tenantId: act.tenantId,
      licenseId: act.licenseId,
      machineFingerprint: act.machineFingerprint,
      payload: {
        enrolment_id: outcome.enrolment.enrolment_id,
        person_sync_id: input.person_sync_id,
        site_sync_id: input.site_sync_id,
        issued_by_sync_id: input.issued_by_sync_id,
        expires_at: outcome.enrolment.expires_at,
        replaced_enrolment_ids: outcome.replacedIds,
      },
    });
    // The secrets are returned once, here; only their hashes are stored.
    res.status(201).json(outcome.enrolment);
  });

  /** Where an enrolment stands (the desktop's QR dialog follows it until the phone has used it). */
  app.get("/api/v1/mobile-enrolments/:enrolmentId", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const row = await db.get<{
      id: string;
      person_sync_id: string;
      person_label: string;
      site_sync_id: string;
      site_label: string;
      issued_at: string;
      expires_at: string;
      cancelled_at: string | null;
      redeemed_at: string | null;
      activation_id: string | null;
    }>(
      `SELECT id, person_sync_id, person_label, site_sync_id, site_label, issued_at, expires_at, cancelled_at,
              redeemed_at, activation_id
       FROM mobile_enrolments WHERE id = ? AND tenant_id = ?`,
      req.params.enrolmentId,
      act.tenantId,
    );
    if (!row) {
      res.status(404).json({ error: "enrolment_not_found" });
      return;
    }
    res.json({
      enrolment_id: row.id,
      status: enrolmentStatus(row),
      person_sync_id: row.person_sync_id,
      person_label: row.person_label,
      site_sync_id: row.site_sync_id,
      site_label: row.site_label,
      issued_at: isoOrNull(row.issued_at),
      expires_at: isoOrNull(row.expires_at),
      redeemed_at: isoOrNull(row.redeemed_at),
      cancelled_at: isoOrNull(row.cancelled_at),
      device_id: row.activation_id,
    });
  });

  /** Cancels an enrolment not used yet. One already used, cancelled or expired is left as it is. */
  app.post("/api/v1/mobile-enrolments/:enrolmentId/cancel", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const parsed = ActorBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const enrolmentId = req.params.enrolmentId;
    const outcome = await db.tx(async () => {
      await db.lockXact("mobile-enrolment", enrolmentId);
      const row = await db.get<{ expires_at: string; cancelled_at: string | null; redeemed_at: string | null; license_id: string }>(
        "SELECT expires_at, cancelled_at, redeemed_at, license_id FROM mobile_enrolments WHERE id = ? AND tenant_id = ?",
        enrolmentId,
        act.tenantId,
      );
      if (!row) return undefined;
      const before = enrolmentStatus(row);
      if (before !== "pending") return { status: before, changed: false, licenseId: row.license_id };
      await db.run(
        "UPDATE mobile_enrolments SET cancelled_at = now(), cancelled_by_label = ?, cancelled_by_sync_id = ? WHERE id = ?",
        parsed.data.actor_label,
        parsed.data.actor_sync_id,
        enrolmentId,
      );
      return { status: "cancelled" as const, changed: true, licenseId: row.license_id };
    });
    if (!outcome) {
      res.status(404).json({ error: "enrolment_not_found" });
      return;
    }
    if (outcome.changed) {
      structuredLog("mobile_enrolment_cancelled", { tenant_id: act.tenantId, enrolment_id: enrolmentId });
      await appendEnrolmentAudit(db, appendAuditRecord, {
        action_code: "mobile_enrolment_cancelled",
        actor: `device:${act.machineFingerprint}`,
        tenantId: act.tenantId,
        licenseId: outcome.licenseId,
        machineFingerprint: act.machineFingerprint,
        payload: { enrolment_id: enrolmentId, cancelled_by_sync_id: parsed.data.actor_sync_id },
      });
    }
    res.json({ enrolment_id: enrolmentId, status: outcome.status, changed: outcome.changed });
  });

  /**
   * The tenant's phones: enrolled ones, and removed ones still waiting to upload and wipe. Last
   * sync is the phone's last data exchange (null until its first one).
   */
  app.get("/api/v1/mobile-devices", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const rows = await db.all<MobileDeviceRow>(
      `SELECT a.id, a.machine_fingerprint, a.machine_label, a.person_sync_id, a.person_label, a.site_sync_id,
              a.site_label, a.enrolled_by_label, a.enrolled_at, a.activated_at, a.last_seen_at, a.app_version,
              a.revoked_at, a.revoked_by_label, a.revoke_reason, a.revocation_kind, a.wiped_at, c.last_exchange_at
       FROM machine_activations a
       LEFT JOIN sync_device_checkpoint c
         ON c.tenant_id = a.tenant_id AND c.machine_fingerprint = a.machine_fingerprint
       WHERE a.tenant_id = ? AND a.device_class = 'mobile'
         AND (a.revoked_at IS NULL OR (a.revocation_kind = 'tenant_admin' AND a.wiped_at IS NULL))
       ORDER BY a.person_label NULLS LAST, a.enrolled_at`,
      act.tenantId,
    );
    const lic = await db.get<{ max_mobile_devices: number }>(
      "SELECT max_mobile_devices FROM license_keys WHERE id = ? AND tenant_id = ?",
      act.licenseId,
      act.tenantId,
    );
    res.json({
      max_mobile_devices: lic?.max_mobile_devices ?? 0,
      active_mobile_devices: await countActiveActivations(act.licenseId, "mobile"),
      open_enrolments: await countOpenEnrolments(act.licenseId),
      // Removed phones stay listed while they may still upload and wipe (not lost, within the window).
      devices: rows.filter((r) => !r.revoked_at || finalUploadOpen(r)).map((r) => ({
        device_id: r.id,
        machine_label: r.machine_label,
        person_sync_id: r.person_sync_id,
        person_label: r.person_label,
        site_sync_id: r.site_sync_id,
        site_label: r.site_label,
        enrolled_by_label: r.enrolled_by_label,
        enrolled_at: isoOrNull(r.enrolled_at) ?? isoOrNull(r.activated_at),
        last_sync_at: isoOrNull(r.last_exchange_at),
        last_seen_at: isoOrNull(r.last_seen_at),
        app_version: r.app_version,
        status: r.revoked_at ? "wipe_pending" : "active",
        revoked_at: isoOrNull(r.revoked_at),
        revoked_by_label: r.revoked_by_label,
      })),
    });
  });

  /**
   * Revokes phones: the slot is free at once; at its next contact the phone uploads its pending
   * work (push only) and wipes itself (activationAuthMiddleware wipeOnly), unless it is reported
   * lost (no upload). Phones already revoked are left as they are.
   *
   * For a person (account disabled), every licence slot lock of the tenant is taken first (as the
   * issue route and redeem take theirs before touching enrolment rows), then their open enrolments
   * are cancelled and their phones read. A redeem in flight for that person either committed before
   * (its phone is found and revoked) or spends nothing: its spend re-checks that the enrolment is
   * still open, and an issue in flight committed before or waits for this revocation.
   */
  async function revokePhones(
    act: ActivationAuthContext,
    where: { deviceId: string } | { personSyncId: string },
    actor: { actor_sync_id: string | null; actor_label: string },
    reason: RevokeReason,
  ): Promise<{ revoked: RevokedPhone[]; cancelledEnrolments: string[] }> {
    return db.tx(async () => {
      const cancelledEnrolments: string[] = [];
      if ("personSyncId" in where) {
        const licences = await db.all<{ id: string }>(
          "SELECT id FROM license_keys WHERE tenant_id = ? ORDER BY id",
          act.tenantId,
        );
        for (const l of licences) await db.lockXact("license-slots", l.id);
        const cancelled = await db.all<{ id: string }>(
          `UPDATE mobile_enrolments SET cancelled_at = now(), cancelled_by_label = ?, cancelled_by_sync_id = ?
           WHERE tenant_id = ? AND person_sync_id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
           RETURNING id`,
          actor.actor_label,
          actor.actor_sync_id,
          act.tenantId,
          where.personSyncId,
        );
        cancelledEnrolments.push(...cancelled.map((r) => r.id).sort());
      }
      const candidates =
        "deviceId" in where
          ? await db.all<RevokedPhone>(
              `SELECT id, machine_fingerprint, license_id FROM machine_activations
               WHERE tenant_id = ? AND device_class = 'mobile' AND revoked_at IS NULL AND id = ?`,
              act.tenantId,
              where.deviceId,
            )
          : await db.all<RevokedPhone>(
              `SELECT id, machine_fingerprint, license_id FROM machine_activations
               WHERE tenant_id = ? AND device_class = 'mobile' AND revoked_at IS NULL AND person_sync_id = ?
               ORDER BY id`,
              act.tenantId,
              where.personSyncId,
            );
      const revoked: RevokedPhone[] = [];
      for (const c of candidates) {
        // Same lock order as a claim or a redeem: licence slots, then the device.
        await db.lockXact("license-slots", c.license_id);
        await db.lockXact("activation-device", `${act.tenantId}:${c.machine_fingerprint}`);
        const changed = await db.run(
          `UPDATE machine_activations
           SET revoked_at = now(), revocation_kind = 'tenant_admin', revoked_by_label = ?, revoked_by_sync_id = ?,
               revoke_reason = ?, wiped_at = NULL
           WHERE id = ? AND revoked_at IS NULL`,
          actor.actor_label,
          actor.actor_sync_id,
          reason,
          c.id,
        );
        if (changed.changes > 0) revoked.push(c);
      }
      return { revoked, cancelledEnrolments };
    });
  }

  async function auditRevocations(
    act: ActivationAuthContext,
    result: { revoked: RevokedPhone[]; cancelledEnrolments: string[] },
    actorSyncId: string | null,
    reason: RevokeReason,
  ): Promise<void> {
    for (const r of result.revoked) {
      structuredLog("mobile_device_revoked", { tenant_id: act.tenantId, device_id: r.id, reason });
      await appendEnrolmentAudit(db, appendAuditRecord, {
        action_code: "mobile_device_revoked",
        actor: `device:${act.machineFingerprint}`,
        tenantId: act.tenantId,
        licenseId: r.license_id,
        machineFingerprint: r.machine_fingerprint,
        payload: { device_id: r.id, reason, revoked_by_sync_id: actorSyncId },
      });
    }
    for (const id of result.cancelledEnrolments) {
      await appendEnrolmentAudit(db, appendAuditRecord, {
        action_code: "mobile_enrolment_cancelled",
        actor: `device:${act.machineFingerprint}`,
        tenantId: act.tenantId,
        licenseId: act.licenseId,
        machineFingerprint: act.machineFingerprint,
        payload: { enrolment_id: id, reason, cancelled_by_sync_id: actorSyncId },
      });
    }
  }

  app.post("/api/v1/mobile-devices/:deviceId/revoke", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const parsed = RevokeDeviceBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { lost, ...actor } = parsed.data;
    const reason: RevokeReason = lost ? "lost" : "admin";
    const exists = await db.get<{ id: string }>(
      "SELECT id FROM machine_activations WHERE id = ? AND tenant_id = ? AND device_class = 'mobile'",
      req.params.deviceId,
      act.tenantId,
    );
    if (!exists) {
      res.status(404).json({ error: "device_not_found" });
      return;
    }
    const result = await revokePhones(act, { deviceId: exists.id }, actor, reason);
    await auditRevocations(act, result, actor.actor_sync_id, reason);
    res.json({ device_id: exists.id, revoked_now: result.revoked.length > 0 });
  });

  /** Every phone and open enrolment of a person: called when the person's account is disabled. */
  app.post("/api/v1/mobile-devices/revoke-person", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = requireDesktop(req, res);
    if (!act) return;
    const parsed = RevokePersonBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const { person_sync_id: personSyncId, ...actor } = parsed.data;
    const result = await revokePhones(act, { personSyncId }, actor, "user_disabled");
    await auditRevocations(act, result, actor.actor_sync_id, "user_disabled");
    res.json({
      person_sync_id: personSyncId,
      revoked_device_ids: result.revoked.map((r) => r.id),
      cancelled_enrolment_ids: result.cancelledEnrolments,
    });
  });

  /**
   * A removed phone confirms it uploaded its pending work and erased its data. From then on its
   * token is refused everywhere (activation_revoked) and it leaves the desktop's list.
   */
  app.post("/api/v1/mobile-device/wipe-confirmed", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = activationOf(req);
    if (!act) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    if (!act.wipeOnly) {
      res.status(409).json({ error: "wipe_not_requested" });
      return;
    }
    const row = await db.get<{ id: string }>(
      `UPDATE machine_activations SET wiped_at = now()
       WHERE tenant_id = ? AND license_id = ? AND machine_fingerprint = ? AND wiped_at IS NULL
         AND revoked_at IS NOT NULL AND revocation_kind = 'tenant_admin'
       RETURNING id`,
      act.tenantId,
      act.licenseId,
      act.machineFingerprint,
    );
    if (row) {
      structuredLog("mobile_device_wiped", { tenant_id: act.tenantId, device_id: row.id });
      await appendEnrolmentAudit(db, appendAuditRecord, {
        action_code: "mobile_device_wiped",
        actor: `device:${act.machineFingerprint}`,
        tenantId: act.tenantId,
        licenseId: act.licenseId,
        machineFingerprint: act.machineFingerprint,
        payload: { device_id: row.id },
      });
    }
    res.json({ wiped: true });
  });
}

/**
 * Device sync: exchange (protocol v1 and v2), snapshot, media presign.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { SYNC_MAX_OUTBOX_BATCH } from "../app/config.js";
import {
  MOBILE_NOT_LICENSED_BODY,
  deviceClassMismatchBody,
  requestedDeviceClass,
  type DeviceClass,
} from "../app/device-class.js";
import { deviceRateLimiter, sendValidationError, type ActivationAuthContext } from "../app/http.js";
import { getMediaStore, sendObjectStoreError } from "../app/media.js";
import { DEVICE_WIPE_REQUIRED_BODY } from "../app/mobile-enrolment.js";
import { structuredLog } from "../app/runtime.js";
import { assertTenantOwnsObjectKey, buildTenantMediaObjectKey } from "../storage/object-store.js";
import {
  runSyncExchangeV1,
  runSyncExchangeV2,
  runSyncSnapshotV2,
  SyncRequestError,
  SyncSnapshotBodyV2,
  syncExchangeBodyV2,
} from "../sync/index.js";

/** Desktop sync push — additive fields allowed (device_class, media_manifest, tenant_config). */
const SyncExchangeOutboxItem = z
  .object({
    idempotency_key: z.string().min(1).max(256),
    entity_type: z.string().min(1).max(256),
    entity_sync_id: z.string().min(1).max(256),
    operation: z.enum(["create", "update", "delete", "upsert", "archive"]),
    row_version: z.number().int().nonnegative(),
    payload_json: z.string().min(1),
    payload_hash: z.string().min(1).max(128),
  })
  .strict();

const SyncExchangeBody = z.object({
  protocol_version: z.literal("v1"),
  checkpoint_token: z.string().nullable().optional(),
  idempotency_key: z.string().min(8).max(128),
  outbox_batch: z.array(SyncExchangeOutboxItem).max(SYNC_MAX_OUTBOX_BATCH),
  device_class: z.enum(["desktop", "mobile"]).optional(),
  media_manifest: z.array(z.unknown()).optional(),
  tenant_config: z.unknown().optional(),
});

/** Sync protocol v2 request (deploy/SYNC_PROTOCOL_V2.md); same batch cap as v1. */
const SyncExchangeBodyV2 = syncExchangeBodyV2(SYNC_MAX_OUTBOX_BATCH);

const SyncMediaPresignPutBody = z
  .object({
    parent_entity_type: z.string().min(1).max(128),
    parent_entity_sync_id: z.string().min(1).max(256),
    content_sha256: z.string().min(64).max(80),
    object_key: z.string().min(1).max(1024).optional(),
  })
  .strict();

const SyncMediaPresignGetBody = z
  .object({
    object_key: z.string().min(1).max(1024),
  })
  .strict();

function sendSyncRequestError(res: express.Response, err: SyncRequestError): void {
  res.status(err.status).json({ error: err.code, message: err.message });
}

/**
 * Re-checks the device class on the data exchange (v1, v2) and the snapshot: the class a request
 * carries (absent = desktop, which every desktop released before the mobile app is) must be the
 * class of the activation behind the bearer token. Returns false after answering 409
 * device_class_mismatch. (The licence check of phones is `deviceMaySync` below.)
 *
 * Scope: only these routes carry a device class. Media, diagnostics, notifications, updates and
 * tenant status still need a live activation (which holds a slot of its own class), so no class
 * can use them without a paid slot; they do not re-check the class.
 */
function deviceClassMatches(
  res: express.Response,
  act: ActivationAuthContext,
  sent: DeviceClass | undefined,
  route: string,
): boolean {
  const requested = requestedDeviceClass(sent);
  if (requested === act.deviceClass) return true;
  structuredLog("sync_device_class_mismatch", {
    tenant_id: act.tenantId,
    machine_fingerprint: act.machineFingerprint,
    route,
    device_class: act.deviceClass,
    requested_device_class: requested,
  });
  res.status(409).json(deviceClassMismatchBody(act.deviceClass, requested));
  return false;
}

export function registerSyncRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, syncConfig, syncEntityRegistry, payloadCipher, activationAuthMiddleware } = ctx;

  /**
   * The class check, then, for a phone, its licence: a licence whose phone count is 0 (never set,
   * or set back to 0 by an operator) stops its phones at once, here as on policy refresh (403
   * mobile_not_licensed). Desktops are not affected. Returns false after answering.
   */
  async function deviceMaySync(
    res: express.Response,
    act: ActivationAuthContext,
    sent: DeviceClass | undefined,
    route: string,
  ): Promise<boolean> {
    if (!deviceClassMatches(res, act, sent, route)) return false;
    if (act.deviceClass !== "mobile") return true;
    const lic = (await db.get("SELECT max_mobile_devices FROM license_keys WHERE id = ?", act.licenseId)) as
      | { max_mobile_devices: number }
      | undefined;
    if (lic && lic.max_mobile_devices > 0) return true;
    structuredLog("sync_mobile_not_licensed", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      route,
    });
    res.status(403).json({ ...MOBILE_NOT_LICENSED_BODY });
    return false;
  }

  /**
   * Tenant-runtime sync: push local outbox rows and pull inbound changes with the activation token.
   * `protocol_version` selects the protocol: v1 (unchanged for old desktops) or v2
   * (deploy/SYNC_PROTOCOL_V2.md).
   */
  app.post("/api/v1/sync/exchange", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!act) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const syncAct = { tenantId: act.tenantId, licenseId: act.licenseId, machineFingerprint: act.machineFingerprint };
    const protocolVersion = (req.body as { protocol_version?: unknown } | undefined)?.protocol_version;
    // A phone being wiped uploads with protocol v2 only (the field app's protocol), push only.
    if (act.wipeOnly && protocolVersion !== "v2") {
      res.status(403).json({ ...DEVICE_WIPE_REQUIRED_BODY });
      return;
    }
    try {
      if (protocolVersion === "v2") {
        const parsed = SyncExchangeBodyV2.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "validation_error", details: parsed.error.flatten() });
          return;
        }
        // The final upload of a phone being wiped is accepted even if its licence no longer
        // counts phones: its pending field work is not lost. The class still has to match.
        if (act.wipeOnly ? !deviceClassMatches(res, act, parsed.data.device_class, "exchange_v2_final_upload") : !(await deviceMaySync(res, act, parsed.data.device_class, "exchange_v2"))) return;
        const outcome = await runSyncExchangeV2(
          db,
          { registry: syncEntityRegistry, checkpointSecret: syncConfig.checkpointSecret, cipher: payloadCipher },
          syncAct,
          req.body,
          parsed.data,
          structuredLog,
          { pushOnly: act.wipeOnly },
        );
        if (outcome.replayed) res.setHeader("X-Idempotent-Replay", "true");
        res.json(outcome.response);
        return;
      }
      const parsed = SyncExchangeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
        return;
      }
      if (!(await deviceMaySync(res, act, parsed.data.device_class, "exchange_v1"))) return;
      res.json(await runSyncExchangeV1(db, { registry: syncEntityRegistry, cipher: payloadCipher }, syncAct, parsed.data, structuredLog));
    } catch (e) {
      if (e instanceof SyncRequestError) {
        structuredLog("sync_exchange_refused", {
          tenant_id: act.tenantId,
          machine_fingerprint: act.machineFingerprint,
          status: e.status,
          error: e.code,
        });
        sendSyncRequestError(res, e);
        return;
      }
      structuredLog("sync_exchange_error", {
        tenant_id: act.tenantId,
        machine_fingerprint: act.machineFingerprint,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ error: "sync_exchange_failed" });
    }
  });

  /** Protocol v2 bootstrap: paged current state, then a checkpoint for deltas. */
  app.post("/api/v1/sync/snapshot", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!act) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const parsed = SyncSnapshotBodyV2.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error", details: parsed.error.flatten() });
      return;
    }
    if (!(await deviceMaySync(res, act, parsed.data.device_class, "snapshot_v2"))) return;
    try {
      const response = await runSyncSnapshotV2(
        db,
        { checkpointSecret: syncConfig.checkpointSecret, cipher: payloadCipher },
        { tenantId: act.tenantId, licenseId: act.licenseId, machineFingerprint: act.machineFingerprint },
        parsed.data,
        structuredLog,
      );
      res.json(response);
    } catch (e) {
      if (e instanceof SyncRequestError) {
        sendSyncRequestError(res, e);
        return;
      }
      structuredLog("sync_snapshot_error", {
        tenant_id: act.tenantId,
        machine_fingerprint: act.machineFingerprint,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ error: "sync_snapshot_failed" });
    }
  });

  /**
   * Whether a phone removed by its administrator (wipeOnly) may upload this object: only a file of
   * its own work. The server keeps no owner per object, so ownership is what this phone itself
   * exchanged: a media_manifest entry it reported for exactly this key and content hash, whose
   * media_attachments record it pushed (sync_mirror_ingress row of this device). One announced
   * without its record is refused.
   */
  async function removedPhoneOwnsMedia(act: ActivationAuthContext, objectKey: string, contentSha256: string): Promise<boolean> {
    const row = await db.get<{ ok: number }>(
      `SELECT 1 AS ok
       FROM sync_media_manifest m
       WHERE m.tenant_id = $1 AND m.object_key = $2 AND m.content_sha256 = $3
         AND m.reported_by_machine_fingerprint = $4
         AND EXISTS (
           SELECT 1 FROM sync_mirror_ingress i
           WHERE i.tenant_id = m.tenant_id AND i.machine_fingerprint = $4
             AND i.entity_type = 'media_attachments' AND i.entity_sync_id = m.entity_sync_id
         )
       LIMIT 1`,
      act.tenantId,
      objectKey,
      contentSha256,
      act.machineFingerprint,
    );
    return row?.ok === 1;
  }

  /** Whether another device of the tenant announced this object key in its own media manifest. */
  async function announcedByAnotherDevice(act: ActivationAuthContext, objectKey: string): Promise<boolean> {
    const row = await db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM sync_media_manifest
       WHERE tenant_id = $1 AND object_key = $2 AND reported_by_machine_fingerprint <> $3
       LIMIT 1`,
      act.tenantId,
      objectKey,
      act.machineFingerprint,
    );
    return row?.ok === 1;
  }

  /** 409 for a removed phone: the file is (or will be) on the server already; it counts as uploaded. */
  function sendMediaAlreadyStored(res: express.Response, act: ActivationAuthContext, why: string): void {
    structuredLog("media_presign_put_refused", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      reason: "media_already_stored",
      why,
    });
    res.status(409).json({
      error: "media_already_stored",
      message: "This file is already on the server (same key, same content): it counts as uploaded.",
    });
  }

  /**
   * Presigned PUT for one media object of the tenant.
   *
   * For phones the URL is bound to the content: the key's last segment must be the file's SHA-256
   * (`{env}/media/{tenant}/{parent type}/{parent sync id}/{content sha256}`) and the URL carries it
   * as a signed `x-amz-checksum-sha256` header that the phone must send (`headers` in the answer);
   * the store refuses other bytes, so a phone can never replace a file with different content.
   * Desktops get an unbound URL as before (their uploader does not send the header yet).
   *
   * A phone removed by its administrator may still call it during its upload window
   * (activationAuthMiddleware wipeOnly), for its own files only (removedPhoneOwnsMedia), the key
   * matching the body; 409 media_already_stored when the key is another device's announced file or
   * the object already exists (content-addressed: the phone counts it as uploaded).
   */
  app.post("/api/v1/sync/media/presign-put", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!act) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const media = getMediaStore();
    const parsed = SyncMediaPresignPutBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed);
      return;
    }
    const givenKey = parsed.data.object_key?.trim();
    if (!givenKey && !media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    let objectKey: string;
    try {
      objectKey =
        givenKey ||
        buildTenantMediaObjectKey({
          deploymentEnv: media!.config.deploymentEnv,
          tenantId: act.tenantId,
          parentEntityType: parsed.data.parent_entity_type,
          parentEntitySyncId: parsed.data.parent_entity_sync_id,
          contentSha256: parsed.data.content_sha256,
        });
    } catch (e) {
      res.status(400).json({
        error: "presign_put_failed",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!assertTenantOwnsObjectKey(act.tenantId, objectKey)) {
      res.status(403).json({ error: "object_key_tenant_mismatch" });
      return;
    }
    const segments = objectKey.split("/");
    const keySha = segments[segments.length - 1] ?? "";
    if (act.deviceClass === "mobile" && !/^[0-9a-f]{64}$/.test(keySha)) {
      res.status(400).json({
        error: "presign_put_failed",
        message: "A phone's object key must end with the file's SHA-256 (64 lowercase hex characters).",
      });
      return;
    }
    if (act.wipeOnly) {
      const [, , , parentType, parentSyncId, sha, ...rest] = segments;
      const sent = parsed.data;
      const canonical =
        rest.length === 0 &&
        parentType === sent.parent_entity_type.trim() &&
        parentSyncId === sent.parent_entity_sync_id.trim() &&
        sha === sent.content_sha256.trim().toLowerCase();
      if (!canonical || !(await removedPhoneOwnsMedia(act, objectKey, keySha))) {
        structuredLog("media_presign_put_refused", {
          tenant_id: act.tenantId,
          machine_fingerprint: act.machineFingerprint,
          reason: "media_not_from_this_device",
        });
        res.status(403).json({
          error: "media_not_from_this_device",
          message: "A removed phone may upload only the files of its own work that it announced in its final upload.",
        });
        return;
      }
      if (await announcedByAnotherDevice(act, objectKey)) {
        sendMediaAlreadyStored(res, act, "announced_by_another_device");
        return;
      }
    }
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    try {
      if (act.wipeOnly && (await media.headObject(objectKey))) {
        sendMediaAlreadyStored(res, act, "object_exists");
        return;
      }
      res.json(
        act.deviceClass === "mobile"
          ? await media.presignPutWithChecksum(objectKey, keySha)
          : await media.presignPut(objectKey),
      );
    } catch (e) {
      sendObjectStoreError(res, "media_presign_put_failed", e, { tenant_id: act.tenantId });
    }
  });

  app.post("/api/v1/sync/media/presign-get", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!act) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const parsed = SyncMediaPresignGetBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed);
      return;
    }
    const objectKey = parsed.data.object_key.trim();
    if (!assertTenantOwnsObjectKey(act.tenantId, objectKey)) {
      res.status(403).json({ error: "object_key_tenant_mismatch" });
      return;
    }
    try {
      res.json(await media.presignGet(objectKey));
    } catch (e) {
      sendObjectStoreError(res, "media_presign_get_failed", e, { tenant_id: act.tenantId });
    }
  });
}

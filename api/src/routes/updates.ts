/**
 * Desktop update manifest (master plan Phase 5.3): the Tauri updater's endpoint.
 *
 *   GET /api/v1/updates/:target/:arch/:currentVersion   (device activation token)
 *   optional header X-Maintafox-Rollback-To: x.y.z      (rollback after a failed migration)
 *
 * 204 = nothing to install. 200 = Tauri's "dynamic update server" JSON
 * ({ version, notes, pub_date, url, signature }) plus a `maintafox` object the desktop reads from the
 * raw response: release_id, kind upgrade|rollback, mandatory, mandatory_reason, min_version, notes
 * in both languages. The decision itself is releases/update-manifest.ts.
 *
 * Tauri v2 fills {{target}} = "windows" and {{arch}} = "x86_64" on the desktop's only platform;
 * the catalog stores artifacts under exactly those values.
 *
 * Forced updates (R4-S2): the URL's current version plays the role of policy refresh's
 * app_version and goes through the same resolveForceUpdatePolicy (app/force-update.ts). The route
 * accepts only the versions that function can read (MAJOR.MINOR.PATCH[-pre], parseStrictAppVersion):
 * anything else is a 400, never an "up to date" 204, so the manifest can never call a version fine
 * that policy refresh blocks. `url` is a presigned download of the signed installer; the desktop
 * re-checks the manifest right before downloading, so a recall stops installs at the next check.
 */
import type express from "express";

import type { ApiContext } from "../app/context.js";
import { deviceRateLimiter, type ActivationAuthContext } from "../app/http.js";
import { getMediaStore } from "../app/media.js";
import { parseStrictAppVersion, resolveForceUpdatePolicy } from "../app/force-update.js";
import { structuredLog, type ForceUpdateMode } from "../app/runtime.js";
import {
  forcedUpdateReason,
  isUpdateChannel,
  RELEASE_VERSION_RE,
  resolveUpdate,
  type UpdateCandidate,
} from "../releases/update-manifest.js";

/** Validity of the presigned installer download handed to a device. */
const UPDATE_DOWNLOAD_URL_TTL_SECONDS = 3600;
const PLATFORM_SEGMENT_RE = /^[a-z0-9_-]{1,32}$/;

type CandidateRow = UpdateCandidate & {
  notes_en: string;
  notes_fr: string;
  published_at: Date | string | null;
  object_key: string;
  updater_signature: string;
};

export function registerUpdatesRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, activationAuthMiddleware } = ctx;

  app.get("/api/v1/updates/:target/:arch/:currentVersion", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation!;
    const { target, arch, currentVersion } = req.params as { target: string; arch: string; currentVersion: string };
    if (!PLATFORM_SEGMENT_RE.test(target) || !PLATFORM_SEGMENT_RE.test(arch) || !parseStrictAppVersion(currentVersion)) {
      res.status(400).json({ error: "invalid_update_request" });
      return;
    }
    const rollbackHeader = req.header("X-Maintafox-Rollback-To")?.trim() || null;
    if (rollbackHeader !== null && !RELEASE_VERSION_RE.test(rollbackHeader)) {
      res.status(400).json({ error: "invalid_rollback_version" });
      return;
    }

    const lic = await db.get<{
      update_channel: string;
      rollout_cohort: string;
      force_min_app_version: string | null;
      force_update_mode: ForceUpdateMode;
      force_update_reason: string | null;
    }>(
      `SELECT l.update_channel, t.rollout_cohort, t.force_min_app_version, t.force_update_mode, t.force_update_reason
         FROM license_keys l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.id = ? AND l.tenant_id = ?`,
      act.licenseId,
      act.tenantId,
    );
    if (!lic) {
      res.status(403).json({ error: "activation_revoked" });
      return;
    }
    if (!isUpdateChannel(lic.update_channel)) {
      structuredLog("update_manifest_bad_channel", { tenant_id: act.tenantId, channel: lic.update_channel });
      res.status(409).json({ error: "invalid_update_channel" });
      return;
    }
    const cohortPolicy = await db.get<{
      force_min_app_version: string | null;
      force_update_mode: Exclude<ForceUpdateMode, "inherit">;
      force_update_reason: string | null;
    }>(
      `SELECT force_min_app_version, force_update_mode, force_update_reason
         FROM cohort_update_policies WHERE channel = ? AND cohort_label = ?`,
      lic.update_channel,
      lic.rollout_cohort,
    );
    const policy = resolveForceUpdatePolicy({
      appVersion: currentVersion,
      tenantMinVersion: lic.force_min_app_version,
      tenantMode: lic.force_update_mode,
      tenantReason: lic.force_update_reason,
      cohortMinVersion: cohortPolicy?.force_min_app_version ?? null,
      cohortMode: cohortPolicy?.force_update_mode ?? "off",
      cohortReason: cohortPolicy?.force_update_reason ?? null,
    });
    const governance = await db.get<{ state: "active" | "paused" | "recalled"; recalled_version: string | null }>(
      "SELECT state, recalled_version FROM mfx_rollout_governance($1, $2)",
      lic.update_channel,
      lic.rollout_cohort,
    );
    const rows = await db.all<CandidateRow>("SELECT * FROM mfx_update_candidates($1, $2)", target, arch);
    const candidates = rows.filter((r) => isUpdateChannel(r.channel));

    const decision = resolveUpdate(candidates, {
      tenantId: act.tenantId,
      machineFingerprint: act.machineFingerprint,
      currentVersion,
      channel: lic.update_channel,
      governance: governance ?? { state: "active", recalled_version: null },
      forcedUpdate: forcedUpdateReason(policy),
      rollbackTo: rollbackHeader,
    });
    const logFields = {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      current_version: currentVersion,
      target,
      arch,
      channel: lic.update_channel,
      cohort: lic.rollout_cohort,
    };
    if (!decision.offer) {
      structuredLog("update_manifest_none", { ...logFields, reason: decision.reason });
      res.status(204).end();
      return;
    }
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const chosen = rows.find((r) => r.release_id === decision.release.release_id)!;
    const download = await media.presignGet(chosen.object_key, UPDATE_DOWNLOAD_URL_TTL_SECONDS);
    structuredLog("update_manifest_offer", {
      ...logFields,
      release_id: chosen.release_id,
      version: chosen.version,
      kind: decision.kind,
      mandatory: decision.mandatory,
      mandatory_reason: decision.mandatoryReason,
    });
    const floorDriven = decision.mandatoryReason === "forced_update_floor" || decision.mandatoryReason === "emergency";
    const french = (req.header("Accept-Language") ?? "").toLowerCase().startsWith("fr");
    res.json({
      version: chosen.version,
      notes: french ? chosen.notes_fr : chosen.notes_en,
      pub_date: chosen.published_at ? new Date(chosen.published_at).toISOString() : undefined,
      url: download.url,
      signature: chosen.updater_signature,
      maintafox: {
        release_id: chosen.release_id,
        kind: decision.kind,
        mandatory: decision.mandatory,
        // Code: forced_update_floor | emergency | rollback_requested | recalled_version; null when
        // optional. The operator's own wording travels in mandatory_message (ignored by older
        // desktops).
        mandatory_reason: decision.mandatoryReason,
        // The effective floor when the policy makes this offer mandatory (may be null under
        // "emergency" with no floor); null otherwise.
        min_version: floorDriven ? policy.force_min_app_version : null,
        mandatory_message: floorDriven ? policy.force_update_reason : null,
        notes_en: chosen.notes_en,
        notes_fr: chosen.notes_fr,
      },
    });
  });
}

/**
 * Desktop activation: licence preview / claim, policy refresh (entitlement envelope, token
 * rotation), tenant initialisation status.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { JWT_SECRET } from "../app/config.js";
import {
  deviceClassMismatchBody,
  DeviceClassSchema,
  MOBILE_NOT_LICENSED_BODY,
  requestedDeviceClass,
  slotLimitField,
  slotLimitFor,
  type DeviceClass,
} from "../app/device-class.js";
import { activationRateLimiter, deviceRateLimiter, type ActivationAuthContext } from "../app/http.js";
import { observeActivationOutcome } from "../app/observability.js";
import {
  ALREADY_ENROLLED_BODY,
  WIPE_PENDING_BODY,
  appendEnrolmentAudit,
  ENROLMENT_INVALID_BODY,
  enrolmentSecretTenantScopeMiddleware,
  MOBILE_ENROLMENT_REQUIRED_BODY,
  redeemSecretHash,
  RedeemEnrolmentBody,
  type EnrolmentRow,
} from "../app/mobile-enrolment.js";
import { licenceKeyTenantScopeMiddleware } from "../app/scope.js";
import { resolveForceUpdatePolicy } from "../app/force-update.js";
import { newId, structuredLog, type ForceUpdateMode } from "../app/runtime.js";
import { DEVICE_TOKEN_ROTATE_AFTER_SECONDS, signDeviceActivationToken } from "../auth-tokens.js";
import { editionExists, loadCapabilitiesJsonForSign } from "../edition-catalog-store.js";
import { parseEditionId } from "../edition-catalog.js";
import { addHoursIso, buildSignedEntitlementEnvelope, capabilitiesDigest, type EntitlementEnvelopePayload } from "../entitlement-signer.js";

const ActivationClaimBody = z.object({
  license_key: z.string().min(8),
  machine_fingerprint: z.string().min(8).max(256),
  machine_label: z.string().max(128).optional(),
  app_version: z.string().max(32).optional(),
  // "desktop" (absent: every desktop released before the mobile app) or "mobile" (the field app).
  device_class: DeviceClassSchema.optional(),
}).strict();

// Policy refresh body. Desktops older than this field send "{}"; app_version has the claim body's
// type and limit (string, max 32). Not .strict(): an extra field from a newer desktop is ignored
// instead of failing the refresh (a failed refresh would leave the PC on a stale entitlement).
// A wrong type or an over-long app_version is a 400 like on claim. The value itself is NOT
// validated here: resolveForceUpdatePolicy treats an empty or unparsable version exactly like a
// missing one (blocked under "required"), so no string can loosen the policy, and a legitimate
// desktop with an odd version string still gets its refresh (with the old, blocked answer).
// device_class: same meaning as on claim (absent = desktop); it must match the activation's class.
const PolicyRefreshBody = z.object({
  app_version: z.string().max(32).optional(),
  device_class: DeviceClassSchema.optional(),
});

type ActivationLicenseRow = {
  id: string;
  tenant_id: string;
  license_key: string;
  max_machines: number;
  max_mobile_devices: number;
  update_channel: string;
  rollout_cohort: string;
  edition: string;
  entitlement_lineage: number;
  expires_at: string | null;
  revoked_at: string | null;
  force_min_app_version: string | null;
  force_update_mode: ForceUpdateMode;
  force_update_reason: string | null;
  offline_grace_hours: number;
  trust_revocation_disconnects_immediately: number;
  reconnect_requires_fresh_heartbeat: number;
  is_active: number;
  tenant_display_name: string;
  tenant_slug: string;
  is_initialized: number;
  has_demo_data: number;
};

function resolveEnvelopeValidity(lic: ActivationLicenseRow): {
  validUntil: string;
  offlineGraceUntil: string;
} {
  const now = new Date().toISOString();
  const validUntil =
    lic.expires_at && !Number.isNaN(Date.parse(lic.expires_at))
      ? new Date(lic.expires_at).toISOString()
      : "2099-01-01T00:00:00.000Z";
  const offlineGraceUntil = addHoursIso(validUntil === "2099-01-01T00:00:00.000Z" ? now : validUntil, lic.offline_grace_hours);
  // Prefer grace relative to expiry when expiry is set.
  const graceFromExpiry = lic.expires_at
    ? addHoursIso(new Date(lic.expires_at).toISOString(), lic.offline_grace_hours)
    : addHoursIso(now, lic.offline_grace_hours);
  return {
    validUntil,
    offlineGraceUntil: lic.expires_at ? graceFromExpiry : offlineGraceUntil,
  };
}

/** The licence row a device request reads (with its tenant's update and offline policy). */
const LICENSE_SELECT = `SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.max_mobile_devices, l.expires_at, l.revoked_at,
                l.update_channel, t.rollout_cohort,
                COALESCE(t.edition, 'core') AS edition,
                COALESCE(t.entitlement_lineage, 0) AS entitlement_lineage,
                t.force_min_app_version, t.force_update_mode, t.force_update_reason, t.is_active,
                t.offline_grace_hours, t.trust_revocation_disconnects_immediately,
                t.reconnect_requires_fresh_heartbeat,
                t.display_name AS tenant_display_name, t.slug AS tenant_slug,
                COALESCE(t.is_initialized, 0) AS is_initialized,
                COALESCE(t.has_demo_data, 0) AS has_demo_data
         FROM license_keys l
         JOIN tenants t ON t.id = l.tenant_id`;

/** Thrown inside the redeem transaction to roll it back when its enrolment was closed meanwhile. */
class EnrolmentNoLongerOpen extends Error {}

type ActivationValidateFailure = { status: number; body: Record<string, unknown>; reason: string };

export function registerActivationRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, activationAuthMiddleware, countActiveActivations, appendAuditRecord } = ctx;

  async function loadLicenseForActivation(licenseKey: string): Promise<ActivationLicenseRow | undefined> {
    return await db.get(`${LICENSE_SELECT} WHERE l.license_key = ?`, licenseKey) as ActivationLicenseRow | undefined;
  }

  async function loadLicenseById(licenseId: string, tenantId: string): Promise<ActivationLicenseRow | undefined> {
    return await db.get(`${LICENSE_SELECT} WHERE l.id = ? AND l.tenant_id = ?`, licenseId, tenantId) as ActivationLicenseRow | undefined;
  }

  /** State of the (channel, cohort) a device follows; no governance row means active. */
  async function rolloutGovernanceFor(
    channel: string,
    cohort: string,
  ): Promise<{ rollout_governance: "active" | "paused" | "recalled"; rollout_recalled_version: string | null }> {
    // Device requests run in their tenant's scope: the vendor-wide table is read through the
    // SECURITY DEFINER function of migration 012.
    const row = await db.get<{ state: "active" | "paused" | "recalled"; recalled_version: string | null }>(
      "SELECT state, recalled_version FROM mfx_rollout_governance($1, $2)",
      channel,
      cohort,
    );
    return { rollout_governance: row?.state ?? "active", rollout_recalled_version: row?.recalled_version ?? null };
  }

  async function buildEntitlementEnvelopeForLicense(
    lic: ActivationLicenseRow,
    deviceClass: DeviceClass,
    opts?: { bumpLineage?: boolean; persistLineage?: boolean },
  ): Promise<EntitlementEnvelopePayload> {
    // Soft phase: always issue lineage 1 with null previous so desktop apply does not
    // require a prior local envelope id (control plane does not track device envelopes).
    // entitlement_lineage still bumps for operator audit / concurrency hints.
    // Catalog snapshot + lineage bump run in one transaction, so the envelope is stamped from a
    // single committed catalog version.
    return db.tx(async () => {
      if (opts?.bumpLineage) {
        await db.run(`UPDATE tenants SET entitlement_lineage = entitlement_lineage + 1 WHERE id = ?`, lic.tenant_id);
      } else if (opts?.persistLineage) {
        await db.run(`UPDATE tenants SET entitlement_lineage = CASE WHEN COALESCE(entitlement_lineage, 0) < 1 THEN 1 ELSE entitlement_lineage END WHERE id = ?`, lic.tenant_id);
      }
      const snap = await loadCapabilitiesJsonForSign(db, lic.edition);
      const { validUntil, offlineGraceUntil } = resolveEnvelopeValidity(lic);
      return buildSignedEntitlementEnvelope({
        edition: snap.tier,
        capabilities_json: snap.capabilities_json,
        lineageVersion: 1,
        previousEnvelopeId: null,
        channel: lic.update_channel,
        // The slots of the device's own class; the class itself is signed inside policy_json.
        machineSlots: slotLimitFor(lic, deviceClass),
        deviceClass,
        validUntil,
        offlineGraceUntil,
      });
    });
  }

  async function buildActivationSummary(
    lic: ActivationLicenseRow,
    input: { machine_fingerprint: string; machine_label?: string },
    deviceClass: DeviceClass,
    resolvedPolicy: ReturnType<typeof resolveForceUpdatePolicy>,
    opts?: { includeEnvelope?: boolean; bumpLineage?: boolean; persistLineage?: boolean },
  ): Promise<Record<string, unknown>> {
    const edition = await editionExists(db, lic.edition) ? lic.edition : parseEditionId(lic.edition, "core");
    const includeEnvelope = opts?.includeEnvelope === true;
    const envelope = await buildEntitlementEnvelopeForLicense(lic, deviceClass, {
      bumpLineage: opts?.bumpLineage,
      persistLineage: opts?.persistLineage,
    });
    return {
      tenant_id: lic.tenant_id,
      license_id: lic.id,
      machine_fingerprint: input.machine_fingerprint,
      tenant_display_name: lic.tenant_display_name,
      tenant_slug: lic.tenant_slug,
      license_status: "active",
      edition,
      license_plan: edition,
      license_tier: edition,
      update_channel: lic.update_channel,
      expires_at: lic.expires_at,
      // The device's class and the slots of that class (desktops: max_machines, phones:
      // max_mobile_devices). Older desktops ignore device_class.
      device_class: deviceClass,
      device_limit: slotLimitFor(lic, deviceClass),
      activated_device_count: await countActiveActivations(lic.id, deviceClass),
      machine_label: input.machine_label ?? null,
      is_initialized: lic.is_initialized === 1,
      has_demo_data: lic.has_demo_data === 1,
      offline_grace_hours: lic.offline_grace_hours,
      trust_revocation_disconnects_immediately: lic.trust_revocation_disconnects_immediately === 1,
      reconnect_requires_fresh_heartbeat: lic.reconnect_requires_fresh_heartbeat === 1,
      force_min_app_version: resolvedPolicy.force_min_app_version,
      force_update_mode: resolvedPolicy.force_update_mode,
      force_update_reason: resolvedPolicy.force_update_reason,
      force_update_policy_source: resolvedPolicy.policy_source,
      force_update_required: resolvedPolicy.force_update_required,
      capabilities_digest: capabilitiesDigest(envelope.capabilities_json),
      feature_flags_digest: capabilitiesDigest(envelope.feature_flags_json),
      // Rollout governance of the device's (channel, cohort), set by operators (routes/releases.ts):
      // the desktop updater (master plan Phase 5) stops offering updates while paused and treats
      // rollout_recalled_version as withdrawn. Additive fields; older desktops ignore them.
      ...(await rolloutGovernanceFor(lic.update_channel, lic.rollout_cohort)),
      ...(includeEnvelope ? { entitlement_envelope: envelope } : {}),
    };
  }

  async function resolveActivationPolicy(lic: ActivationLicenseRow, appVersion: string | undefined) {
    const cohortPolicy = await db.get(`SELECT force_min_app_version, force_update_mode, force_update_reason
         FROM cohort_update_policies
         WHERE channel = ? AND cohort_label = ?`, lic.update_channel, lic.rollout_cohort) as
      | {
          force_min_app_version: string | null;
          force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          force_update_reason: string | null;
        }
      | undefined;
    return resolveForceUpdatePolicy({
      appVersion,
      tenantMinVersion: lic.force_min_app_version,
      tenantMode: lic.force_update_mode,
      tenantReason: lic.force_update_reason,
      cohortMinVersion: cohortPolicy?.force_min_app_version ?? null,
      cohortMode: cohortPolicy?.force_update_mode ?? "off",
      cohortReason: cohortPolicy?.force_update_reason ?? null,
    });
  }

  async function validateLicenseForActivation(
    lic: ActivationLicenseRow | undefined,
    input: { machine_fingerprint: string; device_class?: DeviceClass },
    opts: { reserveSlot: boolean; via: "licence_key" | "enrolment" },
  ): Promise<
    { ok: true; lic: ActivationLicenseRow; deviceClass: DeviceClass } | { ok: false; failure: ActivationValidateFailure }
  > {
    if (!lic || lic.is_active !== 1) {
      return {
        ok: false,
        failure: { status: 404, body: { error: "license_not_found" }, reason: "license_not_found" },
      };
    }
    if (lic.revoked_at) {
      return {
        ok: false,
        failure: { status: 403, body: { error: "license_revoked" }, reason: "license_revoked" },
      };
    }
    if (lic.expires_at && new Date(lic.expires_at) <= new Date()) {
      return {
        ok: false,
        failure: { status: 403, body: { error: "license_expired" }, reason: "license_expired" },
      };
    }

    const existing = await db.get(`SELECT id, machine_fingerprint, license_id, revoked_at, revocation_kind, device_class
         FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`, lic.tenant_id, input.machine_fingerprint) as
      | {
          id: string;
          machine_fingerprint: string;
          license_id: string;
          revoked_at: string | null;
          revocation_kind: string | null;
          device_class: DeviceClass;
        }
      | undefined;
    const deviceClass = requestedDeviceClass(input.device_class);

    // Phones join only through an enrolment issued by the customer's administrator (redeem below),
    // never with the licence key: the key path would give a phone a slot without a person and site.
    if (deviceClass === "mobile" && opts.via === "licence_key") {
      return {
        ok: false,
        failure: { status: 403, body: { ...MOBILE_ENROLMENT_REQUIRED_BODY }, reason: "mobile_enrolment_required" },
      };
    }

    // An operator-revoked machine stays revoked until an operator reinstates it: presenting the
    // licence key again (preview or claim) must not undo the revocation.
    if (existing?.revoked_at && existing.revocation_kind === "machine") {
      return {
        ok: false,
        failure: {
          status: 403,
          body: {
            error: "activation_revoked",
            message: "This device was revoked by the vendor. Ask your administrator to have it reinstated.",
          },
          reason: "activation_revoked",
        },
      };
    }

    // A fingerprint keeps the class it was first activated with (released or licence-revoked rows
    // included, since a claim reuses the row): a desktop cannot become a phone or the reverse.
    if (existing && existing.device_class !== deviceClass) {
      return {
        ok: false,
        failure: {
          status: 409,
          body: deviceClassMismatchBody(existing.device_class, deviceClass),
          reason: "device_class_mismatch",
        },
      };
    }

    // Phones need mobile devices on the licence (0 until a vendor operator sets a count), even a
    // phone that already holds a slot.
    if (deviceClass === "mobile" && lic.max_mobile_devices <= 0) {
      return {
        ok: false,
        failure: { status: 403, body: { ...MOBILE_NOT_LICENSED_BODY }, reason: "mobile_not_licensed" },
      };
    }

    // A device already holds a slot only while it is active on this same licence; a revoked device or
    // one bound to another licence needs a free slot of its class like a new one.
    const holdsSlot = existing != null && existing.revoked_at == null && existing.license_id === lic.id;
    if (!holdsSlot) {
      const limit = slotLimitFor(lic, deviceClass);
      const activeCount = await countActiveActivations(lic.id, deviceClass);
      if (activeCount >= limit) {
        return {
          ok: false,
          failure: {
            status: 409,
            body: { error: "slot_limit_reached", device_class: deviceClass, limit, [slotLimitField(deviceClass)]: limit },
            reason: "slot_limit_reached",
          },
        };
      }
    } else if (!opts.reserveSlot) {
      // Preview: existing fingerprint is fine; slot already held.
    }

    return { ok: true, lic, deviceClass };
  }

  app.post("/api/v1/activation/preview", activationRateLimiter, licenceKeyTenantScopeMiddleware(db), async (req, res) => {
    const startedAt = Date.now();
    const parsed = ActivationClaimBody.safeParse(req.body);
    if (!parsed.success) {
      observeActivationOutcome("invalid_body");
      structuredLog("activation_preview_failed", {
        reason: "invalid_body",
        status: 400,
        duration_ms: Date.now() - startedAt,
      });
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const lic = await loadLicenseForActivation(input.license_key.trim());
    const validated = await validateLicenseForActivation(lic, input, { reserveSlot: false, via: "licence_key" });
    if (!validated.ok) {
      observeActivationOutcome(validated.failure.reason as Parameters<typeof observeActivationOutcome>[0]);
      structuredLog("activation_preview_failed", {
        reason: validated.failure.reason,
        status: validated.failure.status,
        duration_ms: Date.now() - startedAt,
        machine_fingerprint: input.machine_fingerprint,
      });
      res.status(validated.failure.status).json(validated.failure.body);
      return;
    }
    const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
    structuredLog("activation_preview_success", {
      status: 200,
      tenant_id: validated.lic.tenant_id,
      license_id: validated.lic.id,
      machine_fingerprint: input.machine_fingerprint,
      device_class: validated.deviceClass,
      duration_ms: Date.now() - startedAt,
    });
    res.json(await buildActivationSummary(validated.lic, input, validated.deviceClass, resolvedPolicy));
  });

  app.post("/api/v1/activation/claim", activationRateLimiter, licenceKeyTenantScopeMiddleware(db), async (req, res) => {
    const startedAt = Date.now();
    const parsed = ActivationClaimBody.safeParse(req.body);
    if (!parsed.success) {
      observeActivationOutcome("invalid_body");
      structuredLog("activation_claim_failed", {
        reason: "invalid_body",
        status: 400,
        duration_ms: Date.now() - startedAt,
      });
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const nowIso = new Date().toISOString();
    const lic = await loadLicenseForActivation(input.license_key.trim());
    // Slot check and activation write run in one transaction under a per-licence lock, so two
    // concurrent claims cannot both take the last slot.
    const claim = await db.tx(async () => {
      // Locks: the licence's slots (vs. other claims, reinstate and revoke), then this device on the
      // tenant (vs. a concurrent claim of the same machine on another licence). The licence is read
      // again under the lock so a concurrent revoke or slot change is seen.
      let current = lic;
      if (lic) {
        await db.lockXact("license-slots", lic.id);
        await db.lockXact("activation-device", `${lic.tenant_id}:${input.machine_fingerprint}`);
        current = await loadLicenseForActivation(input.license_key.trim());
      }
      const validated = await validateLicenseForActivation(current, input, { reserveSlot: true, via: "licence_key" });
      if (!validated.ok) return { ok: false as const, failure: validated.failure };

      const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
      const activationToken = signDeviceActivationToken(JWT_SECRET, {
        tenantId: validated.lic.tenant_id,
        licenseId: validated.lic.id,
        machineFingerprint: input.machine_fingerprint,
      });

      // Operator-revoked machines and a class change were already refused by
      // validateLicenseForActivation, so an existing row keeps its device_class.
      const existing = await db.get<{ id: string; machine_fingerprint: string }>(
        "SELECT id, machine_fingerprint FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?",
        validated.lic.tenant_id,
        input.machine_fingerprint,
      );

      if (existing) {
        // Rebind to the licence being claimed (e.g. after a licence replacement) so the device lookup
        // in activationAuthMiddleware matches the token's license_id.
        await db.run(
          `UPDATE machine_activations
           SET license_id = ?, machine_label = ?, app_version = ?, activation_token = ?, last_seen_at = ?,
               revoked_at = NULL, revocation_kind = NULL
           WHERE id = ?`,
          validated.lic.id,
          input.machine_label ?? null,
          input.app_version ?? null,
          activationToken,
          nowIso,
          existing.id,
        );
      } else {
        await db.run(
          `INSERT INTO machine_activations
            (id, tenant_id, license_id, machine_fingerprint, device_class, machine_label, app_version, activation_token,
             activated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId("act"),
          validated.lic.tenant_id,
          validated.lic.id,
          input.machine_fingerprint,
          validated.deviceClass,
          input.machine_label ?? null,
          input.app_version ?? null,
          activationToken,
          nowIso,
          nowIso,
        );
      }
      return { ok: true as const, validated, resolvedPolicy, activationToken };
    });
    if (!claim.ok) {
      observeActivationOutcome(claim.failure.reason as Parameters<typeof observeActivationOutcome>[0]);
      structuredLog("activation_claim_failed", {
        reason: claim.failure.reason,
        status: claim.failure.status,
        duration_ms: Date.now() - startedAt,
        machine_fingerprint: input.machine_fingerprint,
        device_class: requestedDeviceClass(input.device_class),
        ...(claim.failure.reason !== "license_not_found"
          ? { tenant_id: lic?.tenant_id, license_id: lic?.id }
          : {}),
      });
      res.status(claim.failure.status).json(claim.failure.body);
      return;
    }
    const { validated, resolvedPolicy, activationToken } = claim;

    observeActivationOutcome("ok");
    structuredLog("activation_claim_success", {
      status: 200,
      tenant_id: validated.lic.tenant_id,
      license_id: validated.lic.id,
      machine_fingerprint: input.machine_fingerprint,
      device_class: validated.deviceClass,
      policy_source: resolvedPolicy.policy_source,
      force_update_required: resolvedPolicy.force_update_required,
      duration_ms: Date.now() - startedAt,
    });
    res.json({
      ...(await buildActivationSummary(validated.lic, input, validated.deviceClass, resolvedPolicy, {
        includeEnvelope: true,
        persistLineage: true,
      })),
      // Count after write so activated_device_count includes this device.
      activated_device_count: await countActiveActivations(validated.lic.id, validated.deviceClass),
      activation_token: activationToken,
    });
  });

  /**
   * A phone joins with an enrolment its administrator issued (routes/mobile-enrolment.ts), never
   * with the licence key. The secret (QR token or typed code) is spent here, at most once: the
   * enrolment, the licence, the mobile slot and this phone are checked under the same locks as a
   * claim, and the phone's activation is created bound to the enrolment's person and site.
   * Answers like a claim (summary, signed envelope, device token) plus the binding.
   */
  app.post(
    "/api/v1/mobile-enrolments/redeem",
    activationRateLimiter,
    enrolmentSecretTenantScopeMiddleware(db),
    async (req, res) => {
      const startedAt = Date.now();
      const parsed = RedeemEnrolmentBody.safeParse(req.body);
      if (!parsed.success) {
        observeActivationOutcome("invalid_body");
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
        return;
      }
      const input = parsed.data;
      const secretHash = redeemSecretHash(input);
      const refuse = (failure: ActivationValidateFailure) => {
        observeActivationOutcome(failure.reason as Parameters<typeof observeActivationOutcome>[0]);
        structuredLog("mobile_enrolment_redeem_failed", {
          reason: failure.reason,
          status: failure.status,
          duration_ms: Date.now() - startedAt,
          machine_fingerprint: input.machine_fingerprint,
        });
        res.status(failure.status).json(failure.body);
      };
      const invalid: ActivationValidateFailure = {
        status: 404,
        body: { ...ENROLMENT_INVALID_BODY },
        reason: "enrolment_invalid",
      };
      if (!secretHash) {
        refuse(invalid);
        return;
      }
      const nowIso = new Date().toISOString();
      const outcome = await db.tx(async () => {
        // Without the tenant scope (unknown secret) this finds nothing.
        const found = await db.get<{ id: string }>(
          "SELECT id FROM mobile_enrolments WHERE token_hash = ? OR code_hash = ?",
          secretHash,
          secretHash,
        );
        if (!found) return { ok: false as const, failure: invalid };
        // The enrolment's own lock, then the same order as a claim (licence slots, then the device).
        await db.lockXact("mobile-enrolment", found.id);
        const enrolment = await db.get<EnrolmentRow>(
          `SELECT id, tenant_id, license_id, person_sync_id, person_label, site_sync_id, site_label,
                  issued_by_label, expires_at, cancelled_at, redeemed_at
           FROM mobile_enrolments WHERE id = ?`,
          found.id,
        );
        if (!enrolment || enrolment.cancelled_at || enrolment.redeemed_at || new Date(enrolment.expires_at) <= new Date()) {
          return { ok: false as const, failure: invalid };
        }
        await db.lockXact("license-slots", enrolment.license_id);
        await db.lockXact("activation-device", `${enrolment.tenant_id}:${input.machine_fingerprint}`);
        const lic = await loadLicenseById(enrolment.license_id, enrolment.tenant_id);

        // A phone that is enrolled and active must be removed first: an enrolment never moves a
        // working phone to another person.
        const current = await db.get<{
          id: string;
          revoked_at: string | null;
          device_class: DeviceClass;
          revocation_kind: string | null;
          revoke_reason: string | null;
          wiped_at: string | null;
        }>(
          `SELECT id, revoked_at, device_class, revocation_kind, revoke_reason, wiped_at
           FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`,
          enrolment.tenant_id,
          input.machine_fingerprint,
        );
        if (current && current.revoked_at == null && current.device_class === "mobile") {
          return {
            ok: false as const,
            failure: { status: 409, body: { ...ALREADY_ENROLLED_BODY }, reason: "already_enrolled" },
          };
        }
        // A removed phone still holding its previous person's data must finish its wipe first.
        if (current?.revocation_kind === "tenant_admin" && current.wiped_at == null && current.revoke_reason !== "lost") {
          return {
            ok: false as const,
            failure: { status: 409, body: { ...WIPE_PENDING_BODY }, reason: "wipe_pending" },
          };
        }
        const validated = await validateLicenseForActivation(
          lic,
          { machine_fingerprint: input.machine_fingerprint, device_class: "mobile" },
          { reserveSlot: true, via: "enrolment" },
        );
        if (!validated.ok) return { ok: false as const, failure: validated.failure };

        const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
        const activationToken = signDeviceActivationToken(JWT_SECRET, {
          tenantId: validated.lic.tenant_id,
          licenseId: validated.lic.id,
          machineFingerprint: input.machine_fingerprint,
        });
        const activationId = current?.id ?? newId("act");
        if (current) {
          // A revoked or released row of this phone is reused (a desktop row was refused above as
          // device_class_mismatch); the binding and the wipe state start afresh.
          await db.run(
            `UPDATE machine_activations
             SET license_id = ?, machine_label = ?, app_version = ?, activation_token = ?, last_seen_at = ?,
                 revoked_at = NULL, revocation_kind = NULL, revoked_by_label = NULL, revoked_by_sync_id = NULL,
                 revoke_reason = NULL,
                 wiped_at = NULL, policy_refresh_requested_at = NULL,
                 enrolment_id = ?, person_sync_id = ?, person_label = ?, site_sync_id = ?, site_label = ?,
                 enrolled_by_label = ?, enrolled_at = ?
             WHERE id = ?`,
            validated.lic.id,
            input.machine_label ?? null,
            input.app_version ?? null,
            activationToken,
            nowIso,
            enrolment.id,
            enrolment.person_sync_id,
            enrolment.person_label,
            enrolment.site_sync_id,
            enrolment.site_label,
            enrolment.issued_by_label,
            nowIso,
            activationId,
          );
        } else {
          await db.run(
            `INSERT INTO machine_activations
              (id, tenant_id, license_id, machine_fingerprint, device_class, machine_label, app_version, activation_token,
               activated_at, last_seen_at, enrolment_id, person_sync_id, person_label, site_sync_id, site_label,
               enrolled_by_label, enrolled_at)
             VALUES (?, ?, ?, ?, 'mobile', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            activationId,
            validated.lic.tenant_id,
            validated.lic.id,
            input.machine_fingerprint,
            input.machine_label ?? null,
            input.app_version ?? null,
            activationToken,
            nowIso,
            nowIso,
            enrolment.id,
            enrolment.person_sync_id,
            enrolment.person_label,
            enrolment.site_sync_id,
            enrolment.site_label,
            enrolment.issued_by_label,
            nowIso,
          );
        }
        // Spent only while still open: a cancel that won the race leaves it untouched, and this
        // refusal rolls the phone's activation above back.
        const spent = await db.run(
          `UPDATE mobile_enrolments SET redeemed_at = ?, activation_id = ?
           WHERE id = ? AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > now()`,
          nowIso,
          activationId,
          enrolment.id,
        );
        if (spent.changes !== 1) throw new EnrolmentNoLongerOpen();
        return { ok: true as const, validated, resolvedPolicy, activationToken, enrolment, activationId };
      }).catch((e: unknown) => {
        if (e instanceof EnrolmentNoLongerOpen) return { ok: false as const, failure: invalid };
        throw e;
      });
      if (!outcome.ok) {
        refuse(outcome.failure);
        return;
      }
      const { validated, resolvedPolicy, activationToken, enrolment, activationId } = outcome;
      observeActivationOutcome("ok");
      structuredLog("mobile_enrolment_redeemed", {
        status: 200,
        tenant_id: validated.lic.tenant_id,
        license_id: validated.lic.id,
        enrolment_id: enrolment.id,
        machine_fingerprint: input.machine_fingerprint,
        duration_ms: Date.now() - startedAt,
      });
      await appendEnrolmentAudit(db, appendAuditRecord, {
        action_code: "mobile_enrolment_redeemed",
        actor: `device:${input.machine_fingerprint}`,
        tenantId: validated.lic.tenant_id,
        licenseId: validated.lic.id,
        machineFingerprint: input.machine_fingerprint,
        payload: {
          enrolment_id: enrolment.id,
          activation_id: activationId,
          person_sync_id: enrolment.person_sync_id,
          site_sync_id: enrolment.site_sync_id,
        },
      });
      res.json({
        ...(await buildActivationSummary(validated.lic, input, "mobile", resolvedPolicy, {
          includeEnvelope: true,
          persistLineage: true,
        })),
        activated_device_count: await countActiveActivations(validated.lic.id, "mobile"),
        activation_token: activationToken,
        // Who may use this phone, and where. The phone keeps it with its device credential.
        enrolment: {
          enrolment_id: enrolment.id,
          person_sync_id: enrolment.person_sync_id,
          person_label: enrolment.person_label,
          site_sync_id: enrolment.site_sync_id,
          site_label: enrolment.site_label,
          enrolled_at: nowIso,
        },
      });
    },
  );

  app.post("/api/v1/activation/policy-refresh", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!activation) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const parsedBody = PolicyRefreshBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      structuredLog("activation_policy_refresh_failed", {
        reason: "invalid_body",
        status: 400,
        tenant_id: activation.tenantId,
        machine_fingerprint: activation.machineFingerprint,
      });
      res.status(400).json({ error: "invalid_body", details: parsedBody.error.flatten() });
      return;
    }
    const licRow = await loadLicenseById(activation.licenseId, activation.tenantId);
    if (!licRow || licRow.is_active !== 1) {
      res.status(404).json({ error: "license_not_found" });
      return;
    }
    if (licRow.revoked_at) {
      res.status(403).json({ error: "license_revoked" });
      return;
    }
    if (licRow.expires_at && new Date(licRow.expires_at) <= new Date()) {
      res.status(403).json({ error: "license_expired" });
      return;
    }
    // The class the device says it is must be the class it was activated with (absent = desktop).
    const requestedClass = requestedDeviceClass(parsedBody.data.device_class);
    if (requestedClass !== activation.deviceClass) {
      structuredLog("activation_policy_refresh_failed", {
        reason: "device_class_mismatch",
        status: 409,
        tenant_id: activation.tenantId,
        machine_fingerprint: activation.machineFingerprint,
        device_class: activation.deviceClass,
        requested_device_class: requestedClass,
      });
      res.status(409).json(deviceClassMismatchBody(activation.deviceClass, requestedClass));
      return;
    }
    if (activation.deviceClass === "mobile" && licRow.max_mobile_devices <= 0) {
      res.status(403).json({ ...MOBILE_NOT_LICENSED_BODY });
      return;
    }
    // The PC's running version (absent on older desktops -> same answer as before: blocked under
    // "required").
    const resolvedPolicy = await resolveActivationPolicy(licRow, parsedBody.data.app_version);
    const syntheticInput = { machine_fingerprint: activation.machineFingerprint };
    const summary = await buildActivationSummary(licRow, syntheticInput, activation.deviceClass, resolvedPolicy, {
      includeEnvelope: true,
      bumpLineage: true,
    });
    // Rotate an ageing device token, or any token after an operator asked for a policy refresh (the
    // desktop resumes sync only when its token changes): the new one is stored, so the old one stops
    // working at once (activationAuthMiddleware compares against the stored token).
    let activationToken = activation.token;
    const tokenAgeSeconds = Math.floor(Date.now() / 1000) - activation.tokenIssuedAt;
    const refreshRequested = await db.get<{ policy_refresh_requested_at: string | null }>(
      `SELECT policy_refresh_requested_at FROM machine_activations
       WHERE tenant_id = ? AND license_id = ? AND machine_fingerprint = ?`,
      activation.tenantId,
      activation.licenseId,
      activation.machineFingerprint,
    );
    if (tokenAgeSeconds >= DEVICE_TOKEN_ROTATE_AFTER_SECONDS || refreshRequested?.policy_refresh_requested_at) {
      activationToken = signDeviceActivationToken(JWT_SECRET, {
        tenantId: activation.tenantId,
        licenseId: activation.licenseId,
        machineFingerprint: activation.machineFingerprint,
      });
      await db.run(`UPDATE machine_activations SET activation_token = ?, policy_refresh_requested_at = NULL
         WHERE tenant_id = ? AND license_id = ? AND machine_fingerprint = ?`, activationToken, activation.tenantId, activation.licenseId, activation.machineFingerprint);
      structuredLog("activation_token_rotated", {
        tenant_id: activation.tenantId,
        license_id: activation.licenseId,
        machine_fingerprint: activation.machineFingerprint,
        previous_token_age_seconds: tokenAgeSeconds,
        operator_requested: Boolean(refreshRequested?.policy_refresh_requested_at),
      });
    }
    res.json({
      ...summary,
      activated_device_count: await countActiveActivations(licRow.id, activation.deviceClass),
      // Always present: the desktop stores it as its bearer token (rotated when ageing).
      activation_token: activationToken,
    });
  });

  app.get("/api/v1/activation/tenant-status", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!activation) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const row = await db.get(`SELECT id, COALESCE(is_initialized, 0) AS is_initialized FROM tenants WHERE id = ?`, activation.tenantId) as { id: string; is_initialized: number } | undefined;
    if (!row) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    res.json({
      tenant_id: row.id,
      is_initialized: row.is_initialized === 1,
    });
  });

  app.post("/api/v1/activation/tenant-status/initialize", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!activation) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const nowIso = new Date().toISOString();
    const result = await db.run(
      `UPDATE tenants
       SET is_initialized = 1,
           bootstrap_completed_at = COALESCE(bootstrap_completed_at, ?),
           bootstrap_method = COALESCE(bootstrap_method, ?)
       WHERE id = ?`,
      nowIso,
      "desktop_activation",
      activation.tenantId,
    );
    if (result.changes === 0) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    const row = await db.get(`SELECT id, COALESCE(is_initialized, 0) AS is_initialized FROM tenants WHERE id = ?`, activation.tenantId) as { id: string; is_initialized: number };
    structuredLog("activation_tenant_initialized", {
      tenant_id: row.id,
      machine_fingerprint: activation.machineFingerprint,
    });
    res.json({
      tenant_id: row.id,
      is_initialized: row.is_initialized === 1,
    });
  });
}

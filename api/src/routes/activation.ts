/**
 * Desktop activation: licence preview / claim, policy refresh (entitlement envelope, token
 * rotation), tenant initialisation status.
 */
import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { JWT_SECRET } from "../app/config.js";
import { activationRateLimiter, deviceRateLimiter, type ActivationAuthContext } from "../app/http.js";
import { observeActivationOutcome } from "../app/observability.js";
import { licenceKeyTenantScopeMiddleware } from "../app/scope.js";
import { newId, semverCompare, structuredLog, type ForceUpdateMode } from "../app/runtime.js";
import { DEVICE_TOKEN_ROTATE_AFTER_SECONDS, signDeviceActivationToken } from "../auth-tokens.js";
import { editionExists, loadCapabilitiesJsonForSign } from "../edition-catalog-store.js";
import { parseEditionId } from "../edition-catalog.js";
import { addHoursIso, buildSignedEntitlementEnvelope, capabilitiesDigest, type EntitlementEnvelopePayload } from "../entitlement-signer.js";

function resolveForceUpdatePolicy(input: {
  appVersion?: string;
  tenantMinVersion: string | null;
  tenantMode: ForceUpdateMode;
  tenantReason: string | null;
  cohortMinVersion: string | null;
  cohortMode: Exclude<ForceUpdateMode, "inherit">;
  cohortReason: string | null;
}): {
  force_min_app_version: string | null;
  force_update_mode: Exclude<ForceUpdateMode, "inherit">;
  force_update_reason: string | null;
  force_update_required: boolean;
  policy_source: "tenant" | "cohort";
} {
  const policySource: "tenant" | "cohort" = input.tenantMode === "inherit" ? "cohort" : "tenant";
  const mode =
    policySource === "tenant" ? (input.tenantMode as Exclude<ForceUpdateMode, "inherit">) : input.cohortMode;
  const minVersion = policySource === "tenant" ? input.tenantMinVersion : input.cohortMinVersion;
  const reason = policySource === "tenant" ? input.tenantReason : input.cohortReason;
  const forceUpdateRequired =
    mode === "emergency" || (mode === "required" && (!input.appVersion || !minVersion || semverCompare(input.appVersion, minVersion) < 0));
  return {
    force_min_app_version: minVersion,
    force_update_mode: mode,
    force_update_reason: reason,
    force_update_required: forceUpdateRequired,
    policy_source: policySource,
  };
}

const ActivationClaimBody = z.object({
  license_key: z.string().min(8),
  machine_fingerprint: z.string().min(8).max(256),
  machine_label: z.string().max(128).optional(),
  app_version: z.string().max(32).optional(),
}).strict();

type ActivationLicenseRow = {
  id: string;
  tenant_id: string;
  license_key: string;
  max_machines: number;
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

type ActivationValidateFailure = { status: number; body: Record<string, unknown>; reason: string };

export function registerActivationRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, activationAuthMiddleware, countActiveActivations } = ctx;

  async function loadLicenseForActivation(licenseKey: string): Promise<ActivationLicenseRow | undefined> {
    return await db.get(`SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.expires_at, l.revoked_at,
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
         JOIN tenants t ON t.id = l.tenant_id
         WHERE l.license_key = ?`, licenseKey) as ActivationLicenseRow | undefined;
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
        machineSlots: lic.max_machines,
        validUntil,
        offlineGraceUntil,
      });
    });
  }

  async function buildActivationSummary(
    lic: ActivationLicenseRow,
    input: z.infer<typeof ActivationClaimBody>,
    resolvedPolicy: ReturnType<typeof resolveForceUpdatePolicy>,
    opts?: { includeEnvelope?: boolean; bumpLineage?: boolean; persistLineage?: boolean },
  ): Promise<Record<string, unknown>> {
    const edition = await editionExists(db, lic.edition) ? lic.edition : parseEditionId(lic.edition, "core");
    const includeEnvelope = opts?.includeEnvelope === true;
    const envelope = await buildEntitlementEnvelopeForLicense(lic, {
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
      device_limit: lic.max_machines,
      activated_device_count: await countActiveActivations(lic.id),
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
    input: z.infer<typeof ActivationClaimBody>,
    opts: { reserveSlot: boolean },
  ): Promise<{ ok: true; lic: ActivationLicenseRow } | { ok: false; failure: ActivationValidateFailure }> {
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

    const existing = await db.get(`SELECT id, machine_fingerprint, license_id, revoked_at, revocation_kind
         FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`, lic.tenant_id, input.machine_fingerprint) as
      | {
          id: string;
          machine_fingerprint: string;
          license_id: string;
          revoked_at: string | null;
          revocation_kind: string | null;
        }
      | undefined;

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

    // A device already holds a slot only while it is active on this same licence; a revoked device or
    // one bound to another licence needs a free slot like a new one.
    const holdsSlot = existing != null && existing.revoked_at == null && existing.license_id === lic.id;
    if (!holdsSlot) {
      const activeCount = await countActiveActivations(lic.id);
      if (activeCount >= lic.max_machines) {
        return {
          ok: false,
          failure: {
            status: 409,
            body: { error: "slot_limit_reached", max_machines: lic.max_machines },
            reason: "slot_limit_reached",
          },
        };
      }
    } else if (!opts.reserveSlot) {
      // Preview: existing fingerprint is fine; slot already held.
    }

    return { ok: true, lic };
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
    const validated = await validateLicenseForActivation(lic, input, { reserveSlot: false });
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
      duration_ms: Date.now() - startedAt,
    });
    res.json(await buildActivationSummary(validated.lic, input, resolvedPolicy));
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
      const validated = await validateLicenseForActivation(current, input, { reserveSlot: true });
      if (!validated.ok) return { ok: false as const, failure: validated.failure };

      const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
      const activationToken = signDeviceActivationToken(JWT_SECRET, {
        tenantId: validated.lic.tenant_id,
        licenseId: validated.lic.id,
        machineFingerprint: input.machine_fingerprint,
      });

      // Operator-revoked machines were already refused by validateLicenseForActivation.
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
            (id, tenant_id, license_id, machine_fingerprint, machine_label, app_version, activation_token, activated_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId("act"),
          validated.lic.tenant_id,
          validated.lic.id,
          input.machine_fingerprint,
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
      policy_source: resolvedPolicy.policy_source,
      force_update_required: resolvedPolicy.force_update_required,
      duration_ms: Date.now() - startedAt,
    });
    res.json({
      ...(await buildActivationSummary(validated.lic, input, resolvedPolicy, {
        includeEnvelope: true,
        persistLineage: true,
      })),
      // Count after write so activated_device_count includes this device.
      activated_device_count: await countActiveActivations(validated.lic.id),
      activation_token: activationToken,
    });
  });

  app.post("/api/v1/activation/policy-refresh", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    if (!activation) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const licRow = await db.get(`SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.expires_at, l.revoked_at,
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
         JOIN tenants t ON t.id = l.tenant_id
         WHERE l.id = ? AND l.tenant_id = ?`, activation.licenseId, activation.tenantId) as ActivationLicenseRow | undefined;
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
    const resolvedPolicy = await resolveActivationPolicy(licRow, undefined);
    const syntheticInput = {
      license_key: licRow.license_key,
      machine_fingerprint: activation.machineFingerprint,
    };
    const summary = await buildActivationSummary(licRow, syntheticInput, resolvedPolicy, {
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
      activated_device_count: await countActiveActivations(licRow.id),
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

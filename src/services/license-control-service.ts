import { z } from "zod";

import { getAccessToken } from "@/lib/auth-token";

/** System + custom edition ids from the persisted catalog. */
const EditionIdSchema = z.string().min(2).max(64);

const MODULE_CAPABILITY_KEYS = [
  "equipment",
  "requests",
  "work_orders",
  "inventory",
  "personnel",
  "organization",
  "reference",
  "planning",
  "pm",
  "permits",
  "inspections",
  "training",
  "reports",
  "rams",
  "finance",
  "sync",
  "erp",
] as const;

export type ModuleCapabilityKey = (typeof MODULE_CAPABILITY_KEYS)[number];
export { MODULE_CAPABILITY_KEYS };

const CapabilitiesMapSchema = z
  .object(
    Object.fromEntries(MODULE_CAPABILITY_KEYS.map((k) => [k, z.boolean()])) as {
      [K in ModuleCapabilityKey]: z.ZodBoolean;
    },
  )
  .strict();

export type CapabilitiesMap = z.infer<typeof CapabilitiesMapSchema>;

const TenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  force_min_app_version: z.string().nullable().optional(),
  force_update_mode: z.enum(["off", "required", "emergency", "inherit"]).optional(),
  force_update_reason: z.string().nullable().optional(),
  rollout_cohort: z.string().optional(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  edition: EditionIdSchema.optional(),
  entitlement_lineage: z.number().optional(),
  offline_grace_hours: z.number().optional(),
  trust_revocation_disconnects_immediately: z.union([z.boolean(), z.number()]).optional(),
  reconnect_requires_fresh_heartbeat: z.union([z.boolean(), z.number()]).optional(),
  is_initialized: z.union([z.boolean(), z.number()]).optional(),
  has_demo_data: z.union([z.boolean(), z.number()]).optional(),
  is_active: z.number().optional(),
  created_at: z.string().optional(),
});

const EditionCatalogEntrySchema = z.object({
  id: EditionIdSchema,
  label: z.string(),
  capabilities: CapabilitiesMapSchema,
  is_system: z.boolean(),
  row_version: z.number(),
  updated_at: z.string().nullable().optional(),
  updated_by: z.string().nullable().optional(),
});

const EditionsResponseSchema = z.object({
  items: z.array(EditionCatalogEntrySchema),
});

const LicenseSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  license_key: z.string(),
  max_machines: z.number(),
  update_channel: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  revoked_reason: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

const ActivationClaimResultSchema = z.object({
  tenant_id: z.string(),
  license_id: z.string(),
  machine_fingerprint: z.string(),
  activation_token: z.string(),
  expires_at: z.string().nullable().optional(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  offline_grace_hours: z.number().optional(),
  trust_revocation_disconnects_immediately: z.boolean().optional(),
  reconnect_requires_fresh_heartbeat: z.boolean().optional(),
  force_min_app_version: z.string().nullable().optional(),
  force_update_mode: z.enum(["off", "required", "emergency"]).optional(),
  force_update_reason: z.string().nullable().optional(),
  force_update_policy_source: z.enum(["tenant", "cohort"]).optional(),
  force_update_required: z.boolean().optional(),
  tenant_display_name: z.string().optional(),
  tenant_slug: z.string().optional(),
  license_status: z.string().optional(),
  license_plan: z.string().optional(),
  edition: EditionIdSchema.optional(),
  license_tier: z.string().optional(),
  device_limit: z.number().optional(),
  activated_device_count: z.number().optional(),
  machine_label: z.string().nullable().optional(),
  is_initialized: z.boolean().optional(),
  has_demo_data: z.boolean().optional(),
  capabilities_digest: z.string().nullable().optional(),
  feature_flags_digest: z.string().nullable().optional(),
  entitlement_envelope: z.record(z.unknown()).optional(),
});

const ActivationTenantStatusSchema = z.object({
  tenant_id: z.string(),
  is_initialized: z.boolean(),
});

const ActivationRowSchema = z.object({
  machine_id: z.string(),
  tenant_id: z.string(),
  last_heartbeat_rfc3339: z.string().nullable(),
  app_version: z.string().nullable().optional(),
  trusted_device: z.boolean(),
  activation_source: z.string(),
  anomaly_flags: z.array(z.string()),
  heartbeat_freshness: z.enum(["live", "stale", "unknown"]),
  update_channel: z.string().optional(),
});

const OfflinePolicySchema = z.object({
  tenant_id: z.string(),
  grace_hours: z.number(),
  trust_revocation_disconnects_immediately: z.boolean(),
  reconnect_requires_fresh_heartbeat: z.boolean(),
});

const TenantUpdatePolicySchema = z.object({
  tenant_id: z.string(),
  update_channel: z.enum(["stable", "pilot", "internal"]),
  rollout_cohort: z.string(),
  force_min_app_version: z.string().nullable(),
  force_update_mode: z.enum(["off", "required", "emergency", "inherit"]),
  force_update_reason: z.string().nullable(),
  audit_record_id: z.string().optional(),
});

const CohortUpdatePolicySchema = z.object({
  channel: z.enum(["stable", "pilot", "internal"]),
  cohort_label: z.string(),
  force_min_app_version: z.string().nullable(),
  force_update_mode: z.enum(["off", "required", "emergency"]),
  force_update_reason: z.string().nullable(),
  audit_record_id: z.string().optional(),
});

export type ControlTenant = z.infer<typeof TenantSchema>;
export type ControlLicense = z.infer<typeof LicenseSchema>;
export type ActivationClaimResult = z.infer<typeof ActivationClaimResultSchema>;
export type ActivationTenantStatus = z.infer<typeof ActivationTenantStatusSchema>;
export type ActivationRow = z.infer<typeof ActivationRowSchema>;
export type OfflinePolicy = z.infer<typeof OfflinePolicySchema>;
export type TenantUpdatePolicy = z.infer<typeof TenantUpdatePolicySchema>;
export type CohortUpdatePolicy = z.infer<typeof CohortUpdatePolicySchema>;
export type EditionId = z.infer<typeof EditionIdSchema>;
export type EditionCatalogEntry = z.infer<typeof EditionCatalogEntrySchema>;
export type PrivilegedActionContext = {
  reason_code: string;
  step_up_token: string;
};

function apiBase(): string {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) throw new Error("VITE_ADMIN_API_BASE_URL is not configured.");
  return raw.replace(/\/$/, "");
}

type ControlPlaneErrorBody = {
  error?: string;
  message?: string;
  detail?: string | unknown;
  details?: unknown;
  max_machines?: number;
};

/** True when the message indicates a duplicate tenant slug (409 from POST /tenants). */
export function isDuplicateTenantSlugMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already taken") ||
    /\b(unique|duplicate)\b.*\bslug\b|\bslug\b.*\b(unique|duplicate)\b/.test(m) ||
    (m.includes("sqlite") && m.includes("unique") && m.includes("slug")) ||
    (m.includes("constraint") && m.includes("slug"))
  );
}

/**
 * Maps control-plane JSON error bodies to operator-readable messages (incl. 409 conflicts).
 */
export async function parseControlPlaneErrorResponse(res: Response): Promise<string> {
  let body: ControlPlaneErrorBody = {};
  try {
    body = (await res.json()) as ControlPlaneErrorBody;
  } catch {
    return `Request failed (${res.status})`;
  }
  const code = typeof body.error === "string" ? body.error.trim() : "";
  const msg = typeof body.message === "string" ? body.message.trim() : "";
  const detailStr =
    typeof body.detail === "string"
      ? body.detail.trim()
      : Array.isArray(body.detail)
        ? body.detail
            .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: string }).msg) : String(d)))
            .join(" ")
        : "";

  if (res.status === 409) {
    if (code === "tenant_conflict") {
      if (isDuplicateTenantSlugMessage(msg) || isDuplicateTenantSlugMessage(detailStr)) {
        return "This tenant slug is already taken. Choose a different slug.";
      }
      if (msg || detailStr) {
        return msg || detailStr;
      }
      return "This tenant slug is already taken. Choose a different slug.";
    }
    if (code === "idempotency_key_conflict") {
      return "This request was already processed with different inputs. Retry with a fresh idempotency key.";
    }
    if (code === "slot_limit_reached") {
      const max = body.max_machines;
      return max != null
        ? `Activation slot limit reached for this license (max ${max} machines).`
        : "Activation slot limit reached for this license.";
    }
    if (code === "no_policy_history") {
      return msg || "No policy history available to roll back.";
    }
    if (code === "license_revoked") {
      return msg || "This license key is revoked and cannot be updated.";
    }
    if (code === "edition_version_conflict") {
      return msg || "This edition was modified by another operator. Refresh and try again.";
    }
    if (code === "edition_in_use") {
      return msg || "This edition is still assigned to one or more tenants (including inactive).";
    }
    if (code === "edition_id_taken") {
      return msg || "An edition with this id already exists.";
    }
    if (msg || detailStr) {
      return msg || detailStr;
    }
  }

  if (res.status === 404 && (code === "tenant_not_found" || code === "license_not_found")) {
    return msg || (code === "license_not_found" ? "License key not found." : "Tenant not found.");
  }

  if (msg) return msg;
  if (detailStr) return detailStr;
  if (code) return `${code.replace(/_/g, " ")} (${res.status})`;
  return `Request failed (${res.status})`;
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  throw new Error(await parseControlPlaneErrorResponse(res));
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated.");
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

const StepUpResponseSchema = z.object({
  step_up_token: z.string().min(1),
  token_type: z.literal("StepUp"),
  expires_in: z.number().int().positive(),
});
export type StepUpGrant = { token: string; expiresAtMs: number };

/**
 * Re-verify the signed-in operator's password and obtain a short-lived step-up token
 * (POST /api/v1/auth/step-up). Required by every privileged action (X-Step-Up-Token).
 */
export async function requestStepUpToken(password: string): Promise<StepUpGrant> {
  const res = await authFetch("/api/v1/auth/step-up", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  await throwIfNotOk(res);
  const parsed = StepUpResponseSchema.parse(await res.json());
  return { token: parsed.step_up_token, expiresAtMs: Date.now() + parsed.expires_in * 1000 };
}

/** Headers for routes guarded server-side by requirePrivilegedAction (reason + step-up). */
export function privilegedHeaders(input: PrivilegedActionContext): Record<string, string> {
  return {
    "X-Operator-Reason": input.reason_code,
    "X-Step-Up-Token": input.step_up_token,
  };
}

function idempotencyKey(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export async function listTenants(): Promise<ControlTenant[]> {
  const res = await authFetch("/api/v1/tenants");
  await throwIfNotOk(res);
  return z.array(TenantSchema).parse(await res.json());
}

export async function listEditions(): Promise<EditionCatalogEntry[]> {
  const res = await authFetch("/api/v1/editions");
  await throwIfNotOk(res);
  return EditionsResponseSchema.parse(await res.json()).items;
}

export async function createEdition(input: {
  id: string;
  label: string;
  capabilities: CapabilitiesMap;
  clone_from?: string;
}): Promise<EditionCatalogEntry> {
  const res = await authFetch("/api/v1/editions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res);
  return EditionCatalogEntrySchema.parse(await res.json());
}

export async function updateEdition(
  editionId: string,
  input: {
    label?: string;
    capabilities: CapabilitiesMap;
    expected_row_version: number;
  },
): Promise<EditionCatalogEntry> {
  const res = await authFetch(`/api/v1/editions/${encodeURIComponent(editionId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    headers: {
      "If-Match": String(input.expected_row_version),
    },
  });
  await throwIfNotOk(res);
  return EditionCatalogEntrySchema.parse(await res.json());
}

export async function deleteEdition(editionId: string): Promise<void> {
  const res = await authFetch(`/api/v1/editions/${encodeURIComponent(editionId)}`, {
    method: "DELETE",
  });
  await throwIfNotOk(res);
}

export async function updateTenant(
  tenantId: string,
  input: {
    slug?: string;
    display_name?: string;
    rollout_cohort?: string;
    update_channel?: "stable" | "pilot" | "internal";
    edition?: EditionId;
  },
): Promise<ControlTenant> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res);
  return TenantSchema.parse(await res.json());
}

export async function deleteTenant(tenantId: string): Promise<void> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
  });
  await throwIfNotOk(res);
}

export async function createTenant(input: {
  slug: string;
  display_name: string;
  force_min_app_version?: string | null;
  force_update_mode?: "off" | "required" | "emergency" | "inherit";
  force_update_reason?: string | null;
  rollout_cohort?: string;
  update_channel?: "stable" | "pilot" | "internal";
  edition?: EditionId;
  offline_grace_hours?: number;
  trust_revocation_disconnects_immediately?: boolean;
  reconnect_requires_fresh_heartbeat?: boolean;
}): Promise<ControlTenant> {
  const res = await authFetch("/api/v1/tenants", {
    method: "POST",
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res);
  return TenantSchema.parse(await res.json());
}

export async function issueLicense(input: {
  tenant_id: string;
  max_machines: number;
  expires_at?: string | null;
  update_channel?: "stable" | "pilot" | "internal";
  operator_reason_code?: string | null;
  operator_rationale?: string | null;
}): Promise<ControlLicense> {
  const res = await authFetch("/api/v1/licenses", {
    method: "POST",
    body: JSON.stringify(input),
    headers: {
      "Idempotency-Key": idempotencyKey("issue-license"),
    },
  });
  await throwIfNotOk(res);
  return LicenseSchema.parse(await res.json());
}

export async function listTenantLicenses(tenantId: string): Promise<ControlLicense[]> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/licenses`);
  await throwIfNotOk(res);
  return z.array(LicenseSchema).parse(await res.json());
}

export async function updateLicense(
  licenseId: string,
  input: {
    max_machines?: number;
    expires_at?: string | null;
    update_channel?: "stable" | "pilot" | "internal";
    operator_rationale?: string | null;
  },
): Promise<ControlLicense> {
  const res = await authFetch(`/api/v1/licenses/${encodeURIComponent(licenseId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res);
  return LicenseSchema.parse(await res.json());
}

export async function revokeLicense(
  licenseId: string,
  reason: string,
  privileged: PrivilegedActionContext,
): Promise<void> {
  const res = await authFetch(`/api/v1/licenses/${encodeURIComponent(licenseId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    headers: {
      "Idempotency-Key": idempotencyKey("revoke-license"),
      ...privilegedHeaders(privileged),
    },
  });
  await throwIfNotOk(res);
}

export async function claimActivation(input: {
  license_key: string;
  machine_fingerprint: string;
  machine_label?: string;
  app_version?: string;
}): Promise<ActivationClaimResult> {
  const res = await fetch(`${apiBase()}/api/v1/activation/claim`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  await throwIfNotOk(res);
  return ActivationClaimResultSchema.parse(await res.json());
}

export async function getActivationTenantStatus(activationToken: string): Promise<ActivationTenantStatus> {
  const res = await fetch(`${apiBase()}/api/v1/activation/tenant-status`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${activationToken}`,
    },
  });
  await throwIfNotOk(res);
  return ActivationTenantStatusSchema.parse(await res.json());
}

export async function markActivationTenantInitialized(
  activationToken: string,
): Promise<ActivationTenantStatus> {
  const res = await fetch(`${apiBase()}/api/v1/activation/tenant-status/initialize`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${activationToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  await throwIfNotOk(res);
  return ActivationTenantStatusSchema.parse(await res.json());
}

export async function listTenantActivations(tenantId: string): Promise<ActivationRow[]> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/activations`);
  await throwIfNotOk(res);
  return z.array(ActivationRowSchema).parse(await res.json());
}

export async function getTenantOfflinePolicy(tenantId: string): Promise<OfflinePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/offline-policy`);
  await throwIfNotOk(res);
  return OfflinePolicySchema.parse(await res.json());
}

export async function updateTenantOfflinePolicy(
  tenantId: string,
  input: {
    offline_grace_hours: number;
    trust_revocation_disconnects_immediately: boolean;
    reconnect_requires_fresh_heartbeat: boolean;
  },
  privileged: PrivilegedActionContext,
): Promise<OfflinePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/offline-policy`, {
    method: "PUT",
    body: JSON.stringify(input),
    headers: privilegedHeaders(privileged),
  });
  await throwIfNotOk(res);
  return OfflinePolicySchema.parse(await res.json());
}

export async function getTenantUpdatePolicy(tenantId: string): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy`);
  await throwIfNotOk(res);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function updateTenantUpdatePolicy(
  tenantId: string,
  input: {
    force_min_app_version?: string | null;
    force_update_mode?: "off" | "required" | "emergency" | "inherit";
    force_update_reason?: string | null;
  },
  privileged: PrivilegedActionContext,
): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy`, {
    method: "PUT",
    body: JSON.stringify(input),
    headers: privilegedHeaders(privileged),
  });
  await throwIfNotOk(res);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function rollbackTenantUpdatePolicy(
  tenantId: string,
  privileged: PrivilegedActionContext,
): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy/rollback`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: privilegedHeaders(privileged),
  });
  await throwIfNotOk(res);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function getCohortUpdatePolicy(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy`,
  );
  await throwIfNotOk(res);
  return CohortUpdatePolicySchema.parse(await res.json());
}

export async function updateCohortUpdatePolicy(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
  input: {
    force_min_app_version?: string | null;
    force_update_mode?: "off" | "required" | "emergency";
    force_update_reason?: string | null;
  },
  privileged: PrivilegedActionContext,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy`,
    {
      method: "PUT",
      body: JSON.stringify(input),
      headers: privilegedHeaders(privileged),
    },
  );
  await throwIfNotOk(res);
  return CohortUpdatePolicySchema.parse(await res.json());
}

export async function rollbackCohortUpdatePolicy(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
  privileged: PrivilegedActionContext,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy/rollback`,
    {
      method: "POST",
      body: JSON.stringify({}),
      headers: privilegedHeaders(privileged),
    },
  );
  await throwIfNotOk(res);
  return CohortUpdatePolicySchema.parse(await res.json());
}

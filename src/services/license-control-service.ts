import { z } from "zod";

import { getAccessToken } from "@/lib/auth-token";

const TenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  display_name: z.string(),
  force_min_app_version: z.string().nullable().optional(),
  force_update_mode: z.enum(["off", "required", "emergency", "inherit"]).optional(),
  force_update_reason: z.string().nullable().optional(),
  rollout_cohort: z.string().optional(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  offline_grace_hours: z.number().optional(),
  trust_revocation_disconnects_immediately: z.union([z.boolean(), z.number()]).optional(),
  reconnect_requires_fresh_heartbeat: z.union([z.boolean(), z.number()]).optional(),
  is_active: z.number().optional(),
  created_at: z.string().optional(),
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
export type ActivationRow = z.infer<typeof ActivationRowSchema>;
export type OfflinePolicy = z.infer<typeof OfflinePolicySchema>;
export type TenantUpdatePolicy = z.infer<typeof TenantUpdatePolicySchema>;
export type CohortUpdatePolicy = z.infer<typeof CohortUpdatePolicySchema>;
export type PrivilegedActionContext = {
  reason_code: string;
  step_up_token: string;
};

function apiBase(): string {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) throw new Error("VITE_ADMIN_API_BASE_URL is not configured.");
  return raw.replace(/\/$/, "");
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

function privilegedHeaders(input?: PrivilegedActionContext): Record<string, string> {
  if (!input) return {};
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
  if (!res.ok) throw new Error(`Tenant fetch failed (${res.status})`);
  return z.array(TenantSchema).parse(await res.json());
}

export async function createTenant(input: {
  slug: string;
  display_name: string;
  force_min_app_version?: string | null;
  force_update_mode?: "off" | "required" | "emergency" | "inherit";
  force_update_reason?: string | null;
  rollout_cohort?: string;
  update_channel?: "stable" | "pilot" | "internal";
  offline_grace_hours?: number;
  trust_revocation_disconnects_immediately?: boolean;
  reconnect_requires_fresh_heartbeat?: boolean;
}): Promise<ControlTenant> {
  const res = await authFetch("/api/v1/tenants", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Tenant create failed (${res.status})`);
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
  if (!res.ok) throw new Error(`Issue license failed (${res.status})`);
  return LicenseSchema.parse(await res.json());
}

export async function listTenantLicenses(tenantId: string): Promise<ControlLicense[]> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/licenses`);
  if (!res.ok) throw new Error(`License list failed (${res.status})`);
  return z.array(LicenseSchema).parse(await res.json());
}

export async function revokeLicense(licenseId: string, reason?: string): Promise<void> {
  const res = await authFetch(`/api/v1/licenses/${encodeURIComponent(licenseId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    headers: {
      "Idempotency-Key": idempotencyKey("revoke-license"),
    },
  });
  if (!res.ok) throw new Error(`License revoke failed (${res.status})`);
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
  if (!res.ok) throw new Error(`Activation claim failed (${res.status})`);
  return ActivationClaimResultSchema.parse(await res.json());
}

export async function listTenantActivations(tenantId: string): Promise<ActivationRow[]> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/activations`);
  if (!res.ok) throw new Error(`Activation list failed (${res.status})`);
  return z.array(ActivationRowSchema).parse(await res.json());
}

export async function getTenantOfflinePolicy(tenantId: string): Promise<OfflinePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/offline-policy`);
  if (!res.ok) throw new Error(`Offline policy fetch failed (${res.status})`);
  return OfflinePolicySchema.parse(await res.json());
}

export async function updateTenantOfflinePolicy(
  tenantId: string,
  input: {
    offline_grace_hours: number;
    trust_revocation_disconnects_immediately: boolean;
    reconnect_requires_fresh_heartbeat: boolean;
  },
): Promise<OfflinePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/offline-policy`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Offline policy update failed (${res.status})`);
  return OfflinePolicySchema.parse(await res.json());
}

export async function getTenantUpdatePolicy(tenantId: string): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy`);
  if (!res.ok) throw new Error(`Tenant update policy fetch failed (${res.status})`);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function updateTenantUpdatePolicy(
  tenantId: string,
  input: {
    force_min_app_version?: string | null;
    force_update_mode?: "off" | "required" | "emergency" | "inherit";
    force_update_reason?: string | null;
  },
  privileged?: PrivilegedActionContext,
): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy`, {
    method: "PUT",
    body: JSON.stringify(input),
    headers: privilegedHeaders(privileged),
  });
  if (!res.ok) throw new Error(`Tenant update policy update failed (${res.status})`);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function rollbackTenantUpdatePolicy(
  tenantId: string,
  privileged?: PrivilegedActionContext,
): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy/rollback`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: privilegedHeaders(privileged),
  });
  if (!res.ok) throw new Error(`Tenant update policy rollback failed (${res.status})`);
  return TenantUpdatePolicySchema.parse(await res.json());
}

export async function getCohortUpdatePolicy(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy`,
  );
  if (!res.ok) throw new Error(`Cohort update policy fetch failed (${res.status})`);
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
  privileged?: PrivilegedActionContext,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy`,
    {
      method: "PUT",
      body: JSON.stringify(input),
      headers: privilegedHeaders(privileged),
    },
  );
  if (!res.ok) throw new Error(`Cohort update policy update failed (${res.status})`);
  return CohortUpdatePolicySchema.parse(await res.json());
}

export async function rollbackCohortUpdatePolicy(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
  privileged?: PrivilegedActionContext,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy/rollback`,
    {
      method: "POST",
      body: JSON.stringify({}),
      headers: privilegedHeaders(privileged),
    },
  );
  if (!res.ok) throw new Error(`Cohort update policy rollback failed (${res.status})`);
  return CohortUpdatePolicySchema.parse(await res.json());
}

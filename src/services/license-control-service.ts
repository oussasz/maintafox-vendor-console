import { z } from "zod";

import { apiBase } from "@/lib/api-base";
import { authFetch } from "@/lib/api-client";
import { throwIfNotOk } from "@/lib/api-error";

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
  "notifications.email",
] as const;

export type ModuleCapabilityKey = (typeof MODULE_CAPABILITY_KEYS)[number];
export { MODULE_CAPABILITY_KEYS };

const CapabilitiesMapSchema = z
  .object(
    Object.fromEntries(MODULE_CAPABILITY_KEYS.map((k) => [k, z.boolean()])) as {
      [K in ModuleCapabilityKey]: z.ZodBoolean;
    },
  )
  // A module a newer server adds is kept as is (and sent back unchanged on save), never a
  // reason to refuse the whole edition list.
  .passthrough();

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
  /** Soft suspension (POST /tenants/:id/suspend): when and why; null when active. */
  suspended_at: z.string().nullable().optional(),
  suspended_reason: z.string().nullable().optional(),
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
  machine_label: z.string().nullable().optional(),
  tenant_id: z.string(),
  activated_at_rfc3339: z.string().optional(),
  revoked_at_rfc3339: z.string().nullable().optional(),
  last_heartbeat_rfc3339: z.string().nullable(),
  app_version: z.string().nullable().optional(),
  trusted_device: z.boolean(),
  /**
   * 'machine' = revoked by an operator (reinstatable), 'license' = licence revoked,
   * 'released' = slot freed by an operator (the device may activate again), null = active.
   */
  revocation_kind: z.enum(["machine", "license", "released"]).nullable().optional(),
  /** Set while an operator-requested policy refresh waits for the device. */
  policy_refresh_requested_at: z.string().nullable().optional(),
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

/** Minimum X-Operator-Reason length; the API enforces the same (api/src/app/config.ts). */
export const PRIVILEGED_REASON_MIN_LENGTH = 4;

/** Headers for routes guarded server-side by requirePrivilegedAction (reason + step-up). */
export function privilegedHeaders(input: PrivilegedActionContext): Record<string, string> {
  return {
    "X-Operator-Reason": input.reason_code,
    "X-Step-Up-Token": input.step_up_token,
  };
}

/** A fresh Idempotency-Key: the API replays the first answer when the same key is sent again. */
export function idempotencyKey(prefix: string): string {
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

/** Irreversible purge: the API needs the slug retyped, a reason and a `tenant_delete` step-up. */
export async function deleteTenant(
  tenantId: string,
  input: { confirm_slug: string } & PrivilegedActionContext,
): Promise<void> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
    headers: privilegedHeaders(input),
    body: JSON.stringify({ confirm_slug: input.confirm_slug }),
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

/**
 * Revoke one device: its next request is refused (`activation_revoked`), its slot is freed, and
 * re-entering the licence key on that device does not undo it.
 */
export async function revokeMachine(
  tenantId: string,
  machineFingerprint: string,
  reason: string,
  privileged: PrivilegedActionContext,
): Promise<void> {
  const res = await authFetch(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/machines/${encodeURIComponent(machineFingerprint)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      headers: {
        "Idempotency-Key": idempotencyKey("revoke-machine"),
        ...privilegedHeaders(privileged),
      },
    },
  );
  await throwIfNotOk(res);
}

/** Reinstate a device revoked with `revokeMachine` (needs a free slot on its licence). */
export async function reinstateMachine(
  tenantId: string,
  machineFingerprint: string,
  reason: string,
  privileged: PrivilegedActionContext,
): Promise<void> {
  const res = await authFetch(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/machines/${encodeURIComponent(machineFingerprint)}/reinstate`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
      headers: {
        "Idempotency-Key": idempotencyKey("reinstate-machine"),
        ...privilegedHeaders(privileged),
      },
    },
  );
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

/**
 * Removes the customer's minimum version (and nothing else). `expectedFloor` is the floor the
 * operator confirmed; the server refuses (409) when the stored one differs.
 */
export async function clearTenantMinAppVersion(
  tenantId: string,
  expectedFloor: string,
  privileged: PrivilegedActionContext,
): Promise<TenantUpdatePolicy> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/update-policy/clear-min-version`, {
    method: "POST",
    body: JSON.stringify({ expected_force_min_app_version: expectedFloor }),
    headers: privilegedHeaders(privileged),
  });
  await throwIfNotOk(res);
  return TenantUpdatePolicySchema.parse(await res.json());
}

/** Removes the rollout group's minimum version (see clearTenantMinAppVersion). */
export async function clearCohortMinAppVersion(
  channel: "stable" | "pilot" | "internal",
  cohortLabel: string,
  expectedFloor: string,
  privileged: PrivilegedActionContext,
): Promise<CohortUpdatePolicy> {
  const res = await authFetch(
    `/api/v1/cohorts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/update-policy/clear-min-version`,
    {
      method: "POST",
      body: JSON.stringify({ expected_force_min_app_version: expectedFloor }),
      headers: privilegedHeaders(privileged),
    },
  );
  await throwIfNotOk(res);
  return CohortUpdatePolicySchema.parse(await res.json());
}

async function postMachineAction(
  tenantId: string,
  machineFingerprint: string,
  action: "release" | "rebind" | "policy-refresh",
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<void> {
  const res = await authFetch(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/machines/${encodeURIComponent(machineFingerprint)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": idempotencyKey(`machine-${action}`), ...headers },
    },
  );
  await throwIfNotOk(res);
}

/** Frees the machine's slot; the device may activate again later (step-up `machine_trust_change`). */
export async function releaseMachineSlot(
  tenantId: string,
  machineFingerprint: string,
  privileged: PrivilegedActionContext,
): Promise<void> {
  await postMachineAction(tenantId, machineFingerprint, "release", { reason: privileged.reason_code }, privilegedHeaders(privileged));
}

/** Moves the machine's slot to its replacement (step-up `machine_trust_change`). */
export async function rebindMachine(
  tenantId: string,
  machineFingerprint: string,
  newMachineFingerprint: string,
  privileged: PrivilegedActionContext,
): Promise<void> {
  await postMachineAction(
    tenantId,
    machineFingerprint,
    "rebind",
    { new_machine_fingerprint: newMachineFingerprint, reason: privileged.reason_code },
    privilegedHeaders(privileged),
  );
}

/** Asks the device to fetch its policy now (audited, reason required, no step-up). */
export async function requestMachinePolicyRefresh(tenantId: string, machineFingerprint: string, reasonCode: string): Promise<void> {
  await postMachineAction(tenantId, machineFingerprint, "policy-refresh", {}, { "X-Operator-Reason": reasonCode });
}

const AdminRecoveryCodeIssuedSchema = z.object({
  code: z.string().regex(/^MFXREC1\.[A-Za-z0-9_-]+\.[0-9a-f]{128}$/),
  code_id: z.string(),
  tenant_id: z.string(),
  machine_fingerprint: z.string(),
  license_id: z.string(),
  issued_at: z.string(),
  expires_at: z.string(),
  key_id: z.string(),
  requested_by: z.string(),
  identity_check: z.string(),
  identity_check_note: z.string().nullable(),
  audit_record_id: z.string(),
});
export type AdminRecoveryCodeIssued = z.infer<typeof AdminRecoveryCodeIssuedSchema>;

const AdminRecoveryCodeRowSchema = z.object({
  code_id: z.string(),
  tenant_id: z.string(),
  license_id: z.string(),
  machine_fingerprint: z.string(),
  issued_by: z.string(),
  reason: z.string(),
  requested_by: z.string(),
  identity_check: z.string(),
  identity_check_note: z.string().nullable(),
  issued_at: z.string(),
  expires_at: z.string(),
  key_id: z.string(),
  audit_record_id: z.string(),
  expired: z.boolean(),
});
export type AdminRecoveryCodeRow = z.infer<typeof AdminRecoveryCodeRowSchema>;

/** How the operator checked the requester against the customer's registered contact (API enum). */
export const ADMIN_RECOVERY_IDENTITY_CHECKS = ["callback_registered_phone", "email_from_registered_address", "in_person", "other"] as const;
export type AdminRecoveryIdentityCheck = (typeof ADMIN_RECOVERY_IDENTITY_CHECKS)[number];
export type AdminRecoveryRequester = {
  /** Name and role of the person at the customer who asked (2-120 chars). */
  requested_by: string;
  identity_check: AdminRecoveryIdentityCheck;
  /** Required (5-200 chars) with "other"; optional otherwise. */
  identity_check_note?: string;
};

/**
 * Issues a signed one-time administrator recovery code for the PC (step-up `admin_recovery_code`).
 * The code is in this response only: the server does not keep it. No Idempotency-Key (the server
 * does not replay this response, so the code is never stored with it).
 */
export async function issueAdminRecoveryCode(
  tenantId: string,
  machineFingerprint: string,
  requester: AdminRecoveryRequester,
  privileged: PrivilegedActionContext,
): Promise<AdminRecoveryCodeIssued> {
  const note = requester.identity_check_note?.trim();
  const body = {
    requested_by: requester.requested_by.trim(),
    identity_check: requester.identity_check,
    ...(note ? { identity_check_note: note } : {}),
  };
  const res = await authFetch(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/machines/${encodeURIComponent(machineFingerprint)}/admin-recovery-code`,
    { method: "POST", body: JSON.stringify(body), headers: privilegedHeaders(privileged) },
  );
  await throwIfNotOk(res);
  return AdminRecoveryCodeIssuedSchema.parse(await res.json());
}

/** Recovery codes issued for a customer's PCs (newest first), without the codes themselves. */
export async function listAdminRecoveryCodes(tenantId: string, machineFingerprint?: string): Promise<AdminRecoveryCodeRow[]> {
  const query = machineFingerprint ? `?machine_fingerprint=${encodeURIComponent(machineFingerprint)}` : "";
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/admin-recovery-codes${query}`);
  await throwIfNotOk(res);
  return z.array(AdminRecoveryCodeRowSchema).parse(await res.json());
}

/** Soft-suspends a tenant: its devices are refused, data kept (step-up `entitlement_suspension`). */
export async function suspendTenant(tenantId: string, privileged: PrivilegedActionContext): Promise<void> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason: privileged.reason_code }),
    headers: { "Idempotency-Key": idempotencyKey("tenant-suspend"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
}

/** Lifts a soft suspension; devices are asked to refresh their policy (step-up `tenant_restore`). */
export async function resumeTenant(tenantId: string, privileged: PrivilegedActionContext): Promise<void> {
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ reason: privileged.reason_code }),
    headers: { "Idempotency-Key": idempotencyKey("tenant-resume"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
}

export type RolloutGovernanceAction = "pause" | "resume" | "recall";

/**
 * Pause / resume / recall one (channel, cohort). Step-up `rollout_publish` (pause, resume) or
 * `forced_rollback` (recall). Devices act on it with the Phase 5 updater.
 */
export async function setRolloutGovernance(
  channel: string,
  cohortLabel: string,
  action: RolloutGovernanceAction,
  input: { recalled_version?: string } & PrivilegedActionContext,
): Promise<void> {
  const res = await authFetch(
    `/api/v1/rollouts/${encodeURIComponent(channel)}/${encodeURIComponent(cohortLabel)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(
        action === "recall"
          ? { reason: input.reason_code, recalled_version: input.recalled_version }
          : { reason: input.reason_code },
      ),
      headers: { "Idempotency-Key": idempotencyKey(`rollout-${action}`), ...privilegedHeaders(input) },
    },
  );
  await throwIfNotOk(res);
}

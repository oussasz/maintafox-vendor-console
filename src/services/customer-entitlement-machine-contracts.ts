import { z } from "zod";

/** Aligns with `vps::customer_entitlement_machine::EntitlementLifecycleState`. */
export const EntitlementLifecycleStateSchema = z.enum([
  "active",
  "grace",
  "expired",
  "suspended",
  "revoked",
]);

export type EntitlementLifecycleState = z.infer<typeof EntitlementLifecycleStateSchema>;

export const EntitlementLifecycleActionSchema = z.enum([
  "issue",
  "renew",
  "suspend",
  "revoke",
  "emergency_lock",
  "resume_from_suspension",
]);

export type EntitlementLifecycleAction = z.infer<typeof EntitlementLifecycleActionSchema>;

export const UpdateChannelSchema = z.enum(["stable", "pilot", "internal"]);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

/** Client-side guard mirroring Rust `entitlement_transition_allowed`. */
export function entitlementTransitionAllowed(
  from: EntitlementLifecycleState,
  action: EntitlementLifecycleAction,
): boolean {
  if (
    (from === "expired" || from === "revoked") &&
    action === "issue"
  ) {
    return true;
  }
  if ((from === "active" || from === "grace") && action === "renew") return true;
  if ((from === "active" || from === "grace") && action === "suspend") return true;
  if (from === "suspended" && action === "resume_from_suspension") return true;
  if ((from === "active" || from === "grace" || from === "suspended") && action === "revoke") {
    return true;
  }
  if ((from === "active" || from === "grace") && action === "emergency_lock") return true;
  return false;
}

export const SignedClaimPreviewV1Schema = z.object({
  schema_version: z.number().int().nonnegative(),
  tenant_id: z.string().min(1),
  tier: z.string().min(1),
  machine_slots: z.number().int().nonnegative(),
  offline_grace_hours: z.number().int().nonnegative(),
  update_channel: UpdateChannelSchema,
  valid_from_rfc3339: z.string(),
  valid_until_rfc3339: z.string(),
  feature_flags_digest: z.string().min(1),
  capabilities_digest: z.string().min(1),
  issuer: z.string(),
  key_id: z.string(),
  payload_sha256: z.string().length(64),
  signature_alg: z.string(),
});

export const DestructiveEntitlementActionSchema = z.enum([
  "revocation",
  "immediate_expiry",
  "machine_slot_reduction",
]);

export const AuditableApprovalContextV1Schema = z.object({
  actor_id: z.string().min(1),
  second_actor_id: z.string().optional(),
  reason_code: z.string().min(4),
  free_text_rationale: z.string().min(10),
  previous_claim_snapshot_sha256: z.string().length(64),
  correlation_id: z.string().min(8),
});

export const MachineActivationRowV1Schema = z.object({
  machine_id: z.string().min(1),
  tenant_id: z.string().min(1),
  last_heartbeat_rfc3339: z.string().nullable(),
  app_version: z.string().nullable(),
  trusted_device: z.boolean(),
  activation_source: z.string(),
  anomaly_flags: z.array(z.string()),
  heartbeat_freshness: z.enum(["live", "stale", "unknown"]),
});

export const BulkEntitlementOperationRequestV1Schema = z.object({
  dry_run: z.boolean(),
  tenant_ids: z.array(z.string().min(1)),
  target_channel: UpdateChannelSchema.optional(),
  expected_lineage_version_by_tenant: z.array(
    z.tuple([z.string().min(1), z.number().int()]),
  ),
});

export const OptimisticConcurrencyV1Schema = z.object({
  resource_id: z.string().min(1),
  expected_version: z.number().int(),
});

export function validateSlotLimits(machineSlots: number, activeMachines: number): boolean {
  return activeMachines <= machineSlots;
}

export function channelPolicyConsistent(
  licenseChannel: UpdateChannel,
  rolloutChannel: UpdateChannel,
): boolean {
  return licenseChannel === rolloutChannel;
}

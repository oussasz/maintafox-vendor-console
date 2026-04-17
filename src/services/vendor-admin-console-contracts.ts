import { z } from "zod";

/** Vendor console RBAC — must match migration 066 / `vps::vendor_admin_console::permissions`. */
export const VendorConsolePermissionSchema = z.enum([
  "console.view",
  "customer.manage",
  "entitlement.manage",
  "sync.operate",
  "rollout.manage",
  "platform.observe",
  "audit.view",
]);

export type VendorConsolePermission = z.infer<typeof VendorConsolePermissionSchema>;

export const VendorAdminMutationActionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/, "Action must be a lowercase slug (server catalog).");

/** Typed wrapper for control-plane admin mutations (aligns with `VpsAdminMutationRequest`). */
export const VendorAdminMutationEnvelopeSchema = z.object({
  contract_family: z.literal("admin"),
  api_version: z.union([z.literal("v1"), z.string()]),
  action: VendorAdminMutationActionSchema,
  idempotency_key: z.string().min(8).max(128),
  /** Optional: correlation for structured logs (server should echo). */
  correlation_id: z.string().min(8).max(64).optional(),
  /** Permissions actor claims — server MUST ignore and load from session. */
  _client_claimed_permissions: z.array(VendorConsolePermissionSchema).optional(),
});

export type VendorAdminMutationEnvelope = z.infer<typeof VendorAdminMutationEnvelopeSchema>;

export const VendorAdminMfaEventSchema = z.object({
  kind: z.enum([
    "login_success",
    "login_failure",
    "mfa_challenge_shown",
    "mfa_success",
    "mfa_failure",
    "step_up_prompted",
    "step_up_satisfied",
    "privileged_action_denied",
    "privileged_action_committed",
    "refresh_rotated",
    "logout",
  ]),
  correlation_id: z.string().min(8).max(64),
  actor_id: z.string().min(1).max(128),
  route: z.string().min(1).max(256),
  detail_code: z.string().min(1).max(64),
});

export type VendorAdminMfaEvent = z.infer<typeof VendorAdminMfaEventSchema>;

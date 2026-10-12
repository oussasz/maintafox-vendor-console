/**
 * Console operator roles and the permission every console route requires (master plan Phase 4.3).
 *
 * Permissions are checked server-side by authMiddleware for every route it protects: the route's
 * pattern must be listed in ROUTE_PERMISSIONS, otherwise the request is refused (fail closed), and
 * api/scripts/operators-roles.integration.mjs checks that every registered console route is listed.
 * The console only hides what an operator cannot use; it never decides access.
 *
 * The first seven permission names are the desktop's console RBAC constants
 * (src-tauri/src/rbac, vendor_admin_console.rs); support.manage and operator.manage are
 * console-only.
 */
export const PERMISSIONS = [
  "console.view",
  "customer.manage",
  "entitlement.manage",
  "sync.operate",
  "rollout.manage",
  "platform.observe",
  "audit.view",
  "support.manage",
  "operator.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "operations", "support", "auditor"] as const;
export type Role = (typeof ROLES)[number];

/** Least privilege: each role gets only what its job needs. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  /** Everything, including managing operators. */
  owner: PERMISSIONS,
  /** Runs customers, licences, machines, rollouts and support; cannot manage operators. */
  operations: [
    "console.view",
    "customer.manage",
    "entitlement.manage",
    "sync.operate",
    "rollout.manage",
    "platform.observe",
    "audit.view",
    "support.manage",
  ],
  /** Helps customers: tickets, bundles, sync repair, read-only elsewhere. */
  support: ["console.view", "sync.operate", "platform.observe", "audit.view", "support.manage"],
  /** Reads the audit trail and platform health; changes nothing. */
  auditor: ["console.view", "platform.observe", "audit.view"],
};

/** A signed-in operator of any role (their own session, step-up, permissions). */
export const ANY_OPERATOR = "authenticated" as const;
export type RouteRequirement = Permission | typeof ANY_OPERATOR;

/**
 * `METHOD /express/route/pattern` → what the caller needs. Every route protected by authMiddleware
 * must be here; a missing entry refuses the request (500 route_permission_missing, logged).
 */
export const ROUTE_PERMISSIONS: Readonly<Record<string, RouteRequirement>> = {
  // Own session
  "POST /api/v1/auth/logout-all": ANY_OPERATOR,
  "GET /api/v1/auth/session": ANY_OPERATOR,
  "POST /api/v1/auth/step-up": ANY_OPERATOR,
  "POST /api/v1/auth/mfa/recovery-codes": ANY_OPERATOR,
  "POST /api/v1/auth/password": ANY_OPERATOR,
  "GET /api/v1/me/permissions": ANY_OPERATOR,

  // Customers (tenants)
  "GET /api/v1/tenants": "console.view",
  "POST /api/v1/tenants": "customer.manage",
  "PATCH /api/v1/tenants/:tenantId": "customer.manage",
  "DELETE /api/v1/tenants/:tenantId": "customer.manage",
  "POST /api/v1/tenants/:tenantId/suspend": "customer.manage",
  "POST /api/v1/tenants/:tenantId/resume": "customer.manage",

  // Editions, licences, machines, offline policy
  "GET /api/v1/editions": "console.view",
  "POST /api/v1/editions": "entitlement.manage",
  "PATCH /api/v1/editions/:editionId": "entitlement.manage",
  "DELETE /api/v1/editions/:editionId": "entitlement.manage",
  "GET /api/v1/tenants/:tenantId/licenses": "console.view",
  "POST /api/v1/licenses": "entitlement.manage",
  "PATCH /api/v1/licenses/:licenseId": "entitlement.manage",
  "POST /api/v1/licenses/:licenseId/revoke": "entitlement.manage",
  "GET /api/v1/tenants/:tenantId/activations": "console.view",
  "POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/revoke": "entitlement.manage",
  "POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/reinstate": "entitlement.manage",
  "POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/release": "entitlement.manage",
  "POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/rebind": "entitlement.manage",
  "POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/policy-refresh": "entitlement.manage",
  "GET /api/v1/tenants/:tenantId/offline-policy": "console.view",
  "PUT /api/v1/tenants/:tenantId/offline-policy": "entitlement.manage",

  // Releases and rollouts
  "GET /api/v1/tenants/:tenantId/update-policy": "console.view",
  "PUT /api/v1/tenants/:tenantId/update-policy": "rollout.manage",
  "POST /api/v1/tenants/:tenantId/update-policy/rollback": "rollout.manage",
  "GET /api/v1/cohorts/:channel/:cohort/update-policy": "console.view",
  "PUT /api/v1/cohorts/:channel/:cohort/update-policy": "rollout.manage",
  "POST /api/v1/cohorts/:channel/:cohort/update-policy/rollback": "rollout.manage",
  "POST /api/v1/rollouts/:channel/:cohort/pause": "rollout.manage",
  "POST /api/v1/rollouts/:channel/:cohort/resume": "rollout.manage",
  "POST /api/v1/rollouts/:channel/:cohort/recall": "rollout.manage",

  // Operations dashboards
  "GET /api/v1/ops/sync-overview": "sync.operate",
  "GET /api/v1/ops/rollout-overview": "rollout.manage",
  "GET /api/v1/ops/platform-overview": "platform.observe",
  "GET /api/v1/ops/observability/slo": "platform.observe",
  "GET /api/v1/ops/metrics": "platform.observe",

  // Audit
  "GET /api/v1/audit/ledger": "audit.view",
  "GET /api/v1/audit/ledger/export": "audit.view",
  "GET /api/v1/audit/ledger/verify-chain": "audit.view",
  "GET /api/v1/audit/hardening/readiness": "audit.view",
  "GET /api/v1/audit/hardening/runbooks": "audit.view",
  "POST /api/v1/audit/hardening/runbooks": "support.manage",
  "PUT /api/v1/audit/hardening/runbooks/:runbookId": "support.manage",
  "DELETE /api/v1/audit/hardening/runbooks/:runbookId": "support.manage",

  // Support
  "GET /api/v1/support/tickets": "audit.view",
  "POST /api/v1/support/tickets": "support.manage",
  "POST /api/v1/support/tickets/:ticketId/interventions": "support.manage",
  "GET /api/v1/support/tickets/export": "audit.view",
  "GET /api/v1/support/diagnostic-bundles": "support.manage",
  "GET /api/v1/support/diagnostic-bundles/latest": "support.manage",
  "GET /api/v1/support/diagnostic-bundles/:bundleId/download": "support.manage",
  "GET /api/v1/support/offline-reconciliation": "support.manage",

  // Billing (subscription, payment history, reconciliation with SlickPay)
  "GET /api/v1/billing/tenants/:tenantId/subscription": "customer.manage",
  "GET /api/v1/billing/payments": "customer.manage",
  "POST /api/v1/billing/payments/:orderId/reconcile": "customer.manage",

  // Operators
  "GET /api/v1/operators": "operator.manage",
  "POST /api/v1/operators": "operator.manage",
  "PATCH /api/v1/operators/:operatorId": "operator.manage",
  "DELETE /api/v1/operators/:operatorId": "operator.manage",
  "POST /api/v1/operators/:operatorId/mfa-reset": "operator.manage",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleAllows(role: Role, requirement: RouteRequirement): boolean {
  return requirement === ANY_OPERATOR || ROLE_PERMISSIONS[role].includes(requirement);
}

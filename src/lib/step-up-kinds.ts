/**
 * Step-up action kinds, from the catalog shared with the control API and checked against the
 * desktop's Rust StepUpActionKind (shared/step-up-actions.v1.json). The server issues a step-up
 * token for one kind and accepts it only on that kind's routes; the console asks for the kind of
 * the action the operator is about to perform.
 */
import catalog from "@shared/step-up-actions.v1.json";

declare const stepUpKindBrand: unique symbol;
export type StepUpActionKind = string & { readonly [stepUpKindBrand]: true };

const KNOWN = new Set(catalog.kinds.map((entry) => entry.kind));

function kind(name: string): StepUpActionKind {
  if (!KNOWN.has(name)) throw new Error(`step-up action kind '${name}' is not in shared/step-up-actions.v1.json`);
  return name as StepUpActionKind;
}

/** The kinds the console's privileged actions use (each checked against the catalog on load). */
export const StepUpKinds = {
  entitlementSuspension: kind("entitlement_suspension"),
  forcedRollback: kind("forced_rollback"),
  tenantRestore: kind("tenant_restore"),
  rolloutPublish: kind("rollout_publish"),
  machineTrustChange: kind("machine_trust_change"),
  offlinePolicyChange: kind("offline_policy_change"),
  supportIntervention: kind("support_intervention"),
  syncRepair: kind("sync_repair"),
  vendorUserAdmin: kind("vendor_user_admin"),
  tenantDelete: kind("tenant_delete"),
  ownMfaChange: kind("own_mfa_change"),
} as const;

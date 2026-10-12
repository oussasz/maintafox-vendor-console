/**
 * Step-up action kinds (master plan Phase 4.1). A step-up token is issued for one kind and every
 * privileged route accepts only the kind it declares, so a proof given for one action cannot be
 * spent on another.
 *
 * Source of truth: `shared/step-up-actions.v1.json` at the repository root (copied into the API
 * image at /app/shared, read by the console too). The kinds named below are checked against it at
 * startup: a route naming a kind the catalog does not have stops the API before it serves anything.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const STEP_UP_ACTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../shared/step-up-actions.v1.json");

const CatalogFile = z
  .object({
    version: z.literal(1),
    description: z.string(),
    kinds: z
      .array(
        z
          .object({
            kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            rust_variant: z.string().regex(/^[A-Z][A-Za-z0-9]*$/).nullable(),
            description: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function loadCatalog(path: string): ReadonlySet<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read step-up action catalog at ${path}: ${(err as Error).message}`);
  }
  const parsed = CatalogFile.safeParse(raw);
  if (!parsed.success) throw new Error(`step-up action catalog ${path} is invalid: ${parsed.error.message}`);
  const kinds = new Set<string>();
  for (const entry of parsed.data.kinds) {
    if (kinds.has(entry.kind)) throw new Error(`step-up action catalog lists '${entry.kind}' twice`);
    kinds.add(entry.kind);
  }
  return kinds;
}

const CATALOG = loadCatalog(STEP_UP_ACTIONS_PATH);

declare const stepUpKindBrand: unique symbol;
/** A kind known to be in the catalog. */
export type StepUpActionKind = string & { readonly [stepUpKindBrand]: true };

function kind(name: string): StepUpActionKind {
  if (!CATALOG.has(name)) {
    throw new Error(`step-up action kind '${name}' is not in ${STEP_UP_ACTIONS_PATH}`);
  }
  return name as StepUpActionKind;
}

export function isStepUpActionKind(value: string): value is StepUpActionKind {
  return CATALOG.has(value);
}

/** The kinds the API's privileged routes use (each one is checked against the catalog at startup). */
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

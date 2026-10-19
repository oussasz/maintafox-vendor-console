/**
 * Forced-update policy: which policy applies to a PC (tenant override or rollout cohort) and
 * whether that PC must update before it may keep working.
 *
 * Fail-closed rule: under mode "required" a PC is let through only when BOTH its reported app
 * version and the policy's minimum version parse as strict semantic versions and the PC's version
 * is at least the minimum. A missing, empty or unparsable version ("abc", "1.2", "99",
 * "2.0.0garbage", "v2.0.0") counts as "unknown", and unknown never satisfies the floor. The older
 * lenient comparison (`semverCompare`) read "99" as 99.0.0 and "2.0.0garbage" as 2.0.0, so an
 * odd string could pass the floor; it is not used here.
 */
import type { ForceUpdateMode } from "./runtime.js";

type ParsedVersion = { core: [number, number, number]; prerelease: string | null };

// MAJOR.MINOR.PATCH with an optional pre-release tag (desktop dev builds report e.g. "0.4.0-dev").
// No leading zeros, no "v" prefix, no build metadata. Anything else is "unknown".
const STRICT_SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// The operator-entered floor is free text (max 32) in the console; "2.0" or "v2.0.0" there means
// 2.0.0, so it is padded/normalised (exact meaning, never loosens). A floor that still does not
// parse is "unknown" and blocks everyone under "required" (as a missing floor always did).
const OPERATOR_FLOOR = /^v?(0|[1-9]\d{0,8})(?:\.(0|[1-9]\d{0,8}))?(?:\.(0|[1-9]\d{0,8}))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseStrictAppVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== "string") return null;
  const m = STRICT_SEMVER.exec(value);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null };
}

export function parseMinimumVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== "string") return null;
  const m = OPERATOR_FLOOR.exec(value.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], prerelease: m[4] ?? null };
}

/**
 * True when `appVersion` (strict) provably satisfies `minVersion` (operator floor). Returns false
 * whenever either side is unknown. Pre-release handling is conservative: a pre-release is below its own release
 * ("2.0.0-dev" < "2.0.0"); two different pre-release tags on the same core are treated as below
 * (no attempt at semver identifier ordering, which could only loosen).
 */
export function appVersionMeetsMinimum(appVersion: string | null | undefined, minVersion: string | null | undefined): boolean {
  const app = parseStrictAppVersion(appVersion);
  const min = parseMinimumVersion(minVersion);
  if (!app || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (app.core[i]! > min.core[i]!) return true;
    if (app.core[i]! < min.core[i]!) return false;
  }
  if (app.prerelease === null) return true; // release >= release, release > pre-release
  if (min.prerelease === null) return false; // pre-release < its release
  return app.prerelease === min.prerelease;
}

export function resolveForceUpdatePolicy(input: {
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
    mode === "emergency" || (mode === "required" && !appVersionMeetsMinimum(input.appVersion, minVersion));
  return {
    force_min_app_version: minVersion,
    force_update_mode: mode,
    force_update_reason: reason,
    force_update_required: forceUpdateRequired,
    policy_source: policySource,
  };
}

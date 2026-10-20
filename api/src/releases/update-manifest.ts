/**
 * Which release a device is offered (master plan Phase 5.3). Pure logic, no I/O: routes/updates.ts
 * loads the inputs, this decides, and api/scripts/update-manifest.integration.mjs exercises both.
 *
 * Rules:
 * - Rings: internal < pilot < stable. A release published to a ring is visible to that ring and to
 *   every inner ring (a stable release reaches pilot and internal devices too).
 * - Staged rollout: `rollout_percent` applies to the release's widest ring only (inner rings got it
 *   in full earlier). A device is in when its stable bucket (0..99, from release + tenant + machine)
 *   is below the percentage, so raising the percentage only adds devices.
 * - Recall: a recalled release (catalog recall, or the cohort recall of Phase 4.2 naming its version)
 *   is never offered. A device running a recalled version with nothing newer to go to is offered
 *   its rollback target (kind "rollback", below); none = nothing (it stays, the operator must
 *   publish a fixed release).
 * - Rollback target: the newest release BELOW the device's version that the device may have: its
 *   ring sees it (same rank rule as upgrades; the rollout percentage does not apply, the device
 *   already ran a later version), it is not withdrawn (catalog or cohort recall), and it passes
 *   the force-update policy as the device's next version (`rollbackAllowed`: resolveForceUpdatePolicy
 *   with the target as app_version; under "emergency" nothing passes). The desktop accepts any
 *   version the server offers, so these checks are the only gate against going back below a floor
 *   or to a build of another ring.
 * - Explicit rollback (header X-Maintafox-Rollback-To, a desktop whose migration failed after an
 *   update): allowed only when it names exactly the rollback target, also while paused; anything
 *   else is refused ("rollback_not_allowed", 409 in the route), never replaced by another version.
 * - Pause (cohort governance, Phase 4.2): nothing is offered, except the explicit rollback above.
 * - Floor: when the tenant/cohort force-update policy requires this device to update, the offer is
 *   mandatory and ignores the rollout percentage (channel, pause and recall still apply). Whether
 *   the policy requires it is NOT decided here: routes/updates.ts asks app/force-update.ts
 *   (resolveForceUpdatePolicy, the R4-S2 strict check used by activation and policy refresh) with
 *   the URL's current version as app_version, and passes the answer in as `forcedUpdate`.
 *   compareVersions below only orders releases against each other and against the device.
 */
import { createHash } from "node:crypto";

import type { resolveForceUpdatePolicy } from "../app/force-update.js";

export const UPDATE_CHANNELS = ["internal", "pilot", "stable"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/** Position of a ring: a release of rank r is visible to devices of rank <= r. */
export function channelRank(channel: UpdateChannel): number {
  return UPDATE_CHANNELS.indexOf(channel);
}

// ── Semantic versions (SemVer 2.0 precedence, build metadata ignored) ─────────────────────────

type ParsedVersion = { core: [number, number, number]; pre: string[] };

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Release versions registered in the catalog: plain x.y.z. */
export const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(value: string): ParsedVersion | null {
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Negative when a < b, 0 when equal, positive when a > b. Both must be valid (see parseVersion). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  // A pre-release sorts before its release (1.0.0-dev < 1.0.0).
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Stable bucket 0..99 of one device for one release. */
export function rolloutBucket(releaseId: string, tenantId: string, machineFingerprint: string): number {
  const digest = createHash("sha256").update(`${releaseId}:${tenantId}:${machineFingerprint}`).digest();
  return digest.readUInt32BE(0) % 100;
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────

export type UpdateCandidate = {
  release_id: string;
  version: string;
  channel: UpdateChannel;
  rollout_percent: number;
  recalled: boolean;
};

export type DeviceUpdateContext = {
  tenantId: string;
  machineFingerprint: string;
  currentVersion: string;
  channel: UpdateChannel;
  governance: { state: "active" | "paused" | "recalled"; recalled_version: string | null };
  /**
   * Why the force-update policy requires this device to update (see forcedUpdateReason), or null
   * when it does not.
   */
  forcedUpdate: ForcedUpdateReason | null;
  /** A rollback to this version was requested (failed migration after an update). */
  rollbackTo: string | null;
  /**
   * True when the force-update policy lets a PC run `version` (resolveForceUpdatePolicy with it as
   * app_version does not require an update). Rollback targets must pass it.
   */
  rollbackAllowed: (version: string) => boolean;
};

export type ForcedUpdateReason = "forced_update_floor" | "emergency";
/** `maintafox.mandatory_reason` in the manifest (null when the offer is optional). */
export type MandatoryReason = ForcedUpdateReason | "rollback_requested" | "recalled_version";

/**
 * Maps the shared force-update decision onto the manifest's reason codes. The only input is
 * resolveForceUpdatePolicy's own answer, so the manifest's mandatory flag is true exactly when
 * policy refresh reports force_update_required for the same tenant and version.
 */
export function forcedUpdateReason(policy: ReturnType<typeof resolveForceUpdatePolicy>): ForcedUpdateReason | null {
  if (!policy.force_update_required) return null;
  return policy.force_update_mode === "emergency" ? "emergency" : "forced_update_floor";
}

export type UpdateDecision =
  | { offer: false; reason: "paused" | "up_to_date" }
  | { offer: false; reason: "rollback_not_allowed"; allowedVersion: string | null }
  | {
      offer: true;
      kind: "upgrade" | "rollback";
      mandatory: boolean;
      mandatoryReason: MandatoryReason | null;
      release: UpdateCandidate;
    };

export function resolveUpdate(candidates: readonly UpdateCandidate[], device: DeviceUpdateContext): UpdateDecision {
  const withdrawn = (c: UpdateCandidate) =>
    c.recalled || (device.governance.state === "recalled" && device.governance.recalled_version === c.version);
  const deviceRank = channelRank(device.channel);
  const visible = (c: UpdateCandidate) => !withdrawn(c) && channelRank(c.channel) >= deviceRank;

  // The only release a device may go back to (see the header comment).
  const rollbackTarget =
    candidates
      .filter((c) => visible(c) && compareVersions(c.version, device.currentVersion) < 0 && device.rollbackAllowed(c.version))
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;

  if (device.rollbackTo !== null) {
    if (!rollbackTarget || rollbackTarget.version !== device.rollbackTo) {
      return { offer: false, reason: "rollback_not_allowed", allowedVersion: rollbackTarget?.version ?? null };
    }
    return { offer: true, kind: "rollback", mandatory: true, mandatoryReason: "rollback_requested", release: rollbackTarget };
  }
  if (device.governance.state === "paused") return { offer: false, reason: "paused" };

  const eligible = candidates.filter((c) => {
    if (!visible(c)) return false;
    if (channelRank(c.channel) > deviceRank || device.forcedUpdate !== null) return true;
    return rolloutBucket(c.release_id, device.tenantId, device.machineFingerprint) < c.rollout_percent;
  });
  const newest = [...eligible].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (newest && compareVersions(newest.version, device.currentVersion) > 0) {
    return {
      offer: true,
      kind: "upgrade",
      mandatory: device.forcedUpdate !== null,
      mandatoryReason: device.forcedUpdate,
      release: newest,
    };
  }
  const runningWithdrawn = candidates.some((c) => c.version === device.currentVersion && withdrawn(c));
  if (runningWithdrawn && rollbackTarget) {
    return { offer: true, kind: "rollback", mandatory: true, mandatoryReason: "recalled_version", release: rollbackTarget };
  }
  return { offer: false, reason: "up_to_date" };
}

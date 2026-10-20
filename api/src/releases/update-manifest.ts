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
 *   is never offered. A device running a recalled version is offered the best other release it is
 *   eligible for, even an older one (kind "rollback"): the previous signed artifact.
 * - Pause (cohort governance, Phase 4.2): nothing is offered, except an explicit rollback request
 *   (a desktop whose migration failed after an update asks for the version it came from).
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
  | { offer: false; reason: "paused" | "up_to_date" | "rollback_unavailable" }
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

  if (device.rollbackTo !== null) {
    const target = candidates.find((c) => c.version === device.rollbackTo && !withdrawn(c));
    if (!target || compareVersions(target.version, device.currentVersion) >= 0) {
      return { offer: false, reason: "rollback_unavailable" };
    }
    return { offer: true, kind: "rollback", mandatory: true, mandatoryReason: "rollback_requested", release: target };
  }
  if (device.governance.state === "paused") return { offer: false, reason: "paused" };

  const deviceRank = channelRank(device.channel);
  const eligible = candidates.filter((c) => {
    if (withdrawn(c)) return false;
    const rank = channelRank(c.channel);
    if (rank < deviceRank) return false;
    if (rank > deviceRank || device.forcedUpdate !== null) return true;
    return rolloutBucket(c.release_id, device.tenantId, device.machineFingerprint) < c.rollout_percent;
  });
  const byVersionDesc = [...eligible].sort((a, b) => compareVersions(b.version, a.version));

  const newest = byVersionDesc[0];
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
  if (runningWithdrawn) {
    const previous = byVersionDesc.find((c) => compareVersions(c.version, device.currentVersion) < 0);
    if (previous) {
      return { offer: true, kind: "rollback", mandatory: true, mandatoryReason: "recalled_version", release: previous };
    }
  }
  return { offer: false, reason: "up_to_date" };
}

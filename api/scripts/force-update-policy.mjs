/**
 * Forced-update resolver (no server, no database): the "required" floor is satisfied only by a
 * provably newer-or-equal strict app version; anything missing or unparsable stays blocked.
 */
import assert from "node:assert/strict";

import { appVersionMeetsMinimum, parseStrictAppVersion, resolveForceUpdatePolicy } from "../dist/app/force-update.js";
import { compareVersions, forcedUpdateReason, parseVersion, resolveUpdate } from "../dist/releases/update-manifest.js";

function required(appVersion, { mode = "required", min = "2.0.0", tenantMode = "inherit", tenantMin = null } = {}) {
  return resolveForceUpdatePolicy({
    appVersion,
    tenantMinVersion: tenantMin,
    tenantMode,
    tenantReason: null,
    cohortMinVersion: min,
    cohortMode: mode,
    cohortReason: null,
  }).force_update_required;
}

// Up to date (>= floor) -> not required.
for (const v of ["2.0.0", "2.0.1", "2.1.0", "3.0.0", "10.0.0", "2.0.1-dev"]) {
  assert.equal(required(v), false, `${v} meets 2.0.0`);
}
// Older -> required.
for (const v of ["1.9.9", "0.4.0", "1.99.99", "2.0.0-dev", "2.0.0-rc.1"]) {
  assert.equal(required(v), true, `${v} is below 2.0.0`);
}
// Missing or unparsable -> exactly like missing: required.
for (const v of [undefined, "", " ", "abc", "1.2", "2", "99", "99.0", "2.0.0garbage", "v2.0.0", "02.0.0", "2.0.0+build", "2.0.0.1", " 2.0.0", "2.0.0 ", "9999999999.0.0", "2.0.0-"]) {
  assert.equal(parseStrictAppVersion(v), null, `${JSON.stringify(v)} must not parse`);
  assert.equal(required(v), true, `${JSON.stringify(v)} must be treated as missing`);
}
// Emergency -> always required.
for (const v of [undefined, "abc", "1.0.0", "2.0.0", "99.0.0"]) {
  assert.equal(required(v, { mode: "emergency" }), true, `emergency blocks ${JSON.stringify(v)}`);
}
// Off -> never required.
for (const v of [undefined, "abc", "1.0.0"]) {
  assert.equal(required(v, { mode: "off" }), false, `off never blocks ${JSON.stringify(v)}`);
}
// Required without a floor, or with an unparsable floor -> required (fail closed).
for (const min of [null, "", "abc", "latest"]) {
  assert.equal(required("99.0.0", { min }), true, `floor ${JSON.stringify(min)} blocks everyone`);
}
// Operator floor written loosely keeps its exact meaning.
assert.equal(appVersionMeetsMinimum("2.0.0", "2"), true);
assert.equal(appVersionMeetsMinimum("2.0.0", "v2.0"), true);
assert.equal(appVersionMeetsMinimum("1.9.9", "2.0"), false);
// Pre-release floors: release passes its own pre-release, a different pre-release tag does not.
assert.equal(appVersionMeetsMinimum("2.0.0", "2.0.0-rc.1"), true);
assert.equal(appVersionMeetsMinimum("2.0.0-rc.1", "2.0.0-rc.1"), true);
assert.equal(appVersionMeetsMinimum("2.0.0-rc.2", "2.0.0-rc.1"), false);
// Tenant override wins over the cohort.
assert.equal(required("2.5.0", { tenantMode: "required", tenantMin: "3.0.0" }), true);
assert.equal(required("3.0.0", { tenantMode: "required", tenantMin: "3.0.0", min: "9.0.0" }), false);

// ── Update manifest (routes/updates.ts) uses this same decision ────────────────────────────────
// The manifest's mandatory flag comes from forcedUpdateReason(resolveForceUpdatePolicy(...)) with
// the URL version as app_version, so it is policy refresh's force_update_required by construction.
// Its own compareVersions only orders releases; check it never contradicts the floor check.
{
  const versions = ["0.4.0-dev", "0.9.0", "1.0.0-dev", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0", "1.0.1", "1.10.0", "2.0.0-alpha", "2.0.0-beta", "2.0.0", "10.0.0"];
  const floors = ["1.0.0", "1.0.0-rc.1", "2.0.0", "2.0.0-alpha", "1.10.0", "1.0", "v2"];
  for (const v of versions) {
    // Every version the manifest route accepts can be ordered (compareVersions never throws on it).
    assert.ok(parseStrictAppVersion(v) && parseVersion(v), v);
    for (const mode of ["off", "required", "emergency"]) {
      for (const min of [...floors, null]) {
        const policy = resolveForceUpdatePolicy({
          appVersion: v, tenantMinVersion: null, tenantMode: "inherit", tenantReason: null,
          cohortMinVersion: min, cohortMode: mode, cohortReason: null,
        });
        const reason = forcedUpdateReason(policy);
        assert.equal(reason !== null, policy.force_update_required, `${v} ${mode} ${min}`);
        if (reason !== null) assert.equal(reason, mode === "emergency" ? "emergency" : "forced_update_floor");
        // A newer release is always offered as mandatory exactly when the policy requires it.
        const decision = resolveUpdate(
          [{ release_id: "rel_new", version: "99.0.0", channel: "stable", rollout_percent: 0, recalled: false }],
          {
            tenantId: "t", machineFingerprint: "fp", currentVersion: v, channel: "stable",
            governance: { state: "active", recalled_version: null }, forcedUpdate: reason, rollbackTo: null,
            rollbackAllowed: () => true,
          },
        );
        if (policy.force_update_required) {
          assert.equal(decision.offer && decision.mandatory, true, `${v} ${mode} ${min}: mandatory offer`);
          assert.equal(decision.mandatoryReason, reason);
        } else {
          assert.equal(decision.offer, false, `${v} ${mode} ${min}: 0 % rollout, nothing forced`);
        }
      }
    }
    // Ordering vs floor: "meets" implies not below in SemVer order; "below" implies below in SemVer
    // order, except two different pre-release tags of the same core, which the strict check
    // treats as below on purpose (conservative). Catalog releases are plain x.y.z, so any release
    // newer than such a PC also meets that floor.
    for (const f of versions) {
      const meets = appVersionMeetsMinimum(v, f);
      const cmp = compareVersions(v, f);
      const pv = parseStrictAppVersion(v);
      const pf = parseStrictAppVersion(f);
      const sameCoreTwoTags = pv.core.join(".") === pf.core.join(".") && pv.prerelease && pf.prerelease && pv.prerelease !== pf.prerelease;
      if (meets) assert.ok(cmp >= 0, `${v} meets ${f} but sorts below it`);
      else if (!sameCoreTwoTags) assert.ok(cmp < 0, `${v} is below ${f} for the floor check but not in release order`);
    }
  }
}

console.log("force-update-policy: ok");

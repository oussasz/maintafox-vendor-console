/**
 * Forced-update resolver (no server, no database): the "required" floor is satisfied only by a
 * provably newer-or-equal strict app version; anything missing or unparsable stays blocked.
 */
import assert from "node:assert/strict";

import { appVersionMeetsMinimum, parseStrictAppVersion, resolveForceUpdatePolicy } from "../dist/app/force-update.js";

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

console.log("force-update-policy: ok");

/**
 * Console operators and roles (master plan Phase 4.3) against a real Postgres and the real API:
 * every console route has a permission (fail closed), each role gets exactly its permissions on the
 * server, operator create / change / disable / delete / MFA reset need a vendor_user_admin step-up
 * and are audited, nobody can lock themselves out, new operators need their one-time enrolment code,
 * and an operator can change their own password.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator, postAuth } from "./lib/vendor-session.mjs";

const { ROUTE_PERMISSIONS, ROLE_PERMISSIONS } = await import("../dist/vendor-auth/roles.js");

// ── Every route an operator token can reach is in the permission table (and nothing else is) ──
const routesDir = join(process.cwd(), "src", "routes");
const operatorRoutes = new Set();
for (const file of readdirSync(routesDir)) {
  const source = readFileSync(join(routesDir, file), "utf8");
  for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)",\s*(authMiddleware|metricsAuth)\b/g)) {
    operatorRoutes.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
}
assert.ok(operatorRoutes.size > 50, `route scan found ${operatorRoutes.size} routes (scanner out of date?)`);
const unmapped = [...operatorRoutes].filter((r) => !(r in ROUTE_PERMISSIONS));
assert.deepEqual(unmapped, [], "every console route has a permission");
const stale = Object.keys(ROUTE_PERMISSIONS).filter((r) => !operatorRoutes.has(r));
assert.deepEqual(stale, [], "the permission table lists no route that does not exist");

const api = await startControlApi({ port: 33221 });
try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;
  const admin = (session, kind, reason = "operators test") =>
    session.stepUp(kind).then((token) => ({ "X-Operator-Reason": reason, "X-Step-Up-Token": token }));

  assert.equal((await api.su("SELECT role FROM users WHERE lower(email) = lower($1)", [TEST_ADMIN_EMAIL]))[0].role, "owner");
  const ownerPerms = (await api.call("GET", "/api/v1/me/permissions", owner.accessToken)).json.map((p) => p.name);
  assert.deepEqual(ownerPerms.sort(), [...ROLE_PERMISSIONS.owner].sort());

  // ── Create operators (step-up vendor_user_admin, one-time enrolment code) ───────────────
  const createBody = (role) => ({
    email: `${role}@maintafox.systems`,
    display_name: `The ${role}`,
    role,
    initial_password: `Initial-${role}-pass-1`,
  });
  assert.equal((await api.call("POST", "/api/v1/operators", owner.accessToken, createBody("auditor"), { "X-Operator-Reason": "new hire" })).status, 403);
  const wrongKind = await api.call("POST", "/api/v1/operators", owner.accessToken, createBody("auditor"), await admin(owner, "rollout_publish"));
  assert.equal(wrongKind.json.reason, "step_up_action_kind_mismatch");
  const weak = await api.call("POST", "/api/v1/operators", owner.accessToken, { ...createBody("auditor"), initial_password: "short" }, await admin(owner, "vendor_user_admin"));
  assert.equal(weak.status, 400);
  const created = {};
  for (const role of ["auditor", "support", "operations"]) {
    const res = await api.call("POST", "/api/v1/operators", owner.accessToken, createBody(role), await admin(owner, "vendor_user_admin", `hire ${role}`));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.operator.role, role);
    assert.equal(res.json.operator.mfa_enrolled, false);
    assert.match(res.json.enrolment_code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
    created[role] = res.json;
  }
  assert.equal((await api.call("POST", "/api/v1/operators", owner.accessToken, createBody("auditor"), await admin(owner, "vendor_user_admin"))).status, 409);
  const stored = JSON.stringify(await api.su("SELECT * FROM idempotency_keys"));
  assert.ok(!stored.includes(created.auditor.enrolment_code), "one-time codes are never stored in clear");
  assert.equal(await audited("operator_create"), 3);

  // The password alone does not enrol a new operator.
  await assert.rejects(loginOperator(api.baseUrl, "auditor@maintafox.systems", "Initial-auditor-pass-1"), /enrolment/);
  const sessions = {};
  for (const role of ["auditor", "support", "operations"]) {
    sessions[role] = await loginOperator(api.baseUrl, `${role}@maintafox.systems`, `Initial-${role}-pass-1`, {
      enrolmentCode: created[role].enrolment_code,
    });
  }

  // ── Least privilege, enforced by the server ────────────────────────────────────────────
  for (const role of ["auditor", "support", "operations"]) {
    const perms = (await api.call("GET", "/api/v1/me/permissions", sessions[role].accessToken)).json.map((p) => p.name);
    assert.deepEqual(perms.sort(), [...ROLE_PERMISSIONS[role]].sort(), `${role} permissions`);
  }
  const status = async (role, method, path, body) => (await api.call(method, path, sessions[role].accessToken, body)).status;
  assert.equal(await status("auditor", "GET", "/api/v1/tenants"), 200);
  assert.equal(await status("auditor", "GET", "/api/v1/audit/ledger"), 200);
  const denied = await api.call("POST", "/api/v1/tenants", sessions.auditor.accessToken, { slug: "nope", display_name: "Nope" });
  assert.deepEqual([denied.status, denied.json], [403, { error: "permission_denied", required_permission: "customer.manage" }]);
  assert.equal(await status("auditor", "GET", "/api/v1/ops/sync-overview"), 403);
  assert.equal(await status("auditor", "GET", "/api/v1/operators"), 403);
  assert.equal(await status("support", "GET", "/api/v1/ops/sync-overview"), 200);
  assert.equal(await status("support", "GET", "/api/v1/support/diagnostic-bundles"), 200);
  assert.equal(await status("support", "POST", "/api/v1/licenses", { tenant_id: "x", max_machines: 1 }), 403);
  // Removing a forced-update floor needs rollout.manage (support and auditor do not have it).
  for (const role of ["auditor", "support"]) {
    for (const path of ["/api/v1/tenants/x/update-policy/clear-min-version", "/api/v1/cohorts/stable/stable-main/update-policy/clear-min-version"]) {
      const res = await api.call("POST", path, sessions[role].accessToken, { expected_force_min_app_version: "2.0.0" });
      assert.deepEqual([res.status, res.json], [403, { error: "permission_denied", required_permission: "rollout.manage" }], `${role} ${path}`);
    }
  }
  assert.equal(await status("operations", "POST", "/api/v1/tenants", { slug: "ops-made", display_name: "Ops made" }), 201);
  assert.equal(await status("operations", "GET", "/api/v1/operators"), 403);
  assert.equal(await status("operations", "POST", "/api/v1/operators", createBody("auditor")), 403);

  // ── Nobody locks themselves out ───────────────────────────────────────────────────────
  const ownerId = (await api.call("GET", "/api/v1/auth/session", owner.accessToken)).json.user.id;
  for (const body of [{ role: "auditor" }, { is_active: false }]) {
    const self = await api.call("PATCH", `/api/v1/operators/${ownerId}`, owner.accessToken, body, await admin(owner, "vendor_user_admin"));
    assert.deepEqual([self.status, self.json.error], [409, "cannot_change_own_access"]);
  }
  assert.equal((await api.call("DELETE", `/api/v1/operators/${ownerId}`, owner.accessToken, undefined, await admin(owner, "vendor_user_admin"))).status, 409);
  assert.equal((await api.call("POST", `/api/v1/operators/${ownerId}/mfa-reset`, owner.accessToken, undefined, await admin(owner, "vendor_user_admin"))).status, 409);
  const renamed = await api.call("PATCH", `/api/v1/operators/${ownerId}`, owner.accessToken, { display_name: "The owner" }, await admin(owner, "vendor_user_admin"));
  assert.equal(renamed.status, 200, "an owner may rename themselves");

  // ── Role change, disable, MFA reset, delete ───────────────────────────────────────────
  const supportId = created.support.operator.id;
  const promoted = await api.call("PATCH", `/api/v1/operators/${supportId}`, owner.accessToken, { role: "operations" }, await admin(owner, "vendor_user_admin", "promotion"));
  assert.equal(promoted.status, 200, promoted.text);
  assert.equal(await status("support", "POST", "/api/v1/tenants", { slug: "support-made", display_name: "Support made" }), 201, "a new role applies at once");
  const disabled = await api.call("PATCH", `/api/v1/operators/${supportId}`, owner.accessToken, { is_active: false }, await admin(owner, "vendor_user_admin", "left the company"));
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.sessions_ended, 1);
  assert.equal(await status("support", "GET", "/api/v1/tenants"), 401, "a disabled operator's session ends at once");
  const disabledLogin = await postAuth(api.baseUrl, "/api/v1/auth/login", { body: { email: "support@maintafox.systems", password: "Initial-support-pass-1" } });
  assert.deepEqual([disabledLogin.status, disabledLogin.json], [401, { error: "invalid_credentials" }], "disabled looks like a wrong password");

  const auditorId = created.auditor.operator.id;
  const reset = await api.call("POST", `/api/v1/operators/${auditorId}/mfa-reset`, owner.accessToken, undefined, await admin(owner, "vendor_user_admin", "lost phone"));
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.sessions_ended, 1);
  assert.equal(await status("auditor", "GET", "/api/v1/tenants"), 401);
  const reEnrolled = await loginOperator(api.baseUrl, "auditor@maintafox.systems", "Initial-auditor-pass-1", { enrolmentCode: reset.json.reset_code });
  assert.equal((await api.call("GET", "/api/v1/tenants", reEnrolled.accessToken)).status, 200);

  const operationsId = created.operations.operator.id;
  const deleted = await api.call("DELETE", `/api/v1/operators/${operationsId}`, owner.accessToken, undefined, await admin(owner, "vendor_user_admin", "contract ended"));
  assert.equal(deleted.status, 200);
  assert.equal(await status("operations", "GET", "/api/v1/tenants"), 401, "a deleted operator's session ends");
  const list = (await api.call("GET", "/api/v1/operators", owner.accessToken)).json;
  assert.deepEqual(list.map((o) => o.email).sort(), ["admin@maintafox.systems", "auditor@maintafox.systems", "support@maintafox.systems"]);
  for (const code of ["operator_update", "operator_delete", "mfa_reset"]) assert.ok((await audited(code)) >= 1, `${code} audited`);

  // ── Own password ───────────────────────────────────────────────────────────────────────
  const second = await loginOperator(api.baseUrl, "auditor@maintafox.systems", "Initial-auditor-pass-1");
  const badCurrent = await api.call("POST", "/api/v1/auth/password", reEnrolled.accessToken, { current_password: "wrong-one", new_password: "Brand-new-password-2" });
  assert.equal(badCurrent.status, 401);
  const changed = await api.call("POST", "/api/v1/auth/password", reEnrolled.accessToken, {
    current_password: "Initial-auditor-pass-1",
    new_password: "Brand-new-password-2",
  });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.json.other_sessions_ended, 1);
  assert.equal((await api.call("GET", "/api/v1/tenants", second.accessToken)).status, 401, "other sessions end");
  assert.equal((await api.call("GET", "/api/v1/tenants", reEnrolled.accessToken)).status, 200, "this session continues");
  assert.equal((await postAuth(api.baseUrl, "/api/v1/auth/login", { body: { email: "auditor@maintafox.systems", password: "Initial-auditor-pass-1" } })).status, 401);
  assert.equal(await audited("password_changed"), 1);

  console.log("operators and roles (4.3): all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

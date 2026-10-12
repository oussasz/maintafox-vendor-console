/**
 * Vendor-console actions of master plan Phase 4.2 against a real Postgres and the real API: slot
 * release, rebind, policy refresh, soft suspend / resume, rollout pause / resume / recall. Each
 * one has a real effect a device sees, needs the right step-up kind where dangerous, and leaves an
 * audit row.
 */
import assert from "node:assert/strict";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const api = await startControlApi({ port: 33211 });

try {
  const session = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const admin = session.accessToken;
  const privileged = async (kind, reason = "integration check") => ({
    "X-Operator-Reason": reason,
    "X-Step-Up-Token": await session.stepUp(kind),
  });
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;

  const tenant = (await api.call("POST", "/api/v1/tenants", admin, { slug: "actions", display_name: "Actions", rollout_cohort: "stable-main", update_channel: "stable" })).json;
  const licence = (await api.call("POST", "/api/v1/licenses", admin, { tenant_id: tenant.id, max_machines: 1 })).json;
  const claim = (fp) =>
    api.call("POST", "/api/v1/activation/claim", null, { license_key: licence.license_key, machine_fingerprint: fp, app_version: "1.0.0" });
  const sync = (token) => api.call("POST", "/api/v1/sync/exchange", token, {});
  const refresh = (token) => api.call("POST", "/api/v1/activation/policy-refresh", token, {});
  const machine = (fp, action, body, headers) =>
    api.call("POST", `/api/v1/tenants/${tenant.id}/machines/${encodeURIComponent(fp)}/${action}`, admin, body, headers);
  const activations = async () => (await api.call("GET", `/api/v1/tenants/${tenant.id}/activations`, admin)).json;

  // ── Policy refresh ──────────────────────────────────────────────────────────────────────
  const fpA = "fp-actions-device-a";
  const claimA = await claim(fpA);
  assert.equal(claimA.status, 200, claimA.text);
  assert.equal(claimA.json.rollout_governance, "active", "devices receive the rollout governance");
  assert.equal(claimA.json.rollout_recalled_version, null);
  let tokenA = claimA.json.activation_token;
  assert.notEqual((await sync(tokenA)).status, 401, "sync accepted before any refresh request");
  assert.equal((await machine(fpA, "policy-refresh", {}, {})).status, 400, "a reason is required");
  const asked = await machine(fpA, "policy-refresh", {}, { "X-Operator-Reason": "edition changed" });
  assert.equal(asked.status, 200, asked.text);
  assert.ok((await activations()).find((r) => r.machine_id === fpA).policy_refresh_requested_at, "pending refresh shown");
  const refused = await sync(tokenA);
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error, "policy_refresh_required", "the desktop's sync stops and it re-checks its licence");
  assert.equal((await api.call("GET", "/api/v1/activation/tenant-status", tokenA)).status, 200, "other device routes still work");
  const renewed = await refresh(tokenA);
  assert.equal(renewed.status, 200, renewed.text);
  assert.notEqual(renewed.json.activation_token, tokenA, "the refresh renews the token (the desktop resumes on a new token)");
  assert.equal((await sync(tokenA)).status, 401, "the old token is superseded");
  tokenA = renewed.json.activation_token;
  assert.notEqual((await sync(tokenA)).status, 401, "sync resumes with the new token");
  assert.equal((await activations()).find((r) => r.machine_id === fpA).policy_refresh_requested_at, null);
  assert.equal(await audited("machine_policy_refresh_requested"), 1);

  // ── Rebind: the slot moves to the replacement even though the licence is full ─────────────
  const fpB = "fp-actions-device-b";
  assert.equal((await claim(fpB)).status, 409, "licence full (1 slot)");
  const noStepUp = await machine(fpA, "rebind", { new_machine_fingerprint: fpB }, { "X-Operator-Reason": "laptop replaced" });
  assert.equal(noStepUp.status, 403, "rebind needs a step-up");
  const wrongKind = await machine(fpA, "rebind", { new_machine_fingerprint: fpB }, await privileged("rollout_publish"));
  assert.equal(wrongKind.json.reason, "step_up_action_kind_mismatch");
  const rebound = await machine(fpA, "rebind", { new_machine_fingerprint: fpB }, await privileged("machine_trust_change", "laptop replaced"));
  assert.equal(rebound.status, 200, rebound.text);
  assert.equal((await refresh(tokenA)).status, 403, "the old machine is refused at once");
  const claimB = await claim(fpB);
  assert.equal(claimB.status, 200, `the replacement finds its slot: ${claimB.text}`);
  assert.equal(claimB.json.activated_device_count, 1);
  const tokenB = claimB.json.activation_token;
  assert.equal(await audited("machine_rebind"), 1);

  // ── Slot release: device refused, slot free, it may activate again ──────────────────────
  const released = await machine(fpB, "release", { reason: "machine scrapped" }, await privileged("machine_trust_change", "scrapped"));
  assert.equal(released.status, 200, released.text);
  assert.equal(released.json.active_slots, 0);
  assert.equal((await refresh(tokenB)).json.error, "activation_revoked");
  assert.equal((await activations()).find((r) => r.machine_id === fpB).revocation_kind, "released");
  assert.equal((await machine(fpB, "release", {}, await privileged("machine_trust_change"))).status, 409, "nothing to release twice");
  const fpC = "fp-actions-device-c";
  const claimC = await claim(fpC);
  assert.equal(claimC.status, 200, "the freed slot is usable");
  const tokenC = claimC.json.activation_token;
  assert.equal(await audited("machine_slot_release"), 1);
  // A released machine may come back (unlike an operator revocation) once a slot is free.
  assert.equal((await machine(fpC, "release", {}, await privileged("machine_trust_change"))).status, 200);
  assert.equal((await claim(fpB)).status, 200, "a released device can activate again");

  // ── Soft suspend / resume ────────────────────────────────────────────────────────────────
  const tokenB2 = (await api.su("SELECT activation_token FROM machine_activations WHERE machine_fingerprint = $1", [fpB]))[0].activation_token;
  const suspendWrongKind = await api.call("POST", `/api/v1/tenants/${tenant.id}/suspend`, admin, { reason: "unpaid invoice" }, await privileged("tenant_restore"));
  assert.equal(suspendWrongKind.json.reason, "step_up_action_kind_mismatch");
  const suspended = await api.call(
    "POST",
    `/api/v1/tenants/${tenant.id}/suspend`,
    admin,
    { reason: "unpaid invoice" },
    await privileged("entitlement_suspension", "unpaid invoice"),
  );
  assert.equal(suspended.status, 200, suspended.text);
  assert.equal((await sync(tokenB2)).json.error, "tenant_inactive", "devices are refused while suspended");
  assert.equal((await refresh(tokenB2)).json.error, "tenant_inactive");
  const listedTenant = (await api.call("GET", "/api/v1/tenants", admin)).json.find((t) => t.id === tenant.id);
  assert.equal(listedTenant.suspended_reason, "unpaid invoice");
  assert.equal(
    (await api.call("POST", `/api/v1/tenants/${tenant.id}/suspend`, admin, { reason: "again" }, await privileged("entitlement_suspension"))).status,
    409,
  );
  const resumed = await api.call("POST", `/api/v1/tenants/${tenant.id}/resume`, admin, { reason: "paid" }, await privileged("tenant_restore", "paid"));
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.json.devices_asked_to_refresh, 1);
  const afterResume = await refresh(tokenB2);
  assert.equal(afterResume.status, 200, afterResume.text);
  assert.notEqual(afterResume.json.activation_token, tokenB2, "a blocked desktop gets a new token and resumes syncing");
  assert.notEqual((await sync(afterResume.json.activation_token)).status, 401);
  assert.equal(await audited("tenant_suspend"), 1);
  assert.equal(await audited("tenant_resume"), 1);
  assert.equal((await refresh(tokenC)).json.error, "activation_revoked", "released device C stays released");

  // ── Rollout pause / resume / recall ──────────────────────────────────────────────────────
  const cohortPath = "/api/v1/rollouts/stable/stable-main";
  assert.equal((await api.call("POST", "/api/v1/rollouts/beta/x/pause", admin, { reason: "nope" }, await privileged("rollout_publish"))).status, 400);
  const pausedRes = await api.call("POST", `${cohortPath}/pause`, admin, { reason: "crash reports on 2.1" }, await privileged("rollout_publish", "crash reports"));
  assert.equal(pausedRes.status, 200, pausedRes.text);
  const stage = (await api.call("GET", "/api/v1/ops/rollout-overview", admin)).json.cohort_stages.find((c) => c.cohort_label === "stable-main");
  assert.equal(stage.governance, "paused");
  assert.equal(stage.governance_reason, "crash reports on 2.1");
  assert.ok(stage.paused_at_rfc3339);
  const pausedPolicy = await refresh(afterResume.json.activation_token);
  assert.equal(pausedPolicy.json.rollout_governance, "paused", "devices of the cohort receive the pause");
  assert.equal((await api.call("POST", `${cohortPath}/pause`, admin, { reason: "again" }, await privileged("rollout_publish"))).status, 409);
  const recallWrongKind = await api.call("POST", `${cohortPath}/recall`, admin, { reason: "bad build", recalled_version: "2.1.0" }, await privileged("rollout_publish"));
  assert.equal(recallWrongKind.json.reason, "step_up_action_kind_mismatch", "recall needs forced_rollback");
  const recalled = await api.call("POST", `${cohortPath}/recall`, admin, { reason: "bad build", recalled_version: "2.1.0" }, await privileged("forced_rollback", "bad build"));
  assert.equal(recalled.status, 200, recalled.text);
  const recalledPolicy = await refresh(pausedPolicy.json.activation_token);
  assert.equal(recalledPolicy.json.rollout_governance, "recalled");
  assert.equal(recalledPolicy.json.rollout_recalled_version, "2.1.0");
  const resumedRollout = await api.call("POST", `${cohortPath}/resume`, admin, { reason: "fixed in 2.1.1" }, await privileged("rollout_publish"));
  assert.equal(resumedRollout.status, 200);
  assert.equal((await refresh(recalledPolicy.json.activation_token)).json.rollout_governance, "active");
  for (const code of ["rollout_pause", "rollout_recall", "rollout_resume"]) {
    assert.equal(await audited(code), 1, `${code} audited`);
  }

  console.log("console actions (4.2): all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

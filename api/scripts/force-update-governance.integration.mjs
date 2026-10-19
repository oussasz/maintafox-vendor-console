import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { loginOperator } from "./lib/vendor-session.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";

const port = 33117;
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await delay(200);
  }
  throw new Error("control API did not become healthy in time");
}

async function run() {
  const testPg = await startTestPostgres();
  const databaseUrl = await testPg.createDatabase();
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      ...TEST_SYNC_ENV,
      JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
      SEED_ADMIN_PASSWORD: "AdminPassw0rd!",
      SEED_ADMIN_EMAIL: "admin@maintafox.systems",
      ...TEST_ENTITLEMENT_SIGNING_ENV,
      SEED_BEHAVIOR: "safe",
      NODE_ENV: "production",
      REQUIRE_PRIVILEGED_REASON: "1",
      REQUIRE_PRIVILEGED_STEP_UP: "1",
      CORS_ORIGIN: "http://localhost:5174",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (buf) => {
    serverOutput += String(buf);
  });
  server.stderr.on("data", (buf) => {
    serverOutput += String(buf);
  });

  try {
    await waitForHealth();

    const session = await loginOperator(baseUrl, "admin@maintafox.systems", "AdminPassw0rd!");
    const token = session.accessToken;

    // Setting a policy is step-up kind rollout_publish; rolling one back is forced_rollback.
    const privilegedHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Operator-Reason": "INC-2026-042 force-update drill",
      "X-Step-Up-Token": await session.stepUp("rollout_publish"),
    };
    const rollbackHeaders = { ...privilegedHeaders, "X-Step-Up-Token": await session.stepUp("forced_rollback") };

    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "tenant-governance",
        display_name: "Tenant Governance",
        rollout_cohort: "stable-main",
        update_channel: "stable",
      }),
    });
    assert.equal(tenantRes.status, 201, "tenant create must succeed");
    const tenant = await tenantRes.json();

    const cohortSetRes = await fetch(`${baseUrl}/api/v1/cohorts/stable/stable-main/update-policy`, {
      method: "PUT",
      headers: privilegedHeaders,
      body: JSON.stringify({
        force_min_app_version: "2.0.0",
        force_update_mode: "required",
        force_update_reason: "Rollout floor raised to 2.0.0",
      }),
    });
    assert.equal(cohortSetRes.status, 200, "cohort policy set must succeed");

    const licenseRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: tenant.id, max_machines: 2 }),
    });
    assert.equal(licenseRes.status, 201, "license issue must succeed");
    const license = await licenseRes.json();

    const lowVersionClaimRes = await fetch(`${baseUrl}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: license.license_key,
        machine_fingerprint: "machine-force-1",
        app_version: "1.9.9",
      }),
    });
    assert.equal(lowVersionClaimRes.status, 200, "claim must succeed for policy evaluation");
    const lowVersionClaim = await lowVersionClaimRes.json();
    assert.equal(lowVersionClaim.force_update_required, true, "cohort min version must enforce update");
    assert.equal(lowVersionClaim.force_update_mode, "required");
    assert.equal(lowVersionClaim.force_update_policy_source, "cohort");

    // Preview / claim: an unparsable version must never pass the floor (the old lenient compare
    // read "99" as 99.0.0 and "2.0.0garbage" as 2.0.0).
    async function previewRequired(appVersion) {
      const res = await fetch(`${baseUrl}/api/v1/activation/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: license.license_key,
          machine_fingerprint: "machine-force-1",
          ...(appVersion === undefined ? {} : { app_version: appVersion }),
        }),
      });
      assert.equal(res.status, 200, `preview with ${JSON.stringify(appVersion)} must succeed`);
      return (await res.json()).force_update_required;
    }
    assert.equal(await previewRequired("2.0.1"), false, "preview: up-to-date version passes the floor");
    assert.equal(await previewRequired("1.9.9"), true, "preview: old version is blocked");
    assert.equal(await previewRequired(undefined), true, "preview: missing version is blocked");
    for (const bogus of ["99", "abc", "", "1.2", "2.0.0garbage", "v9.0.0"]) {
      assert.equal(await previewRequired(bogus), true, `preview: invalid version ${JSON.stringify(bogus)} is blocked`);
    }

    // Policy refresh (review R4-S2): the desktop reports its running version in the body, so an
    // up-to-date PC is no longer held behind the "required" floor until the operator turns it off.
    let deviceToken = lowVersionClaim.activation_token;
    assert.ok(deviceToken, "claim must return a device token");
    async function policyRefresh(body) {
      const res = await fetch(`${baseUrl}/api/v1/activation/policy-refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const json = await res.json();
      if (res.status === 200) deviceToken = json.activation_token;
      return { status: res.status, json };
    }
    async function refreshRequired(body) {
      const { status, json } = await policyRefresh(body);
      assert.equal(status, 200, `policy-refresh with ${JSON.stringify(body)} must succeed`);
      assert.equal(json.force_update_mode, "required");
      assert.equal(json.force_min_app_version, "2.0.0");
      return json.force_update_required;
    }
    assert.equal(await refreshRequired("{}"), true, "policy-refresh: old desktop body {} keeps today's answer (blocked)");
    assert.equal(await refreshRequired({ app_version: "2.0.0" }), false, "policy-refresh: version == floor is not blocked");
    assert.equal(await refreshRequired({ app_version: "2.3.1" }), false, "policy-refresh: up-to-date PC is not blocked");
    assert.equal(await refreshRequired({ app_version: "1.9.9" }), true, "policy-refresh: old PC is blocked");
    assert.equal(await refreshRequired({ app_version: "2.0.0-dev" }), true, "policy-refresh: pre-release of the floor is blocked");
    for (const bogus of ["", "abc", "1.2", "99", "2.0.0garbage", "v9.0.0", " 9.0.0"]) {
      assert.equal(
        await refreshRequired({ app_version: bogus }),
        true,
        `policy-refresh: invalid version ${JSON.stringify(bogus)} behaves like a missing one`,
      );
    }
    assert.equal(
      await refreshRequired({ app_version: "2.3.1", future_field: { anything: true } }),
      false,
      "policy-refresh: an unknown extra field from a newer desktop is ignored",
    );
    for (const badType of [{ app_version: 200 }, { app_version: null }, { app_version: ["2.3.1"] }, { app_version: "9".repeat(33) }]) {
      const { status, json } = await policyRefresh(badType);
      assert.equal(status, 400, `policy-refresh: ${JSON.stringify(badType).slice(0, 40)} must be rejected`);
      assert.equal(json.error, "invalid_body");
      assert.ok(json.details, "invalid_body carries zod details like the claim route");
    }

    const tenantEmergencyRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/update-policy`, {
      method: "PUT",
      headers: privilegedHeaders,
      body: JSON.stringify({
        force_update_mode: "emergency",
        force_update_reason: "Emergency rollback lock",
      }),
    });
    assert.equal(tenantEmergencyRes.status, 200, "tenant emergency override must succeed");

    const emergencyClaimRes = await fetch(`${baseUrl}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: license.license_key,
        machine_fingerprint: "machine-force-2",
        app_version: "9.9.9",
      }),
    });
    assert.equal(emergencyClaimRes.status, 200);
    const emergencyClaim = await emergencyClaimRes.json();
    assert.equal(emergencyClaim.force_update_required, true, "emergency mode must force update regardless of version");
    assert.equal(emergencyClaim.force_update_mode, "emergency");
    assert.equal(emergencyClaim.force_update_policy_source, "tenant");

    for (const body of ["{}", { app_version: "9.9.9" }, { app_version: "abc" }]) {
      const { status, json } = await policyRefresh(body);
      assert.equal(status, 200);
      assert.equal(json.force_update_mode, "emergency");
      assert.equal(json.force_update_required, true, `policy-refresh: emergency blocks ${JSON.stringify(body)}`);
    }

    const rollbackRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/update-policy/rollback`, {
      method: "POST",
      headers: rollbackHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(rollbackRes.status, 200, "tenant policy rollback must succeed");

    // A device with no body and no Content-Type (route level) still gets its refresh and the old
    // answer under "required" (cohort floor 2.0.0 is back in force after the rollback).
    const bareRefreshRes = await fetch(`${baseUrl}/api/v1/activation/policy-refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(bareRefreshRes.status, 200, "policy-refresh with no body must succeed");
    const bareRefresh = await bareRefreshRes.json();
    deviceToken = bareRefresh.activation_token;
    assert.equal(bareRefresh.force_update_mode, "required");
    assert.equal(bareRefresh.force_update_required, true, "policy-refresh with no body keeps the old answer");

    // The operator's floor is validated when set: a floor the activation check cannot read would
    // block every PC under "required". Loose forms keep working; null clears.
    const tenantPolicyUrl = `${baseUrl}/api/v1/tenants/${tenant.id}/update-policy`;
    const cohortPolicyUrl = `${baseUrl}/api/v1/cohorts/stable/stable-main/update-policy`;
    const readPolicy = async (url) => {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const p = await res.json();
      return { force_min_app_version: p.force_min_app_version, force_update_mode: p.force_update_mode };
    };
    const putPolicy = (url, body) =>
      fetch(url, { method: "PUT", headers: privilegedHeaders, body: JSON.stringify(body) });
    for (const url of [tenantPolicyUrl, cohortPolicyUrl]) {
      const before = await readPolicy(url);
      for (const bad of ["latest", "2.x", "2.0.0.1", "abc", "2.0.0garbage"]) {
        const res = await putPolicy(url, { force_min_app_version: bad, force_update_mode: "required" });
        assert.equal(res.status, 400, `${url}: floor ${JSON.stringify(bad)} must be refused`);
        const json = await res.json();
        assert.equal(json.error, "invalid_request");
        assert.ok(json.details?.fieldErrors?.force_min_app_version, "the error names the floor field");
        assert.deepEqual(await readPolicy(url), before, `${url}: a refused floor must not change the stored policy`);
      }
    }
    for (const [loose, stored] of [["2", "2"], ["2.0", "2.0"], ["v2.0.0", "v2.0.0"], [" 2.1.0 ", "2.1.0"], ["2.0.0-rc.1", "2.0.0-rc.1"]]) {
      const res = await putPolicy(cohortPolicyUrl, { force_min_app_version: loose, force_update_mode: "required" });
      assert.equal(res.status, 200, `cohort floor ${JSON.stringify(loose)} must be accepted`);
      assert.equal((await readPolicy(cohortPolicyUrl)).force_min_app_version, stored);
    }
    const tenantLooseRes = await putPolicy(tenantPolicyUrl, { force_min_app_version: "v2.0", force_update_mode: "required" });
    assert.equal(tenantLooseRes.status, 200, "tenant floor v2.0 must be accepted");
    const looseRefresh = await policyRefresh({ app_version: "2.0.0" });
    assert.equal(looseRefresh.status, 200);
    assert.equal(looseRefresh.json.force_update_required, false, "a loose tenant floor v2.0 means 2.0.0");
    const looseRefreshOld = await policyRefresh({ app_version: "1.9.9" });
    assert.equal(looseRefreshOld.json.force_update_required, true, "1.9.9 is below the loose floor v2.0");
    const tenantClearRes = await putPolicy(tenantPolicyUrl, { force_min_app_version: null, force_update_mode: "inherit" });
    // null passes validation (the route then keeps the stored floor: `null ?? current`, unchanged here).
    assert.equal(tenantClearRes.status, 200, "a null tenant floor must pass validation");
    assert.equal((await readPolicy(tenantPolicyUrl)).force_update_mode, "inherit");
    const badCreateRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "tenant-bad-floor", display_name: "Tenant Bad Floor", force_min_app_version: "latest" }),
    });
    assert.equal(badCreateRes.status, 400, "tenant create with an unparsable floor must be refused");
  } catch (err) {
    // The API output explains most failures (startup refusal, unhandled route error).
    console.error(serverOutput);
    throw err;
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => undefined);
    await testPg.stop();
  }
}

run().catch((err) => {
  console.error(err);
  // exit explicitly: shutdown hooks (embedded Postgres) must not mask a failure
  process.exit(1);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { loginAccessToken } from "./lib/vendor-session.mjs";

const port = 33118;
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
      // retry
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

  try {
    await waitForHealth();

    const access_token = await loginAccessToken(baseUrl, "admin@maintafox.systems", "AdminPassw0rd!");
    assert.ok(access_token);

    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug: "tenant-observability",
        display_name: "Tenant Observability",
        rollout_cohort: "stable-main",
        update_channel: "stable",
      }),
    });
    assert.equal(tenantRes.status, 201);
    const tenant = await tenantRes.json();

    const licenseRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: tenant.id, max_machines: 1 }),
    });
    assert.equal(licenseRes.status, 201);
    const license = await licenseRes.json();

    const claimOkRes = await fetch(`${baseUrl}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: license.license_key,
        machine_fingerprint: "machine-obsv-1",
        app_version: "2.0.0",
      }),
    });
    assert.equal(claimOkRes.status, 200);

    const claimSlotFailRes = await fetch(`${baseUrl}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: license.license_key,
        machine_fingerprint: "machine-obsv-2",
        app_version: "2.0.0",
      }),
    });
    assert.equal(claimSlotFailRes.status, 409);

    const sloRes = await fetch(`${baseUrl}/api/v1/ops/observability/slo`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });
    assert.equal(sloRes.status, 200, "slo endpoint must succeed");
    const slo = await sloRes.json();
    assert.ok(typeof slo?.api_health?.availability_percent === "number");
    assert.ok(typeof slo?.auth_latency_ms?.p95 === "number" || slo?.auth_latency_ms?.p95 === null);
    assert.ok(typeof slo?.activation_claims?.success_rate_percent === "number");
    assert.ok(Array.isArray(slo?.activation_claims?.failures_by_reason));
    assert.ok(typeof slo?.sync_operator_surface?.dead_letter_total === "number");
    assert.ok(Array.isArray(slo?.alerts));
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

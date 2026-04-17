import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

const dataDir = mkdtempSync(join(tmpdir(), "mfx-control-api-"));
const port = 33117;
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let i = 0; i < 30; i += 1) {
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
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
      SEED_ADMIN_PASSWORD: "AdminPassw0rd!",
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

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@maintafox.systems", password: "AdminPassw0rd!" }),
    });
    assert.equal(loginRes.status, 200, "login must succeed");
    const loginBody = await loginRes.json();
    const token = loginBody.access_token;
    assert.ok(token, "access token required");

    const privilegedHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Operator-Reason": "INC-2026-042 force-update drill",
      "X-Step-Up-Token": "stepup-token-valid",
    };

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

    const rollbackRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/update-policy/rollback`, {
      method: "POST",
      headers: privilegedHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(rollbackRes.status, 200, "tenant policy rollback must succeed");
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

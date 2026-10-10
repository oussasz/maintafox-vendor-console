import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { obtainStepUpToken } from "./lib/step-up.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "mfx-control-api-license-"));
const port = 33123;
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
      // continue polling
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
      SEED_ADMIN_EMAIL: "admin@maintafox.systems",
      ...TEST_ENTITLEMENT_SIGNING_ENV,
      SEED_BEHAVIOR: "safe",
      NODE_ENV: "production",
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
    const stepUpToken = await obtainStepUpToken(baseUrl, token, "AdminPassw0rd!");

    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        slug: "tenant-onboarding",
        display_name: "Tenant Onboarding",
        rollout_cohort: "pilot-main",
        update_channel: "pilot",
      }),
    });
    assert.equal(tenantRes.status, 201, "tenant create must succeed");
    const tenant = await tenantRes.json();

    const initialListRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/licenses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(initialListRes.status, 200, "initial list must succeed");
    const initialLicenses = await initialListRes.json();
    assert.equal(Array.isArray(initialLicenses), true);
    assert.equal(initialLicenses.length, 0, "new tenant must start with no licenses");

    const idempotencyKey = "issue-license-integration-1";
    const issueRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        tenant_id: tenant.id,
        max_machines: 8,
        update_channel: "pilot",
        expires_at: "2027-01-01T00:00:00.000Z",
        operator_reason_code: "ONBOARDING",
        operator_rationale: "Initial customer onboarding activation bundle issuance.",
      }),
    });
    assert.equal(issueRes.status, 201, "license issue must succeed");
    const issued = await issueRes.json();
    assert.equal(issued.tenant_id, tenant.id);
    assert.equal(issued.max_machines, 8);
    assert.equal(issued.update_channel, "pilot");
    assert.equal(issued.expires_at, "2027-01-01T00:00:00.000Z");
    assert.ok(issued.license_key, "issued key must be returned");

    const replayRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        tenant_id: tenant.id,
        max_machines: 8,
        update_channel: "pilot",
        expires_at: "2027-01-01T00:00:00.000Z",
        operator_reason_code: "ONBOARDING",
        operator_rationale: "Initial customer onboarding activation bundle issuance.",
      }),
    });
    assert.equal(replayRes.status, 201, "idempotent replay should return original response");
    const replayBody = await replayRes.json();
    assert.equal(replayBody.id, issued.id, "replayed issue call must return original key");

    const listRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/licenses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listRes.status, 200, "post-issue list must succeed");
    const listed = await listRes.json();
    assert.equal(listed.length, 1, "tenant should have one issued key");
    assert.equal(listed[0].id, issued.id);

    const revokeRes = await fetch(`${baseUrl}/api/v1/licenses/${issued.id}/revoke`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Idempotency-Key": "revoke-license-integration-1",
        "X-Operator-Reason": "ONBOARDING-CORRECTION",
        "X-Step-Up-Token": stepUpToken,
      },
      body: JSON.stringify({ reason: "tenant onboarding correction" }),
    });
    assert.equal(revokeRes.status, 200, "license revoke must succeed");

    const postRevokeListRes = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/licenses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(postRevokeListRes.status, 200, "post-revoke list must succeed");
    const postRevoke = await postRevokeListRes.json();
    assert.equal(postRevoke.length, 1);
    assert.ok(postRevoke[0].revoked_at, "revoked key must include revoked timestamp");
    assert.equal(postRevoke[0].revoked_reason, "tenant onboarding correction");
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

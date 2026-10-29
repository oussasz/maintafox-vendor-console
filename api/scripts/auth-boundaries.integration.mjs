/**
 * Phase 0 security boundaries (master plan §2 Phase 0 exit criteria):
 *  - device activation tokens are rejected on every vendor-admin route
 *  - vendor-admin and step-up tokens are rejected on device routes
 *  - privileged actions require a real, operator-bound step-up token
 *  - login is rate limited; oversize sync batches are rejected
 *  - the API refuses to boot without required secrets
 *  - desktop app origins get CORS only on device routes, never on admin routes
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { loginOperator } from "./lib/vendor-session.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";

/** Set in run() once the test database exists. */
let databaseUrl = "";
const port = 33141;
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";

const baseEnv = () => ({
  ...process.env,
  PORT: String(port),
  DATABASE_URL: databaseUrl,
  ...TEST_SYNC_ENV,
  JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
  SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
  SEED_ADMIN_EMAIL: ADMIN_EMAIL,
  ...TEST_ENTITLEMENT_SIGNING_ENV,
  SEED_BEHAVIOR: "safe",
  NODE_ENV: "production",
  CORS_ORIGIN: "http://localhost:5174",
  DESKTOP_APP_ORIGINS: "http://tauri.localhost,tauri://localhost",
});

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
    await delay(250);
  }
  throw new Error("control API did not become healthy in time");
}

/** Boot with one required variable removed and assert the process exits non-zero. */
async function assertRefusesToBoot(missingVar) {
  const env = { ...baseEnv(), PORT: String(port + 1) };
  env[missingVar] = "";
  const proc = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (b) => (output += String(b)));
  proc.stderr.on("data", (b) => (output += String(b)));
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [code] = await once(proc, "exit");
  clearTimeout(timer);
  assert.notEqual(code, 0, `API must refuse to boot without ${missingVar}; output:\n${output}`);
  assert.match(output, new RegExp(missingVar), `boot failure must name ${missingVar}`);
}

/** Boot with an invalid DESKTOP_APP_ORIGINS value and assert startup is refused. */
async function assertRejectsDesktopOrigins(value) {
  const env = { ...baseEnv(), PORT: String(port + 1), DESKTOP_APP_ORIGINS: value };
  const proc = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (b) => (output += String(b)));
  proc.stderr.on("data", (b) => (output += String(b)));
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [code] = await once(proc, "exit");
  clearTimeout(timer);
  assert.notEqual(code, 0, `API must refuse DESKTOP_APP_ORIGINS=${value}; output:
${output}`);
  assert.match(output, /DESKTOP_APP_ORIGINS/, "boot failure must name DESKTOP_APP_ORIGINS");
}

/** CORS preflight; returns the Access-Control-Allow-Origin / -Credentials response headers. */
async function preflight(path, origin) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,accept,authorization",
    },
  });
  return {
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowCredentials: res.headers.get("access-control-allow-credentials"),
  };
}

async function run() {
  const testPg = await startTestPostgres();
  databaseUrl = await testPg.createDatabase();
  for (const v of [
    "ENTITLEMENT_SIGNING_PRIVATE_KEY",
    "CORS_ORIGIN",
    "DATABASE_URL",
    "SYNC_CHECKPOINT_SECRET",
    "SYNC_INGRESS_RETENTION_DAYS",
    "SYNC_IDEMPOTENCY_RETENTION_DAYS",
    "SYNC_RETENTION_INTERVAL_MINUTES",
  ]) {
    await assertRefusesToBoot(v);
  }
  for (const bad of ["*", "http://*.localhost", "http://tauri.localhost/app", "null"]) {
    await assertRejectsDesktopOrigins(bad);
  }

  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: baseEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (b) => (serverOutput += String(b)));
  server.stderr.on("data", (b) => (serverOutput += String(b)));

  try {
    await waitForHealth();

    // Password + TOTP (enrolment on first login): scripts/vendor-auth.integration.mjs covers the flow.
    const session = await loginOperator(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const adminToken = session.accessToken;
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };

    // Arrange: tenant + licence + activated machine → device token.
    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ slug: "tenant-auth", display_name: "Tenant Auth", rollout_cohort: "stable-main", update_channel: "stable" }),
    });
    assert.equal(tenantRes.status, 201);
    const tenant = await tenantRes.json();
    const licenseRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tenant_id: tenant.id, max_machines: 2 }),
    });
    assert.equal(licenseRes.status, 201);
    const license = await licenseRes.json();
    const claimRes = await fetch(`${baseUrl}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: license.license_key, machine_fingerprint: "machine-auth-1", app_version: "9.9.9" }),
    });
    assert.equal(claimRes.status, 200, "activation claim must succeed");
    const claim = await claimRes.json();
    const deviceToken = claim.activation_token ?? claim.token ?? claim.access_token;
    assert.ok(typeof deviceToken === "string" && deviceToken.length > 0, `claim must return a device token: ${JSON.stringify(Object.keys(claim))}`);

    // 1) Device token must not open any vendor-admin route.
    const adminRoutes = [
      ["GET", "/api/v1/me/permissions"],
      ["GET", "/api/v1/tenants"],
      ["GET", "/api/v1/editions"],
      ["GET", `/api/v1/tenants/${tenant.id}/licenses`],
      ["GET", "/api/v1/ops/sync-overview"],
      ["GET", "/api/v1/audit/ledger"],
      ["POST", "/api/v1/licenses"],
    ];
    for (const [method, path] of adminRoutes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ tenant_id: tenant.id, max_machines: 1 }) : undefined,
      });
      assert.equal(res.status, 401, `device token must be rejected on ${method} ${path} (got ${res.status})`);
    }

    // 2) Admin token must not open device routes.
    const tenantStatusAsAdmin = await fetch(`${baseUrl}/api/v1/activation/tenant-status`, { headers: adminHeaders });
    assert.equal(tenantStatusAsAdmin.status, 401, "admin token must be rejected on device routes");
    const tenantStatusAsDevice = await fetch(`${baseUrl}/api/v1/activation/tenant-status`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(tenantStatusAsDevice.status, 200, "device token must still work on device routes");

    // 3) Privileged action: missing / fake step-up rejected; real step-up accepted.
    const privilegedPath = `/api/v1/tenants/${tenant.id}/update-policy`;
    const policyBody = JSON.stringify({ force_update_mode: "emergency", force_update_reason: "Auth boundary drill" });
    const fakeStepUp = await fetch(`${baseUrl}${privilegedPath}`, {
      method: "PUT",
      headers: { ...adminHeaders, "X-Operator-Reason": "SEC-DRILL", "X-Step-Up-Token": "stepup-token-valid" },
      body: policyBody,
    });
    assert.equal(fakeStepUp.status, 403, "a static step-up string must be rejected");

    const passwordStepUp = await fetch(`${baseUrl}/api/v1/auth/step-up`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    assert.equal(passwordStepUp.status, 400, "step-up needs an action kind and a TOTP code, not the password");

    const stepUpToken = await session.stepUp("rollout_publish");
    const missingReason = await fetch(`${baseUrl}${privilegedPath}`, {
      method: "PUT",
      headers: { ...adminHeaders, "X-Step-Up-Token": stepUpToken },
      body: policyBody,
    });
    assert.equal(missingReason.status, 403, "privileged action without reason must fail");
    const realStepUp = await fetch(`${baseUrl}${privilegedPath}`, {
      method: "PUT",
      headers: { ...adminHeaders, "X-Operator-Reason": "SEC-DRILL", "X-Step-Up-Token": stepUpToken },
      body: policyBody,
    });
    assert.equal(realStepUp.status, 200, "privileged action with real step-up must succeed");

    // Step-up token is not a session token.
    const stepUpAsBearer = await fetch(`${baseUrl}/api/v1/tenants`, { headers: { Authorization: `Bearer ${stepUpToken}` } });
    assert.equal(stepUpAsBearer.status, 401, "step-up token must not authenticate admin routes");

    // 4) Oversize sync batch rejected by schema.
    const item = { entity_type: "equipment", entity_sync_id: "x", operation: "upsert", row_version: 1, payload_json: "{}", payload_hash: "0".repeat(64) };
    const oversize = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: "v1", idempotency_key: "oversize-batch-001", outbox_batch: Array.from({ length: 1001 }, () => item) }),
    });
    assert.equal(oversize.status, 400, `outbox_batch > 1000 must be rejected (got ${oversize.status})`);

    // 5) CORS: desktop app origins reach device routes only; admin routes stay console-only.
    const desktopOrigin = "http://tauri.localhost";
    for (const path of ["/api/v1/activation/preview", "/api/v1/activation/claim", "/api/v1/sync/exchange"]) {
      const h = await preflight(path, desktopOrigin);
      assert.equal(h.allowOrigin, desktopOrigin, `desktop origin must get CORS on ${path}`);
      assert.notEqual(h.allowCredentials, "true", `desktop CORS on ${path} must not allow credentials`);
    }
    const macOrigin = await preflight("/api/v1/activation/preview", "tauri://localhost");
    assert.equal(macOrigin.allowOrigin, "tauri://localhost", "every listed desktop origin must be accepted");
    for (const path of ["/api/v1/auth/login", "/api/v1/tenants", "/api/v1/licenses", "/api/v1/auth/step-up"]) {
      const h = await preflight(path, desktopOrigin);
      assert.equal(h.allowOrigin, null, `desktop origin must NOT get CORS on admin route ${path}`);
    }
    const unlisted = await preflight("/api/v1/activation/preview", "https://tauri.localhost");
    assert.equal(unlisted.allowOrigin, null, "an origin absent from DESKTOP_APP_ORIGINS must be refused");
    const consoleOnAdmin = await preflight("/api/v1/tenants", "http://localhost:5174");
    assert.equal(consoleOnAdmin.allowOrigin, "http://localhost:5174", "console origin keeps CORS on admin routes");
    assert.equal(consoleOnAdmin.allowCredentials, "true", "console CORS stays credentialed");
    const consoleOnDevice = await preflight("/api/v1/activation/preview", "http://localhost:5174");
    assert.equal(consoleOnDevice.allowOrigin, "http://localhost:5174", "CORS_ORIGIN still applies to device routes");

    // 6) Login brute force is rate limited (limit 10 / 15 min per IP; one success already used).
    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: `wrong-${i}` }),
      });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, "repeated failed logins must hit the rate limit");

    console.log("auth-boundaries: all checks passed");
  } catch (err) {
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

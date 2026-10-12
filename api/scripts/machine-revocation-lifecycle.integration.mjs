/**
 * Phase 1.4 — licence lifecycle enforcement on device routes.
 *
 * Runs the real API against a temporary data dir and checks that:
 * - an operator machine revocation blocks policy-refresh and sync at once and cannot be undone by
 *   re-entering the licence key; reinstatement restores access and respects the slot limit;
 * - re-claiming supersedes the previous device token; ageing tokens are rotated on policy refresh;
 * - tenant deactivation, licence revocation and licence expiry are enforced on every device route;
 * - last_seen_at is updated by device traffic.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";
import jwt from "jsonwebtoken";

import { loginOperator } from "./lib/vendor-session.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";

const port = 33127;
const baseUrl = `http://127.0.0.1:${port}`;
const JWT_SECRET = "integration_test_jwt_secret_value_with_minimum_length_12345";
const ADMIN_PASSWORD = "AdminPassw0rd!";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // keep polling
    }
    await delay(200);
  }
  throw new Error("control API did not become healthy in time");
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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
      JWT_SECRET,
      SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
      SEED_ADMIN_EMAIL: "admin@maintafox.systems",
      ...TEST_ENTITLEMENT_SIGNING_ENV,
      SEED_BEHAVIOR: "safe",
      NODE_ENV: "production",
      CORS_ORIGIN: "http://localhost:5174",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (buf) => (serverOutput += String(buf)));
  server.stderr.on("data", (buf) => (serverOutput += String(buf)));

  /** Direct SQL against the API's Postgres database (test setup only). */
  const sql = async (text, params = []) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end();
    }
  };

  try {
    await waitForHealth();
    const session = await loginOperator(baseUrl, "admin@maintafox.systems", ADMIN_PASSWORD);
    const adminToken = session.accessToken;
    assert.ok(adminToken, "admin login must succeed");
    const admin = { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" };
    let opCounter = 0;
    const privileged = async (reason, kind) => ({
      ...admin,
      "Idempotency-Key": `machine-revocation-${(opCounter += 1)}`,
      "X-Operator-Reason": reason,
      "X-Step-Up-Token": await session.stepUp(kind),
    });

    const tenant = await json(
      await fetch(`${baseUrl}/api/v1/tenants`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ slug: "tenant-revocation", display_name: "Tenant Revocation" }),
      }),
    );
    assert.ok(tenant.id, `tenant create must succeed: ${JSON.stringify(tenant)}`);

    const issueRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: { ...admin, "Idempotency-Key": "issue-revocation-1" },
      body: JSON.stringify({
        tenant_id: tenant.id,
        max_machines: 1,
        expires_at: "2099-01-01T00:00:00.000Z",
        operator_reason_code: "ONBOARDING",
        operator_rationale: "Machine revocation lifecycle integration test.",
      }),
    });
    assert.equal(issueRes.status, 201, "licence issue must succeed");
    const licence = await issueRes.json();

    const claim = (fingerprint) =>
      fetch(`${baseUrl}/api/v1/activation/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: licence.license_key, machine_fingerprint: fingerprint, app_version: "1.0.0" }),
      });
    const refresh = (token) =>
      fetch(`${baseUrl}/api/v1/activation/policy-refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
    const sync = (token) =>
      fetch(`${baseUrl}/api/v1/sync/exchange`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
    const machineAction = async (fingerprint, action) =>
      fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/machines/${encodeURIComponent(fingerprint)}/${action}`, {
        method: "POST",
        headers: await privileged(`MACHINE-${action.toUpperCase()}`, "machine_trust_change"),
        body: JSON.stringify({ reason: `integration ${action}` }),
      });

    // ── Claim device A, refresh works, last_seen is touched ──────────────────────────────
    const deviceA = "fp-device-a-0001";
    const claimA = await claim(deviceA);
    assert.equal(claimA.status, 200, "device A claim must succeed");
    const tokenA = (await claimA.json()).activation_token;
    await sql("UPDATE machine_activations SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE machine_fingerprint = $1", [deviceA]);
    assert.equal((await refresh(tokenA)).status, 200, "policy refresh must succeed while active");
    {
      const [seen] = await sql("SELECT last_seen_at FROM machine_activations WHERE machine_fingerprint = $1", [deviceA]);
      assert.ok(seen.last_seen_at > "2026-01-01", `last_seen_at must be refreshed, got ${seen.last_seen_at}`);
    }

    // ── Operator revokes device A ─────────────────────────────────────────────────────────
    assert.equal((await machineAction(deviceA, "revoke")).status, 200, "machine revoke must succeed");
    const refreshRevoked = await refresh(tokenA);
    assert.equal(refreshRevoked.status, 403);
    assert.equal((await refreshRevoked.json()).error, "activation_revoked");
    const syncRevoked = await sync(tokenA);
    assert.equal(syncRevoked.status, 403, "sync must be refused for a revoked machine");
    const reclaimRevoked = await claim(deviceA);
    assert.equal(reclaimRevoked.status, 403, "re-entering the key must not undo an operator revocation");
    assert.equal((await reclaimRevoked.json()).error, "activation_revoked");
    const listed = await json(await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}/activations`, { headers: admin }));
    const rowA = listed.find((r) => r.machine_id === deviceA);
    assert.equal(rowA.trusted_device, false);
    assert.equal(rowA.revocation_kind, "machine");

    // ── The freed slot goes to device B; reinstating A then exceeds the limit ─────────────
    const deviceB = "fp-device-b-0002";
    const claimB = await claim(deviceB);
    assert.equal(claimB.status, 200, "device B may use the slot freed by revoking A");
    const reinstateFull = await machineAction(deviceA, "reinstate");
    assert.equal(reinstateFull.status, 409);
    assert.equal((await reinstateFull.json()).error, "slot_limit_reached");

    // ── Free B's slot, reinstate A: the same token works again ────────────────────────────
    assert.equal((await machineAction(deviceB, "revoke")).status, 200);
    assert.equal((await machineAction(deviceA, "reinstate")).status, 200, "reinstate must succeed with a free slot");
    assert.equal((await refresh(tokenA)).status, 200, "reinstated machine regains access");
    assert.equal((await claim(deviceB)).status, 403, "B stays revoked");

    // ── Re-claim supersedes the previous token ────────────────────────────────────────────
    await delay(1100); // distinct iat => distinct token
    const reclaimA = await claim(deviceA);
    assert.equal(reclaimA.status, 200);
    const tokenA2 = (await reclaimA.json()).activation_token;
    assert.notEqual(tokenA2, tokenA);
    const superseded = await refresh(tokenA);
    assert.equal(superseded.status, 401);
    assert.equal((await superseded.json()).error, "token_superseded");
    assert.equal((await refresh(tokenA2)).status, 200);

    // ── An ageing token is rotated on policy refresh ──────────────────────────────────────
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    const oldToken = jwt.sign(
      { kind: "activation", tenant_id: tenant.id, license_id: licence.id, machine_fingerprint: deviceA, iat: eightDaysAgo },
      JWT_SECRET,
      { algorithm: "HS256", issuer: "maintafox-control-api", audience: "maintafox-desktop-device", expiresIn: 30 * 24 * 3600 },
    );
    await sql("UPDATE machine_activations SET activation_token = $1 WHERE machine_fingerprint = $2", [oldToken, deviceA]);
    const rotateRes = await refresh(oldToken);
    assert.equal(rotateRes.status, 200);
    const rotated = (await rotateRes.json()).activation_token;
    assert.notEqual(rotated, oldToken, "token older than 7 days must be rotated");
    assert.equal((await refresh(oldToken)).status, 401, "the rotated-out token stops working");
    assert.equal((await refresh(rotated)).status, 200);

    // ── Tenant deactivation, licence expiry and licence revocation ────────────────────────
    const setTenantActive = (active) => sql("UPDATE tenants SET is_active = $1 WHERE id = $2", [active, tenant.id]);
    await setTenantActive(0);
    const inactive = await refresh(rotated);
    assert.equal(inactive.status, 403);
    assert.equal((await inactive.json()).error, "tenant_inactive");
    await setTenantActive(1);

    await sql("UPDATE license_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [licence.id]);
    const expired = await sync(rotated);
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).error, "license_expired");
    await sql("UPDATE license_keys SET expires_at = '2099-01-01T00:00:00.000Z' WHERE id = $1", [licence.id]);

    const revokeLicence = await fetch(`${baseUrl}/api/v1/licenses/${licence.id}/revoke`, {
      method: "POST",
      headers: await privileged("LICENCE-REVOKE", "entitlement_suspension"),
      body: JSON.stringify({ reason: "integration licence revoke" }),
    });
    assert.equal(revokeLicence.status, 200);
    const licRevoked = await refresh(rotated);
    assert.equal(licRevoked.status, 403);
    assert.equal((await licRevoked.json()).error, "license_revoked");
    const reinstateAfterLicence = await machineAction(deviceA, "reinstate");
    assert.equal(reinstateAfterLicence.status, 409, "licence-level revocation is not reinstatable per machine");

    console.log("machine-revocation-lifecycle: all checks passed");
  } catch (err) {
    console.error(serverOutput.split("\n").slice(-40).join("\n"));
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

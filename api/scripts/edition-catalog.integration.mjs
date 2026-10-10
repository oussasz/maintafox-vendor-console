import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";

const port = 33141;
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
      // poll
    }
    await delay(200);
  }
  throw new Error("control API did not become healthy");
}

function fullCaps(overrides = {}) {
  const keys = [
    "equipment",
    "requests",
    "work_orders",
    "inventory",
    "personnel",
    "organization",
    "reference",
    "planning",
    "pm",
    "permits",
    "inspections",
    "training",
    "reports",
    "rams",
    "finance",
    "sync",
    "erp",
  ];
  const out = {};
  for (const k of keys) out[k] = false;
  out.equipment = true;
  out.requests = true;
  out.work_orders = true;
  out.inventory = true;
  out.personnel = true;
  out.organization = true;
  out.reference = true;
  out.planning = true;
  out.pm = true;
  Object.assign(out, overrides);
  return out;
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
    assert.equal(loginRes.status, 200);
    const { access_token: token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const listRes = await fetch(`${baseUrl}/api/v1/editions`, { headers: auth });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.items.length >= 4);
    const professional = listBody.items.find((e) => e.id === "professional");
    assert.ok(professional);
    assert.equal(professional.is_system, true);

    // Partial PATCH rejected
    const badPatch = await fetch(`${baseUrl}/api/v1/editions/professional`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ capabilities: { planning: true }, expected_row_version: professional.row_version }),
    });
    assert.equal(badPatch.status, 400);

    const nextCaps = { ...professional.capabilities, permits: false, inspections: false };
    const okPatch = await fetch(`${baseUrl}/api/v1/editions/professional`, {
      method: "PATCH",
      headers: { ...auth, "If-Match": String(professional.row_version) },
      body: JSON.stringify({
        capabilities: nextCaps,
        expected_row_version: professional.row_version,
      }),
    });
    if (okPatch.status !== 200) {
      throw new Error(`professional patch failed: ${okPatch.status} ${await okPatch.text()}`);
    }
    const updated = await okPatch.json();
    assert.equal(updated.capabilities.permits, false);
    assert.equal(updated.row_version, professional.row_version + 1);

    const stale = await fetch(`${baseUrl}/api/v1/editions/professional`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        capabilities: nextCaps,
        expected_row_version: professional.row_version,
      }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error, "edition_version_conflict");

    const createRes = await fetch(`${baseUrl}/api/v1/editions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: "pilot-v1",
        label: "Pilot v1",
        capabilities: fullCaps({ permits: false, inspections: false }),
      }),
    });
    if (createRes.status !== 201) {
      throw new Error(`create edition failed: ${createRes.status} ${await createRes.text()}`);
    }

    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        slug: "edition-pilot-co",
        display_name: "Edition Pilot Co",
        edition: "pilot-v1",
      }),
    });
    if (tenantRes.status !== 201) {
      throw new Error(`tenant create failed: ${tenantRes.status} ${await tenantRes.text()}`);
    }
    const tenant = await tenantRes.json();

    // Soft-deactivate tenant (is_active=0) — still blocks delete
    // Use raw SQL via keeping the tenant assigned; PATCH tenant doesn't expose is_active.
    // Assign another tenant that we leave active, and delete attempt with in-use.
    const delWhileUsed = await fetch(`${baseUrl}/api/v1/editions/pilot-v1`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(delWhileUsed.status, 409);
    const delBody = await delWhileUsed.json();
    assert.equal(delBody.error, "edition_in_use");

    // Move tenant off edition then delete
    const move = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ edition: "core" }),
    });
    if (move.status !== 200) {
      throw new Error(`tenant move failed: ${move.status} ${await move.text()}`);
    }

    const delOk = await fetch(`${baseUrl}/api/v1/editions/pilot-v1`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(delOk.status, 204);

    console.log("edition-catalog HTTP integration ok");
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
  process.exit(1);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "mfx-legacy-tenant-"));
const port = 33124;
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

function seedLegacyTenantTableOnly() {
  const dbPath = join(dataDir, "control-plane.db").replace(/\\/g, "\\\\");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const Database=require('better-sqlite3'); const db=new Database('${dbPath}'); db.exec(\`CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, rollout_channel TEXT NOT NULL, rollout_cohort TEXT NOT NULL, update_channel TEXT NOT NULL, policy_defaults_json TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, bootstrap_completed_at TEXT NULL, bootstrap_method TEXT NULL, force_update_mode TEXT NOT NULL DEFAULT 'inherit', force_update_reason TEXT NULL, offline_grace_hours INTEGER NOT NULL DEFAULT 72, trust_revocation_disconnects_immediately INTEGER NOT NULL DEFAULT 0, reconnect_requires_fresh_heartbeat INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, force_min_app_version TEXT NULL);\`); db.close();`,
    ],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("failed to seed legacy tenant schema");
  }
}

async function run() {
  seedLegacyTenantTableOnly();

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
      // "safe" seeds only the admin user (no domain data); "disabled" would make login impossible.
      SEED_BEHAVIOR: "safe",
      NODE_ENV: "production",
      CORS_ORIGIN: "http://localhost:5174",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth();

    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@maintafox.systems", password: "AdminPassw0rd!" }),
    });
    assert.equal(loginRes.status, 200, "login must succeed");
    const { access_token: token } = await loginRes.json();
    assert.ok(token);

    const slug = `legacy-${Date.now()}`;
    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug,
        display_name: "Legacy Schema Tenant",
        rollout_cohort: "stable-main",
        update_channel: "stable",
      }),
    });
    const tenantBody = await tenantRes.json();
    assert.equal(tenantRes.status, 201, `tenant create on legacy schema must succeed: ${JSON.stringify(tenantBody)}`);
    assert.equal(tenantBody.slug, slug);

    const dupRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug,
        display_name: "Duplicate",
        rollout_cohort: "stable-main",
        update_channel: "stable",
      }),
    });
    const dupBody = await dupRes.json();
    assert.equal(dupRes.status, 409, "duplicate slug must return 409");
    assert.equal(dupBody.error, "tenant_conflict");

    console.log("legacy tenant schema integration test passed");
  } finally {
    // Wait for exit so Windows releases the SQLite file handles before the temp dir is removed.
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

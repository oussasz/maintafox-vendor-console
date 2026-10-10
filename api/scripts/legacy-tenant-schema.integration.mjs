/**
 * SQLite -> Postgres control-plane import (dist/tools/migrate-sqlite-to-postgres.js), using a
 * SQLite file shaped like the legacy VPS database: a tenants table with legacy-only columns
 * (rollout_channel, policy_defaults_json, status, ...) and without the newer ones, a hash-chained
 * audit ledger, and leftover SQLite sync fallback rows.
 *
 * Checks: sync fallback refused without the explicit flag, dry run leaves Postgres empty, real
 * import copies every row (legacy columns kept in legacy_attributes_json), second run refused,
 * a tampered audit chain is refused, and the API then runs on the imported data (case-insensitive
 * login, tenants, slug conflict 409, audit chain still verifies after a new privileged action).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import pg from "pg";

import { auditRecordPreimage } from "../dist/audit-chain.js";
import { obtainStepUpToken } from "./lib/step-up.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const workDir = mkdtempSync(join(tmpdir(), "mfx-sqlite-import-"));
const port = 33124;
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Legacy SQLite schema (as the pre-Postgres API created it, with a legacy VPS tenants table). */
function buildLegacySqlite(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      rollout_channel TEXT NOT NULL, rollout_cohort TEXT NOT NULL, update_channel TEXT NOT NULL,
      policy_defaults_json TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, bootstrap_completed_at TEXT NULL, bootstrap_method TEXT NULL,
      force_update_mode TEXT NOT NULL DEFAULT 'inherit', force_update_reason TEXT NULL,
      offline_grace_hours INTEGER NOT NULL DEFAULT 72, trust_revocation_disconnects_immediately INTEGER NOT NULL DEFAULT 0,
      reconnect_requires_fresh_heartbeat INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1,
      force_min_app_version TEXT NULL);
    CREATE TABLE license_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, license_key TEXT NOT NULL UNIQUE,
      max_machines INTEGER NOT NULL DEFAULT 1, update_channel TEXT NOT NULL DEFAULT 'stable', issued_by_user_id INTEGER NULL,
      expires_at TEXT NULL, revoked_at TEXT NULL, revoked_reason TEXT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(tenant_id) REFERENCES tenants(id));
    CREATE TABLE machine_activations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, license_id TEXT NOT NULL,
      machine_fingerprint TEXT NOT NULL, machine_label TEXT NULL, app_version TEXT NULL, activation_token TEXT NOT NULL,
      activated_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT NULL, revocation_kind TEXT NULL CHECK (revocation_kind IN ('machine', 'license')),
      UNIQUE(tenant_id, machine_fingerprint), FOREIGN KEY(tenant_id) REFERENCES tenants(id),
      FOREIGN KEY(license_id) REFERENCES license_keys(id));
    CREATE TABLE audit_records (record_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, occurred_at_rfc3339 TEXT NOT NULL,
      actor_id TEXT NOT NULL, action_code TEXT NOT NULL, action_category TEXT NOT NULL, correlation_id TEXT NOT NULL,
      scope_tenant_id TEXT NULL, before_snapshot_sha256 TEXT NULL, after_snapshot_sha256 TEXT NULL,
      payload_canonical_sha256 TEXT NOT NULL, chain_prev_hash TEXT NULL, record_integrity_sha256 TEXT NOT NULL,
      reason_code TEXT NULL, approval_correlation_id TEXT NULL, entity_refs_json TEXT NOT NULL);
    CREATE TABLE edition_catalog (id TEXT PRIMARY KEY, label TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0, row_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NULL, updated_by TEXT NULL);
    CREATE TABLE incident_runbooks (runbook_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL,
      first_steps_json TEXT NOT NULL);
    CREATE TABLE idempotency_keys (idempotency_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, method TEXT NOT NULL,
      path TEXT NOT NULL, request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_json TEXT NOT NULL,
      created_at_rfc3339 TEXT NOT NULL);
    CREATE TABLE sync_mirror_ingress (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL, operation TEXT NOT NULL,
      row_version INTEGER NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, machine_fingerprint TEXT NOT NULL,
      received_at_rfc3339 TEXT NOT NULL, UNIQUE(tenant_id, idempotency_key));
  `);
  db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 4));
  db.prepare(
    "INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by) VALUES ('core', 'Core', '{}', 1, 1, NULL, 'system-seed')",
  ).run();
  const insertTenant = db.prepare(
    `INSERT INTO tenants (id, slug, display_name, rollout_channel, rollout_cohort, update_channel, policy_defaults_json,
       status, status_reason, created_at, updated_at, is_active) VALUES (?, ?, ?, 'stable', 'stable-main', 'stable', '{}', ?, ?, ?, ?, 1)`,
  );
  insertTenant.run("tenant_legacy_1", "legacy-one", "Legacy One", "active", null, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  insertTenant.run("tenant_legacy_2", "legacy-two", "Legacy Two", "suspended", "unpaid", "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z");
  db.prepare(
    "INSERT INTO license_keys (id, tenant_id, license_key, max_machines, update_channel, expires_at) VALUES ('lic_legacy_1', 'tenant_legacy_1', 'MFX-LEGACY-0001', 2, 'stable', '2099-01-01T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO machine_activations (id, tenant_id, license_id, machine_fingerprint, activation_token, activated_at, last_seen_at) VALUES ('act_legacy_1', 'tenant_legacy_1', 'lic_legacy_1', 'fp-legacy-0001', 'legacy-token', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')",
  ).run();
  // Hash-chained audit records, built exactly as the API builds them.
  let prev = null;
  for (let seq = 1; seq <= 3; seq += 1) {
    const rec = {
      record_id: `audit_legacy_${seq}`,
      sequence: seq,
      occurred_at_rfc3339: `2026-04-0${seq}T00:00:00.000Z`,
      actor_id: "user_1",
      action_code: "license_issue",
      action_category: "entitlement",
      correlation_id: `corr-${seq}`,
      scope_tenant_id: "tenant_legacy_1",
      before_snapshot_sha256: null,
      after_snapshot_sha256: null,
      payload_canonical_sha256: sha256Hex(JSON.stringify({ seq })),
      chain_prev_hash: prev,
      reason_code: null,
      approval_correlation_id: null,
      entity_refs: { tenant_id: "tenant_legacy_1" },
    };
    const integrity = sha256Hex(auditRecordPreimage(rec));
    db.prepare(
      `INSERT INTO audit_records (record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
         correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256, payload_canonical_sha256,
         chain_prev_hash, record_integrity_sha256, reason_code, approval_correlation_id, entity_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.record_id, rec.sequence, rec.occurred_at_rfc3339, rec.actor_id, rec.action_code, rec.action_category,
      rec.correlation_id, rec.scope_tenant_id, null, null, rec.payload_canonical_sha256, prev, integrity, null, null,
      JSON.stringify(rec.entity_refs),
    );
    prev = integrity;
  }
  db.prepare(
    `INSERT INTO sync_mirror_ingress (tenant_id, idempotency_key, entity_type, entity_sync_id, operation, row_version,
       payload_json, payload_hash, machine_fingerprint, received_at_rfc3339)
     VALUES ('tenant_legacy_1', 'k1', 'equipment', 'eq-1', 'create', 1, '{}', ?, 'fp-legacy-0001', '2026-03-01T00:00:00.000Z')`,
  ).run(sha256Hex("{}"));
  db.close();
}

function runImport(databaseUrl, sqlitePath, extraArgs = []) {
  const r = spawnSync(process.execPath, ["dist/tools/migrate-sqlite-to-postgres.js", "--sqlite", sqlitePath, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function sql(databaseUrl, text, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
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

async function run() {
  const testPg = await startTestPostgres();
  const sqlitePath = join(workDir, "control-plane.db");
  buildLegacySqlite(sqlitePath);
  let server = null;
  let serverOutput = "";
  try {
    // ── Import tool ─────────────────────────────────────────────────────────────────────────
    const databaseUrl = await testPg.createDatabase();

    const noFlag = runImport(databaseUrl, sqlitePath);
    assert.equal(noFlag.code, 1, "sync fallback rows must be refused without the explicit flag");
    assert.match(noFlag.stderr, /--discard-sqlite-sync-fallback/);

    const dry = runImport(databaseUrl, sqlitePath, ["--discard-sqlite-sync-fallback", "--dry-run"]);
    assert.equal(dry.code, 0, `dry run must succeed: ${dry.stderr}`);
    assert.equal(JSON.parse(dry.stdout).status, "dry_run_ok_rolled_back");
    assert.equal((await sql(databaseUrl, "SELECT COUNT(*)::int AS c FROM users"))[0].c, 0, "dry run must leave Postgres empty");

    const real = runImport(databaseUrl, sqlitePath, ["--discard-sqlite-sync-fallback"]);
    assert.equal(real.code, 0, `import must succeed: ${real.stderr}`);
    const report = JSON.parse(real.stdout);
    assert.equal(report.status, "imported");
    assert.equal(report.tables.tenants.copied_rows, 2);
    assert.equal(report.tables.audit_records.copied_rows, 3);
    assert.equal(report.audit_chain.target.status, "ok");
    assert.deepEqual(
      [...report.tables.tenants.legacy_columns_kept].sort(),
      ["policy_defaults_json", "rollout_channel", "status", "status_reason", "updated_at"],
    );
    const [legacyTwo] = await sql(databaseUrl, "SELECT legacy_attributes_json, edition FROM tenants WHERE id = 'tenant_legacy_2'");
    assert.equal(JSON.parse(legacyTwo.legacy_attributes_json).status_reason, "unpaid", "legacy values are kept");
    assert.equal(legacyTwo.edition, "core", "missing newer columns take the schema default");

    const again = runImport(databaseUrl, sqlitePath, ["--discard-sqlite-sync-fallback"]);
    assert.equal(again.code, 1, "a second import must be refused");
    assert.match(again.stderr, /refusing to run twice/);

    // A tampered audit ledger is refused before anything is copied.
    const tamperedPath = join(workDir, "tampered.db");
    copyFileSync(sqlitePath, tamperedPath);
    const t = new Database(tamperedPath);
    t.prepare("UPDATE audit_records SET actor_id = 'someone_else' WHERE sequence = 2").run();
    t.close();
    const tampered = runImport(await testPg.createDatabase(), tamperedPath, ["--discard-sqlite-sync-fallback"]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /audit hash chain is already invalid/);

    // ── API on the imported data ────────────────────────────────────────────────────────────
    server = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        ...TEST_SYNC_ENV,
        JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
        SEED_ADMIN_PASSWORD: "UnusedSeedPassw0rd!",
        SEED_ADMIN_EMAIL: "unused-seed@maintafox.systems",
        ...TEST_ENTITLEMENT_SIGNING_ENV,
        SEED_BEHAVIOR: "safe",
        NODE_ENV: "production",
        CORS_ORIGIN: "http://localhost:5174",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (b) => (serverOutput += String(b)));
    server.stderr.on("data", (b) => (serverOutput += String(b)));
    await waitForHealth();

    // Imported admin, e-mail matched case-insensitively (SQLite COLLATE NOCASE behaviour).
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD }),
    });
    assert.equal(loginRes.status, 200, "imported admin must log in");
    const { access_token: token } = await loginRes.json();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    assert.equal((await sql(databaseUrl, "SELECT COUNT(*)::int AS c FROM users"))[0].c, 1, "no second admin is seeded");

    const tenants = await (await fetch(`${baseUrl}/api/v1/tenants`, { headers: auth })).json();
    assert.deepEqual(tenants.map((x) => x.slug).sort(), ["legacy-one", "legacy-two"]);

    const slug = `legacy-${Date.now()}`;
    const body = JSON.stringify({ slug, display_name: "New Tenant", rollout_cohort: "stable-main", update_channel: "stable" });
    const created = await fetch(`${baseUrl}/api/v1/tenants`, { method: "POST", headers: auth, body });
    assert.equal(created.status, 201, `tenant create must succeed: ${await created.clone().text()}`);
    const dup = await fetch(`${baseUrl}/api/v1/tenants`, { method: "POST", headers: auth, body });
    assert.equal(dup.status, 409, "duplicate slug must return 409");
    assert.equal((await dup.json()).error, "tenant_conflict");

    // The imported chain continues: a privileged action appends record 4 and the chain verifies.
    const stepUp = await obtainStepUpToken(baseUrl, token, ADMIN_PASSWORD);
    const policy = await fetch(`${baseUrl}/api/v1/tenants/tenant_legacy_1/offline-policy`, {
      method: "PUT",
      headers: { ...auth, "X-Operator-Reason": "IMPORT-CHECK", "X-Step-Up-Token": stepUp },
      body: JSON.stringify({ offline_grace_hours: 48, trust_revocation_disconnects_immediately: false, reconnect_requires_fresh_heartbeat: true }),
    });
    assert.equal(policy.status, 200);
    const chain = await (await fetch(`${baseUrl}/api/v1/audit/ledger/verify-chain`, { headers: auth })).json();
    assert.deepEqual(chain, { status: "ok", checked_count: 4 });

    console.log("legacy SQLite import + API on Postgres: all checks passed");
  } catch (err) {
    if (serverOutput) console.error(serverOutput.split("\n").slice(-40).join("\n"));
    throw err;
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await once(server, "exit").catch(() => undefined);
    }
    await testPg.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

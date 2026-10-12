/**
 * Measured ops metrics (master plan Phase 3.3, deploy/OPS_METRICS.md) against a real Postgres and
 * the real API: every figure of the sync overview is checked against exactly what the test did.
 *
 *   - per-device lag (own rows excluded) and checkpoint age; a device that pulls is caught up;
 *   - rejection rate, dead letters (refused, then applied under the same key = no longer dead),
 *     conflicts, retries counted from idempotent replays, drill-down rows with batch ids;
 *   - platform overview: backups from backup_runs, object storage and database probes;
 *   - rollout diagnostics only list measured buckets;
 *   - GET /api/v1/ops/metrics: Prometheus format, operator token or METRICS_SCRAPE_TOKEN, refused
 *     otherwise; scrape token access recorded in operator_scope_access.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";

import pg from "pg";

import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const port = 33181;
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";
const SCRAPE_TOKEN = "integration-test-metrics-scrape-token-0123456789";
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let databaseUrl = "";
let server = null;
let serverOutput = "";

async function startApi() {
  server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
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
      METRICS_SCRAPE_TOKEN: SCRAPE_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (b) => (serverOutput += String(b)));
  server.stderr.on("data", (b) => (serverOutput += String(b)));
  for (let i = 0; i < 160; i += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // keep polling
    }
    await delay(250);
  }
  throw new Error(`API did not start:\n${serverOutput}`);
}

async function su(text, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, contentType: res.headers.get("content-type") };
}

function item(entityType, entitySyncId, payload, extra = {}) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: extra.key ?? randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: "create",
    row_version: 1,
    base_row_version: null,
    payload_json,
    payload_hash: extra.badHash ? "0".repeat(64) : sha256Hex(payload_json),
  };
}

let exchangeCount = 0;
async function exchange(dev, outbox = []) {
  const body = {
    protocol_version: "v2",
    idempotency_key: `ex-${randomUUID()}`,
    checkpoint_token: dev.checkpoint,
    current_user_sync_ids: [],
    device_class: "desktop",
    outbox_batch: outbox,
  };
  const r = await api("POST", "/api/v1/sync/exchange", dev.token, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  exchangeCount += 1;
  dev.checkpoint = r.json.checkpoint_token;
  return { response: r.json, body };
}

async function overview(admin) {
  const r = await api("GET", "/api/v1/ops/sync-overview", admin);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

async function main() {
  const testPg = await startTestPostgres();
  databaseUrl = await testPg.createDatabase();
  try {
    await startApi();
    const login = await api("POST", "/api/v1/auth/login", null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const admin = login.json.access_token;
    const t = await api("POST", "/api/v1/tenants", admin, { slug: "ops-metrics", display_name: "Ops metrics" });
    const tenantId = t.json.id;
    const l = await api("POST", "/api/v1/licenses", admin, { tenant_id: tenantId, max_machines: 2 });
    const devices = [];
    for (const n of [1, 2]) {
      const c = await api("POST", "/api/v1/activation/claim", null, {
        license_key: l.json.license_key,
        machine_fingerprint: `ops-device-${n}`,
        app_version: "1.0.0",
      });
      assert.equal(c.status, 200);
      devices.push({ token: c.json.activation_token, checkpoint: null, id: `ops-device-${n}` });
    }
    const [d1, d2] = devices;

    // Before any sync: both devices never synced, nothing pending, no traffic.
    let ov = await overview(admin);
    let row = ov.tenant_rows.find((r) => r.tenant_id === tenantId);
    assert.deepEqual(
      [row.lag_seconds, row.rejection_rate_bps, row.retry_pressure, row.dead_letter_count, row.severity],
      [0, 0, 0, 0, "info"],
    );
    assert.equal(ov.window_hours, 24);
    assert.deepEqual(
      ov.heartbeat_anomalies.filter((a) => a.tenant_id === tenantId).map((a) => `${a.machine_id}:${a.anomaly_code}`).sort(),
      ["ops-device-1:never_synced", "ops-device-2:never_synced"],
    );

    // Device 1 pushes 3 valid items and 1 refused item (wrong payload hash).
    const refusedKey = randomUUID();
    const push = await exchange(d1, [
      item("equipment", "eq-1", { n: 1 }),
      item("equipment", "eq-2", { n: 2 }),
      item("equipment", "eq-3", { n: 3 }),
      item("equipment", "eq-4", { n: 4 }, { key: refusedKey, badHash: true }),
    ]);
    assert.equal(push.response.acknowledged_items.length, 3);
    assert.equal(push.response.rejected_items[0].rejection_code, "payload_hash_mismatch");
    await delay(2100);

    ov = await overview(admin);
    row = ov.tenant_rows.find((r) => r.tenant_id === tenantId);
    const dev1 = ov.device_rows.find((d) => d.machine_id === d1.id);
    const dev2 = ov.device_rows.find((d) => d.machine_id === d2.id);
    assert.equal(dev1.lag_seconds, 0, "a device's own rows are not lag");
    assert.equal(dev1.protocol, "v2");
    assert.ok(dev2.lag_seconds >= 2, `device 2 has not received 3 items for >= 2 s (got ${dev2.lag_seconds})`);
    assert.equal(dev2.protocol, "never_synced");
    assert.equal(row.lag_seconds, dev2.lag_seconds);
    assert.equal(row.applied_items, 3);
    assert.equal(row.rejected_items, 1);
    assert.equal(row.rejection_rate_bps, 2500, "1 refused / (3 applied + 1 refused)");
    assert.equal(row.dead_letter_count, 1);
    assert.equal(row.severity, "critical", "rejection rate 2500 bps >= critical threshold 500");
    const drill = ov.drill_by_tenant[tenantId];
    assert.equal(drill.length, 1);
    assert.equal(drill[0].idempotency_key, refusedKey);
    assert.equal(drill[0].failure_reason_code, "payload_hash_mismatch");
    assert.equal(drill[0].batch_id, push.response.server_batch_id);
    assert.equal(drill[0].attempt_count, 1);
    assert.ok(ov.repair_queue.some((q) => q.tenant_id === tenantId && q.queue_kind === "dead_letter"));

    // Device 2 creates an entity that already exists: a conflict, never applied.
    const conflict = await exchange(d2, [item("equipment", "eq-1", { n: "mine" })]);
    assert.equal(conflict.response.conflict_items.length, 1);
    // A retry of device 1's exchange (same key and body) is answered from the stored response.
    const replay = await api("POST", "/api/v1/sync/exchange", d1.token, push.body);
    assert.equal(replay.status, 200);
    // The refused item, resent with the same key and a correct hash, is applied: no longer dead.
    const fixed = item("equipment", "eq-4", { n: 4 }, { key: refusedKey });
    await exchange(d1, [fixed]);
    // Device 2 pulls everything, then acknowledges it with its next exchange (the checkpoint it
    // sends back): caught up. Delivered-but-unacknowledged changes still count as lag.
    for (let i = 0; i < 5; i += 1) {
      const r = await exchange(d2);
      if (!r.response.has_more) break;
    }
    await delay(1100);
    const beforeAck = await overview(admin);
    assert.ok(beforeAck.device_rows.find((d) => d.machine_id === d2.id).lag_seconds >= 1, "delivered, not yet acknowledged");
    await exchange(d2);

    ov = await overview(admin);
    row = ov.tenant_rows.find((r) => r.tenant_id === tenantId);
    assert.equal(row.applied_items, 4);
    assert.equal(row.rejected_items, 1);
    assert.equal(row.conflicts, 1);
    assert.equal(row.rejection_rate_bps, 1667, "1 / (4 + 1 + 1) = 16.67 %");
    assert.equal(row.dead_letter_count, 0, "applied since under the same key");
    assert.equal(row.retries, 1);
    assert.equal(row.exchanges, exchangeCount);
    assert.equal(row.retry_pressure, Math.round(100 / (exchangeCount + 1)));
    assert.equal(ov.device_rows.find((d) => d.machine_id === d2.id).lag_seconds, 0, "device 2 caught up");
    assert.ok(ov.device_rows.every((d) => d.online && d.checkpoint_age_seconds < 60));
    const conflictDrill = ov.drill_by_tenant[tenantId].find((r) => r.failure_reason_code === "conflict_stale_base_row_version");
    assert.equal(conflictDrill.batch_id, conflict.response.server_batch_id);
    assert.equal(ov.aggregate.dead_letter_total, 0);
    const [{ replay_count }] = await su(
      "SELECT replay_count FROM sync_exchange_idempotency_v2 WHERE idempotency_key = $1",
      [push.body.idempotency_key],
    );
    assert.equal(replay_count, 1);

    // SLO surface uses the same measured dead letters.
    const slo = await api("GET", "/api/v1/ops/observability/slo", admin);
    assert.equal(slo.json.sync_operator_surface.dead_letter_total, 0);
    assert.equal(slo.json.sync_operator_surface.dead_letter_components.conflicts, 1);

    // Platform overview: backups come from backup_runs.
    let platform = await api("GET", "/api/v1/ops/platform-overview", admin);
    let backups = platform.json.platform_services.find((s) => s.service === "backups");
    assert.equal(backups.severity, "critical");
    assert.match(backups.detail, /no successful nightly backup recorded/);
    assert.ok(!platform.json.platform_services.some((s) => s.service === "redis"), "no service that does not exist");
    assert.match(platform.json.platform_services.find((s) => s.service === "postgresql").detail, /round trip [\d.]+ ms/);
    assert.match(platform.json.platform_services.find((s) => s.service === "object_storage").detail, /not configured/);
    await su(
      `INSERT INTO backup_runs (kind, status, offsite_status, started_at, finished_at, detail)
       VALUES ('nightly', 'succeeded', 'disabled', now() - interval '1 hour', now() - interval '1 hour', 'test'),
              ('restore_drill', 'succeeded', 'not_applicable', now(), now(), 'test')`,
    );
    platform = await api("GET", "/api/v1/ops/platform-overview", admin);
    backups = platform.json.platform_services.find((s) => s.service === "backups");
    assert.equal(backups.severity, "warn");
    assert.match(backups.detail, /off-site copy disabled/);
    assert.ok(platform.json.infra_pressure.every((m) => m.trend === "not_tracked"));

    // Rollout diagnostics: only measured buckets.
    const rollout = await api("GET", "/api/v1/ops/rollout-overview", admin);
    assert.deepEqual(rollout.json.diagnostics.map((d) => d.category), ["migration", "post_deploy_heartbeat"]);
    assert.equal(rollout.json.diagnostics.find((d) => d.category === "post_deploy_heartbeat").count_24h, 2);

    // Prometheus endpoint.
    assert.equal((await api("GET", "/api/v1/ops/metrics", null)).status, 401);
    assert.equal((await api("GET", "/api/v1/ops/metrics", "wrong-token")).status, 401);
    for (const token of [admin, SCRAPE_TOKEN]) {
      const m = await api("GET", "/api/v1/ops/metrics", token);
      assert.equal(m.status, 200);
      assert.match(m.contentType, /^text\/plain;/);
      assert.match(m.contentType, /version=0\.0\.4/);
      for (const line of m.text.trim().split("\n")) {
        assert.match(line, /^(# (HELP|TYPE) [a-z0-9_:]+ .+|[a-z0-9_:]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?[\d.e+]+)$/, `bad line: ${line}`);
      }
      assert.match(m.text, new RegExp(`maintafox_sync_rejected_items\\{tenant_id="${tenantId}"\\} 1\\n`));
      assert.match(m.text, new RegExp(`maintafox_sync_device_lag_seconds\\{tenant_id="${tenantId}",machine_id="ops-device-2"\\} 0\\n`));
      assert.match(m.text, /maintafox_backup_last_run_succeeded\{kind="nightly"\} 1\n/);
    }
    const scrapes = await su("SELECT COUNT(*)::int AS c FROM operator_scope_access WHERE actor_id = 'system:metrics-scrape'");
    assert.equal(scrapes[0].c, 1, "scrape-token access is recorded");

    console.log("ops-metrics: all checks passed");
  } catch (err) {
    console.error(serverOutput);
    throw err;
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await once(server, "exit").catch(() => undefined);
    }
    await testPg.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

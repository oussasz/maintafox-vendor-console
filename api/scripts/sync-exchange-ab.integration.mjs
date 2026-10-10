import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";

const port = 33133;
const baseUrl = `http://127.0.0.1:${port}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // continue
    }
    await delay(250);
  }
  throw new Error("control API did not become healthy in time");
}

function equipmentPayload(esid) {
  const payload = {
    entity_sync_id: esid,
    row_version: 1,
    asset_code: "EQ-AB-1",
    asset_name: "A to B Pump",
    status_code: "active_in_service",
  };
  const payload_json = JSON.stringify(payload);
  return {
    payload_json,
    payload_hash: sha256Hex(payload_json),
  };
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
    assert.equal(loginRes.status, 200, "login must succeed");
    const { access_token: adminToken } = await loginRes.json();
    const authHeaders = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };

    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        slug: "sync-ab-tenant",
        display_name: "Sync A/B Tenant",
        rollout_cohort: "pilot-main",
        update_channel: "pilot",
      }),
    });
    assert.equal(tenantRes.status, 201, "tenant create must succeed");
    const tenant = await tenantRes.json();

    const issueRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Idempotency-Key": "sync-ab-issue-1",
      },
      body: JSON.stringify({
        tenant_id: tenant.id,
        max_machines: 4,
        update_channel: "pilot",
        expires_at: "2028-01-01T00:00:00.000Z",
        operator_reason_code: "ONBOARDING",
        operator_rationale: "Sync A/B integration test license.",
      }),
    });
    assert.equal(issueRes.status, 201, "license issue must succeed");
    const issued = await issueRes.json();

    async function claim(fp) {
      const res = await fetch(`${baseUrl}/api/v1/activation/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: issued.license_key,
          machine_fingerprint: fp,
          machine_label: fp,
          app_version: "0.4.0-dev",
        }),
      });
      const text = await res.text();
      assert.equal(res.status, 200, `claim ${fp}: ${text}`);
      const body = JSON.parse(text);
      assert.ok(body.activation_token, "activation_token required");
      return body.activation_token;
    }

    const tokenA = await claim("machine-a-fingerprint-001");
    const tokenB = await claim("machine-b-fingerprint-002");

    const esid = "eq-ab-conv-001";
    const { payload_json, payload_hash } = equipmentPayload(esid);
    const exchangeKey = randomUUID();

    const pushA = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
        "Idempotency-Key": exchangeKey,
      },
      body: JSON.stringify({
        protocol_version: "v1",
        idempotency_key: exchangeKey,
        device_class: "desktop",
        media_manifest: [],
        outbox_batch: [
          {
            idempotency_key: `equipment:${esid}:v1`,
            entity_type: "equipment",
            entity_sync_id: esid,
            operation: "upsert",
            row_version: 1,
            payload_json,
            payload_hash,
          },
        ],
      }),
    });
    const pushAText = await pushA.text();
    assert.equal(pushA.status, 200, `A exchange: ${pushAText}`);
    const aBody = JSON.parse(pushAText);
    assert.equal(aBody.acknowledged_items.length, 1);
    assert.equal(aBody.rejected_items.length, 0);
    assert.ok(aBody.checkpoint_token.startsWith("cp-"));

    const replay = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
        "Idempotency-Key": exchangeKey,
      },
      body: JSON.stringify({
        protocol_version: "v1",
        idempotency_key: exchangeKey,
        device_class: "desktop",
        outbox_batch: [
          {
            idempotency_key: `equipment:${esid}:v1`,
            entity_type: "equipment",
            entity_sync_id: esid,
            operation: "upsert",
            row_version: 1,
            payload_json,
            payload_hash,
          },
        ],
      }),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.server_batch_id, aBody.server_batch_id, "idempotent replay batch id");

    const pullKey = randomUUID();
    const pullB = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenB}`,
        "Content-Type": "application/json",
        "Idempotency-Key": pullKey,
      },
      body: JSON.stringify({
        protocol_version: "v1",
        idempotency_key: pullKey,
        device_class: "desktop",
        outbox_batch: [],
      }),
    });
    const pullBText = await pullB.text();
    assert.equal(pullB.status, 200, `B exchange: ${pullBText}`);
    const bBody = JSON.parse(pullBText);
    assert.ok(bBody.inbound_items.length >= 1, "B must receive inbound from A");
    const inbound = bBody.inbound_items.find((i) => i.entity_sync_id === esid);
    assert.ok(inbound, "equipment inbound present");
    assert.equal(inbound.entity_type, "equipment");
    assert.match(inbound.payload_json, /EQ-AB-1/);

    const badKey = randomUUID();
    const cpBeforeReject = bBody.checkpoint_token;
    const badPush = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Content-Type": "application/json",
        "Idempotency-Key": badKey,
      },
      body: JSON.stringify({
        protocol_version: "v1",
        idempotency_key: badKey,
        checkpoint_token: cpBeforeReject,
        device_class: "desktop",
        outbox_batch: [
          {
            idempotency_key: "equipment:bad-hash:v1",
            entity_type: "equipment",
            entity_sync_id: "eq-bad-hash",
            operation: "upsert",
            row_version: 1,
            payload_json: '{"entity_sync_id":"eq-bad-hash"}',
            payload_hash: "0000000000000000000000000000000000000000000000000000000000000000",
          },
        ],
      }),
    });
    const badText = await badPush.text();
    assert.equal(badPush.status, 200, `bad hash exchange: ${badText}`);
    const badBody = JSON.parse(badText);
    assert.equal(badBody.rejected_items.length, 1);
    assert.equal(badBody.acknowledged_items.length, 0);
    assert.equal(
      badBody.checkpoint_token,
      cpBeforeReject,
      "checkpoint must not advance on permanent rejects",
    );

    console.log("sync-exchange-ab: OK");
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

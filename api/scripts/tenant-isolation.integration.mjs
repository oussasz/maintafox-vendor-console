/**
 * Tenant isolation (row-level security, migration 007) and encryption at rest of sensitive sync
 * payloads, against a real Postgres and the real API (master plan Phase 3.2).
 *
 * Proves, at the database level (the API's own Database class, i.e. the role mfx_app):
 *   - every table with a tenant_id column has row-level security;
 *   - a query without a tenant/operator setting sees no row of any protected table;
 *   - in tenant A's scope, queries without any WHERE see only A's rows, and A cannot read,
 *     update or insert B's rows;
 *   - an operator scope sees all tenants and is recorded in operator_scope_access;
 *   - the scope cannot be switched inside an open transaction.
 * And through HTTP:
 *   - devices keep working (activation through the licence-key lookup, exchange, snapshot);
 *   - user_accounts payloads and stored exchange responses are encrypted at rest (no plaintext
 *     in the tables), yet delivered byte-exact so payload_hash still verifies, also on replay;
 *   - a sealed value does not open for another row (authenticated data);
 *   - plaintext rows written before encryption existed are sealed at the next startup.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";

import pg from "pg";

import { openOperatorScope, tenantScope } from "../dist/app/scope.js";
import { openDatabase } from "../dist/db/database.js";
import { PayloadCipher } from "../dist/sync/payload-crypto.js";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { loginAccessToken } from "./lib/vendor-session.mjs";

const port = 33171;
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let databaseUrl = "";
let server = null;
let serverOutput = "";

async function startApi() {
  serverOutput = "";
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

async function stopApi() {
  if (!server) return;
  const p = server;
  server = null;
  p.kill("SIGTERM");
  await once(p, "exit").catch(() => undefined);
}

/** Superuser connection (bypasses row-level security): the ground truth of what is stored. */
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
    json = { raw: text };
  }
  return { status: res.status, json };
}

function item(entityType, entitySyncId, payload, baseRowVersion = null) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: baseRowVersion === null ? "create" : "update",
    row_version: baseRowVersion === null ? 1 : baseRowVersion + 1,
    base_row_version: baseRowVersion,
    payload_json,
    payload_hash: sha256Hex(payload_json),
  };
}

async function exchange(dev, outbox = [], idempotencyKey = `ex-${randomUUID()}`) {
  const body = {
    protocol_version: "v2",
    idempotency_key: idempotencyKey,
    checkpoint_token: dev.checkpoint,
    current_user_sync_ids: [],
    device_class: "desktop",
    outbox_batch: outbox,
  };
  const r = await api("POST", "/api/v1/sync/exchange", dev.token, body);
  assert.equal(r.status, 200, `exchange failed: ${JSON.stringify(r.json)}`);
  dev.checkpoint = r.json.checkpoint_token;
  return { response: r.json, body };
}

async function main() {
  const testPg = await startTestPostgres();
  databaseUrl = await testPg.createDatabase();
  try {
    await startApi();
    const admin = await loginAccessToken(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const tenants = {};
    for (const name of ["alpha", "beta"]) {
      const t = await api("POST", "/api/v1/tenants", admin, { slug: `iso-${name}`, display_name: `Isolation ${name}` });
      assert.equal(t.status, 201);
      const l = await api("POST", "/api/v1/licenses", admin, { tenant_id: t.json.id, max_machines: 3 });
      assert.equal(l.status, 201);
      const devices = [];
      for (const n of [1, 2]) {
        // Activation presents only the licence key: tenant found through mfx_license_key_tenant.
        const c = await api("POST", "/api/v1/activation/claim", null, {
          license_key: l.json.license_key,
          machine_fingerprint: `${name}-device-${n}`,
          app_version: "1.0.0",
        });
        assert.equal(c.status, 200, JSON.stringify(c.json));
        assert.equal(c.json.tenant_id, t.json.id);
        devices.push({ token: c.json.activation_token, checkpoint: null });
      }
      tenants[name] = { id: t.json.id, licenseId: l.json.id, devices };
    }
    const unknown = await api("POST", "/api/v1/activation/preview", null, {
      license_key: "MFX-00000000-00000000",
      machine_fingerprint: "nobody-device",
    });
    assert.equal(unknown.status, 404, "an unknown licence key finds nothing");

    // Sync data for both tenants; alpha also pushes a user account (sensitive).
    const secretMarker = `pw-hash-${randomUUID()}`;
    const account = item("user_accounts", "ua-1", { username: "tech1", password_hash: secretMarker });
    const pushA = await exchange(tenants.alpha.devices[0], [account, item("equipment", "eq-a", { name: "Pump A" })]);
    assert.equal(pushA.response.acknowledged_items.length, 2, JSON.stringify(pushA.response));
    await exchange(tenants.beta.devices[0], [item("equipment", "eq-b", { name: "Pump B" })]);

    // ── Database level, as the API role ───────────────────────────────────────
    const db = await openDatabase(databaseUrl, "tenant-isolation-test");
    try {
      const unprotected = await su(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
         WHERE c.relkind = 'r' AND NOT c.relrowsecurity`,
      );
      assert.deepEqual(unprotected, [], "every table with a tenant_id column has row-level security");
      const protectedTables = (
        await su("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity ORDER BY relname")
      ).map((r) => r.relname);
      for (const t of ["tenants", "license_keys", "machine_activations", "sync_entity_state", "sync_mirror_ingress", "audit_records", "payment_orders"]) {
        assert.ok(protectedTables.includes(t), `${t} is protected`);
      }

      // No scope: every protected table looks empty although the data exists.
      for (const t of protectedTables) {
        const [{ c }] = await db.all(`SELECT COUNT(*)::int AS c FROM ${t}`);
        assert.equal(c, 0, `${t} must look empty without a tenant or operator setting`);
      }
      assert.ok((await su("SELECT COUNT(*)::int AS c FROM license_keys"))[0].c >= 2, "data exists (superuser view)");

      // Tenant A scope, queries without WHERE.
      const A = tenants.alpha.id;
      const B = tenants.beta.id;
      await db.runInScope(tenantScope(A), async () => {
        const lic = await db.all("SELECT tenant_id FROM license_keys");
        assert.deepEqual([...new Set(lic.map((r) => r.tenant_id))], [A]);
        const ten = await db.all("SELECT id FROM tenants");
        assert.deepEqual(ten.map((r) => r.id), [A]);
        const state = await db.all("SELECT DISTINCT tenant_id FROM sync_entity_state");
        assert.deepEqual(state.map((r) => r.tenant_id), [A]);
        assert.equal((await db.all("SELECT * FROM sync_entity_state WHERE tenant_id = $1", B)).length, 0, "A cannot read B");
        assert.equal((await db.all("SELECT * FROM machine_activations WHERE tenant_id = $1", B)).length, 0);
        assert.equal((await db.all("SELECT * FROM audit_records")).length, 0, "the cross-tenant ledger is operator-only");
        // A bulk update without WHERE touches A only.
        const upd = await db.run("UPDATE license_keys SET max_machines = 7");
        assert.equal(upd.changes, 1);
        // Writing a row for B is refused by the policy's WITH CHECK.
        await assert.rejects(
          db.run(
            `INSERT INTO sync_rejection_log (tenant_id, idempotency_key, entity_sync_id, rejection_code, rejection_message, created_at_rfc3339)
             VALUES ($1, 'k', 'e', 'c', 'm', 'now')`,
            B,
          ),
          /row-level security/,
        );
        // Changing scope inside an open transaction is refused.
        await assert.rejects(
          db.tx(() => db.runInScope(tenantScope(B), () => db.all("SELECT 1"))),
          /cannot change inside an open transaction/,
        );
      });
      const [bLicence] = await su("SELECT max_machines FROM license_keys WHERE tenant_id = $1", [B]);
      assert.equal(bLicence.max_machines, 3, "B's licence was not touched by A's bulk update");

      // Operator scope: explicit, recorded, sees every tenant.
      const before = (await su("SELECT COUNT(*)::int AS c FROM operator_scope_access WHERE actor_id = 'system:isolation-test'"))[0].c;
      const op = await openOperatorScope(db, "system:isolation-test");
      const seen = await db.runInScope(op, () => db.all("SELECT DISTINCT tenant_id FROM license_keys ORDER BY tenant_id"));
      assert.deepEqual(seen.map((r) => r.tenant_id).sort(), [A, B].sort());
      const after = (await su("SELECT COUNT(*)::int AS c FROM operator_scope_access WHERE actor_id = 'system:isolation-test'"))[0].c;
      assert.equal(after, before + 1, "the operator scope was recorded");
      // Console requests are recorded with the operator and the route.
      const consoleRows = await su("SELECT actor_id, method, path FROM operator_scope_access WHERE path = '/api/v1/tenants' AND method = 'POST'");
      assert.ok(consoleRows.length >= 2 && consoleRows.every((r) => /^user_\d+$/.test(r.actor_id)));
    } finally {
      await db.close();
    }

    // ── Encryption at rest ───────────────────────────────────────────────────
    const [stateRow] = await su("SELECT payload_raw, payload_json FROM sync_entity_state WHERE entity_type = 'user_accounts'");
    assert.match(stateRow.payload_raw, /^mfxenc:v1:/);
    assert.equal(stateRow.payload_json, null, "no queryable plaintext copy");
    const [logRow] = await su("SELECT payload_json, payload_hash FROM sync_mirror_ingress WHERE entity_type = 'user_accounts'");
    assert.match(logRow.payload_json, /^mfxenc:v1:/);
    assert.equal(logRow.payload_hash, account.payload_hash, "the hash of the plaintext is kept");
    const responses = await su("SELECT response_json FROM sync_exchange_idempotency_v2");
    assert.ok(responses.length >= 2 && responses.every((r) => r.response_json.startsWith("mfxenc:v1:")));
    for (const t of ["sync_entity_state", "sync_mirror_ingress", "sync_exchange_idempotency_v2"]) {
      const hits = await su(`SELECT COUNT(*)::int AS c FROM ${t} WHERE ${t}::text LIKE $1`, [`%${secretMarker}%`]);
      assert.equal(hits[0].c, 0, `no plaintext of the sensitive payload in ${t}`);
    }
    const [equipmentRow] = await su("SELECT payload_raw FROM sync_entity_state WHERE entity_type = 'equipment' AND entity_sync_id = 'eq-a'");
    assert.equal(equipmentRow.payload_raw, JSON.stringify({ name: "Pump A" }), "non-sensitive payloads stay readable");

    // Delivery: the other alpha device receives the exact bytes; the hash verifies.
    const peer = tenants.alpha.devices[1];
    const pulled = await exchange(peer);
    const got = pulled.response.inbound_items.find((i) => i.entity_type === "user_accounts");
    assert.ok(got, "the account is delivered to the tenant's other device");
    assert.equal(got.payload_json, account.payload_json);
    assert.equal(sha256Hex(got.payload_json), got.payload_hash);
    // Replay of a stored (encrypted) response returns the same response.
    const replay = await api("POST", "/api/v1/sync/exchange", peer.token, pulled.body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.json, pulled.response);
    // Snapshot delivers it decrypted too.
    const snap = await api("POST", "/api/v1/sync/snapshot", peer.token, {
      protocol_version: "v2",
      page_token: null,
      page_size: 100,
      scope: "all",
      current_user_sync_ids: [],
    });
    assert.equal(snap.status, 200);
    assert.equal(snap.json.items.find((i) => i.entity_type === "user_accounts").payload_json, account.payload_json);
    // A conflict returns the server row decrypted.
    const stale = item("user_accounts", "ua-1", { username: "tech1", password_hash: "other" });
    const conflict = await exchange(tenants.alpha.devices[1], [stale]);
    assert.equal(conflict.response.conflict_items[0].server_payload_json, account.payload_json);
    // Beta never sees alpha's rows.
    const betaPull = await exchange(tenants.beta.devices[1]);
    assert.ok(betaPull.response.inbound_items.every((i) => i.entity_sync_id !== "ua-1" && i.entity_sync_id !== "eq-a"));

    // Authenticated data: a sealed value moved to another row does not open.
    const cipher = new PayloadCipher(Buffer.from(TEST_SYNC_ENV.SYNC_PAYLOAD_ENCRYPTION_KEY, "base64"));
    const sealed = cipher.seal("x", "entity|t1|user_accounts|a");
    assert.equal(cipher.open(sealed, "entity|t1|user_accounts|a"), "x");
    assert.throws(() => cipher.open(sealed, "entity|t2|user_accounts|a"));
    assert.throws(() => new PayloadCipher(Buffer.alloc(32, 1)).open(sealed, "entity|t1|user_accounts|a"), /uses key/);

    // Rows written before encryption existed are sealed at the next startup.
    await stopApi();
    const legacyPayload = JSON.stringify({ username: "legacy", password_hash: `legacy-${secretMarker}` });
    await su(
      `INSERT INTO sync_entity_state (tenant_id, entity_type, entity_sync_id, row_version, operation, payload_raw, payload_json,
         payload_hash, deleted, owner_user_sync_id, origin_machine_fingerprint, last_ingress_id, updated_at)
       VALUES ($1, 'user_accounts', 'ua-legacy', 1, 'create', $2::text, ($2::text)::jsonb, $3, false, NULL, 'old-device', 999999, now())`,
      [tenants.alpha.id, legacyPayload, sha256Hex(legacyPayload)],
    );
    await startApi();
    const [legacy] = await su("SELECT payload_raw, payload_json FROM sync_entity_state WHERE entity_sync_id = 'ua-legacy'");
    assert.match(legacy.payload_raw, /^mfxenc:v1:/);
    assert.equal(legacy.payload_json, null);
    assert.match(serverOutput, /sync_data_sealed_at_rest/);

    // A missing or malformed key stops the API.
    await stopApi();
    const bad = spawn(process.execPath, ["dist/index.js"], {
      env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, ...TEST_SYNC_ENV, SYNC_PAYLOAD_ENCRYPTION_KEY: Buffer.from("too-short").toString("base64"),
        JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345", ...TEST_ENTITLEMENT_SIGNING_ENV, CORS_ORIGIN: "http://localhost:5174" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let badOut = "";
    bad.stderr.on("data", (b) => (badOut += String(b)));
    const [code] = await once(bad, "exit");
    assert.notEqual(code, 0);
    assert.match(badOut, /SYNC_PAYLOAD_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes/);

    console.log("tenant-isolation: all checks passed");
  } catch (err) {
    console.error(serverOutput);
    throw err;
  } finally {
    await stopApi();
    await testPg.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

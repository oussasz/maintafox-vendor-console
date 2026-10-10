/**
 * Sync protocol v2 against a real Postgres (deploy/SYNC_PROTOCOL_V2.md).
 *
 * Covers: entity registry and owner rules, create/delivery, conflict on a stale base_row_version
 * (never applied), row-version rule, tombstone delivery, exchange replay and key reuse (409), item
 * duplicates, starvation (>300 own rows, v1 and v2), inbound paging, snapshot paging and token
 * binding, per-user scoping and user_snapshot_required, checkpoint tamper / cross-device /
 * ahead-of-server, concurrent exchanges from two devices, a failure at the last statement and a
 * process kill mid-transaction (no partial state), media manifest / tenant_config validation,
 * retention, and tenant delete purging every sync table.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";

import pg from "pg";

import { openDatabase } from "../dist/db/database.js";
import { runSyncRetention } from "../dist/sync/retention.js";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const port = 33151;
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let databaseUrl = "";
let server = null;
let serverOutput = "";

function startApi() {
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
}

async function stopApi(signal = "SIGTERM") {
  if (!server) return;
  const proc = server;
  server = null;
  proc.kill(signal);
  await once(proc, "exit").catch(() => undefined);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
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

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

function item(entityType, entitySyncId, rowVersion, baseRowVersion, payload, extra = {}) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: extra.idempotency_key ?? randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: extra.operation ?? (baseRowVersion === null ? "create" : "update"),
    row_version: rowVersion,
    base_row_version: baseRowVersion,
    ...(extra.owner ? { owner_user_sync_id: extra.owner } : {}),
    payload_json,
    payload_hash: sha256Hex(payload_json),
  };
}

/** A device: its activation token, its last checkpoint and the users it reports. */
function device(token, users = []) {
  return { token, checkpoint: null, users };
}

async function exchangeRaw(dev, body) {
  const res = await fetch(`${baseUrl}/api/v1/sync/exchange`, {
    method: "POST",
    headers: { Authorization: `Bearer ${dev.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

function v2Body(dev, outbox = [], extra = {}) {
  return {
    protocol_version: "v2",
    idempotency_key: extra.idempotency_key ?? `ex-${randomUUID()}`,
    checkpoint_token: extra.checkpoint_token !== undefined ? extra.checkpoint_token : dev.checkpoint,
    current_user_sync_ids: extra.users ?? dev.users,
    device_class: "desktop",
    outbox_batch: outbox,
    ...(extra.tenant_config !== undefined ? { tenant_config: extra.tenant_config } : {}),
    ...(extra.media_manifest !== undefined ? { media_manifest: extra.media_manifest } : {}),
  };
}

/** One v2 exchange that must succeed; stores the new checkpoint on the device. */
async function exchange(dev, outbox = [], extra = {}) {
  const r = await exchangeRaw(dev, v2Body(dev, outbox, extra));
  assert.equal(r.status, 200, `exchange failed: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.protocol_version, "v2");
  dev.checkpoint = r.json.checkpoint_token;
  return r.json;
}

/** Pulls until has_more is false; returns every inbound item. */
async function pullAll(dev) {
  const all = [];
  for (let i = 0; i < 100; i += 1) {
    const res = await exchange(dev);
    all.push(...res.inbound_items);
    if (!res.has_more) return all;
  }
  throw new Error("pullAll did not converge");
}

async function snapshotRaw(dev, body) {
  const res = await fetch(`${baseUrl}/api/v1/sync/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${dev.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Runs a full paged snapshot; returns { items, checkpoint }. */
async function snapshotAll(dev, scope, pageSize) {
  const items = [];
  let pageToken = null;
  for (let i = 0; i < 1000; i += 1) {
    const r = await snapshotRaw(dev, {
      protocol_version: "v2",
      page_token: pageToken,
      page_size: pageSize,
      scope,
      current_user_sync_ids: dev.users,
    });
    assert.equal(r.status, 200, `snapshot failed: ${JSON.stringify(r.json)}`);
    items.push(...r.json.items);
    if (!r.json.has_more) {
      assert.ok(r.json.checkpoint_token, "the last snapshot page carries a checkpoint");
      return { items, checkpoint: r.json.checkpoint_token };
    }
    assert.equal(r.json.checkpoint_token, null);
    pageToken = r.json.next_page_token;
  }
  throw new Error("snapshot did not converge");
}

/** Signs a v2 checkpoint with the test secret (simulates a token issued before a server restore). */
function forgeCheckpoint(tenantId, fingerprint, seq) {
  const payloadPart = Buffer.from(
    JSON.stringify({ k: "cp", t: tenantId, d: fingerprint, s: seq, i: new Date().toISOString() }),
  ).toString("base64url");
  const sig = createHmac("sha256", TEST_SYNC_ENV.SYNC_CHECKPOINT_SECRET).update(`v2.${payloadPart}`).digest("base64url");
  return `v2.${payloadPart}.${sig}`;
}

function flipLastChar(s) {
  return `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
}

async function run() {
  const testPg = await startTestPostgres();
  databaseUrl = await testPg.createDatabase();
  startApi();
  try {
    await waitForHealth();

    // ── Tenant, licence, four devices ─────────────────────────────────────────────────────
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const admin = { Authorization: `Bearer ${(await login.json()).access_token}`, "Content-Type": "application/json" };
    const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ slug: "sync-v2-tenant", display_name: "Sync v2 Tenant" }),
    });
    assert.equal(tenantRes.status, 201);
    const tenant = await tenantRes.json();
    const licRes = await fetch(`${baseUrl}/api/v1/licenses`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ tenant_id: tenant.id, max_machines: 5, expires_at: "2099-01-01T00:00:00.000Z" }),
    });
    assert.equal(licRes.status, 201);
    const licence = await licRes.json();
    const claim = async (fp) => {
      const res = await fetch(`${baseUrl}/api/v1/activation/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: licence.license_key, machine_fingerprint: fp, app_version: "0.5.0" }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()).activation_token;
    };
    const FP_A = "fp-v2-device-a";
    const FP_B = "fp-v2-device-b";
    const FP_C = "fp-v2-device-c";
    const A = device(await claim(FP_A));
    const B = device(await claim(FP_B));
    const C = device(await claim(FP_C));
    const V1 = device(await claim("fp-v1-device-d"));

    // ── Registry and owner rules ──────────────────────────────────────────────────────────
    {
      const res = await exchange(A, [
        item("not_a_registered_type", "x-1", 1, null, { a: 1 }),
        item("user_dismissals", "ud-0", 1, null, { a: 1 }),
        item("equipment", "eq-owned", 1, null, { a: 1 }, { owner: "user-1" }),
        item("Equipment", "bad-format", 1, null, { a: 1 }),
      ]);
      assert.deepEqual(
        res.rejected_items.map((r) => r.rejection_code),
        ["unknown_entity_type", "missing_owner_user_sync_id", "unexpected_owner_user_sync_id", "invalid_entity_type"],
      );
      assert.equal(res.acknowledged_items.length, 0);
    }

    // ── Create, delivery, row-version rule ────────────────────────────────────────────────
    const eq1v1 = item("equipment", "eq-1", 1, null, { code: "EQ-1", name: "Pump" });
    {
      const res = await exchange(A, [eq1v1, item("equipment", "eq-bad-rv", 4, 2, { x: 1 })]);
      assert.equal(res.acknowledged_items.length, 1);
      assert.equal(res.acknowledged_items[0].duplicate, false);
      assert.ok(res.acknowledged_items[0].server_seq > 0);
      assert.equal(res.rejected_items[0].rejection_code, "invalid_row_version");
      assert.equal(res.inbound_items.length, 0, "a device never receives its own rows");
    }
    {
      const inbound = await pullAll(B);
      const got = inbound.find((i) => i.entity_sync_id === "eq-1");
      assert.ok(got, "B receives A's create");
      assert.equal(got.row_version, 1);
      assert.equal(got.payload_json, eq1v1.payload_json, "payload is delivered byte-exact");
      assert.equal(got.payload_hash, sha256Hex(got.payload_json));
      assert.equal(got.deleted, false);
    }

    // ── Conflicts: a stale base and a create over an existing row are never applied ───────
    const eq1v2B = item("equipment", "eq-1", 2, 1, { code: "EQ-1", name: "Pump (B)" });
    assert.equal((await exchange(B, [eq1v2B])).acknowledged_items.length, 1);
    {
      const staleA = item("equipment", "eq-1", 2, 1, { code: "EQ-1", name: "Pump (A)" });
      const res = await exchange(A, [staleA]);
      assert.equal(res.acknowledged_items.length, 0);
      assert.equal(res.conflict_items.length, 1);
      const c = res.conflict_items[0];
      assert.equal(c.idempotency_key, staleA.idempotency_key);
      assert.equal(c.local_row_version, 2);
      assert.equal(c.local_base_row_version, 1);
      assert.equal(c.server_row_version, 2);
      assert.equal(c.server_operation, "update");
      assert.equal(c.server_payload_json, eq1v2B.payload_json);
      assert.equal(c.server_payload_hash, eq1v2B.payload_hash);
      assert.equal(c.server_deleted, false);
      assert.ok(
        res.inbound_items.some((i) => i.entity_sync_id === "eq-1" && i.row_version === 2),
        "A still receives B's version",
      );
      const createOver = await exchange(C, [item("equipment", "eq-1", 1, null, { code: "dup" })]);
      assert.equal(createOver.conflict_items.length, 1, "a create over an existing entity is a conflict");
      const [state] = await sql(
        "SELECT row_version, payload_raw FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id = 'eq-1'",
        [tenant.id],
      );
      assert.equal(Number(state.row_version), 2);
      assert.equal(state.payload_raw, eq1v2B.payload_json, "the conflicting edits were not applied");
      const [logged] = await sql("SELECT COUNT(*)::int AS c FROM sync_conflict_log WHERE tenant_id = $1", [tenant.id]);
      assert.equal(logged.c, 2);
    }

    // ── Tombstone delivery ────────────────────────────────────────────────────────────────
    {
      const del = item("equipment", "eq-1", 3, 2, { code: "EQ-1", deleted: true }, { operation: "delete" });
      assert.equal((await exchange(B, [del])).acknowledged_items.length, 1);
      const inbound = await pullAll(A);
      const tomb = inbound.find((i) => i.entity_sync_id === "eq-1");
      assert.ok(tomb, "A receives the delete");
      assert.equal(tomb.operation, "delete");
      assert.equal(tomb.deleted, true);
      assert.equal(tomb.row_version, 3);
    }

    // ── Exchange replay, key reuse (409), item duplicates ─────────────────────────────────
    {
      const body = v2Body(A, [item("equipment", "eq-2", 1, null, { code: "EQ-2" })], { idempotency_key: "replay-key-0001" });
      const first = await exchangeRaw(A, body);
      assert.equal(first.status, 200);
      const second = await exchangeRaw(A, body);
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-idempotent-replay"), "true");
      assert.deepEqual(second.json, first.json, "replay returns the stored response unchanged");
      const { device_class, ...withoutClass } = body;
      const reordered = await exchangeRaw(A, { device_class, ...withoutClass });
      assert.equal(reordered.status, 200, "the request hash ignores key order");
      const changed = await exchangeRaw(A, { ...body, outbox_batch: [] });
      assert.equal(changed.status, 409);
      assert.equal(changed.json.error, "idempotency_key_reused");
      const otherDevice = await exchangeRaw(B, { ...body, checkpoint_token: B.checkpoint, outbox_batch: [] });
      assert.equal(otherDevice.status, 200, "idempotency keys are scoped per device");
      B.checkpoint = otherDevice.json.checkpoint_token;
      A.checkpoint = first.json.checkpoint_token;
      // Re-sending an applied item in a new exchange is a duplicate ack, not a second write.
      const again = await exchange(A, [body.outbox_batch[0]]);
      assert.equal(again.acknowledged_items[0].duplicate, true);
      assert.equal(again.acknowledged_items[0].server_seq, first.json.acknowledged_items[0].server_seq);
      const mutated = { ...body.outbox_batch[0], payload_json: '{"code":"other"}' };
      mutated.payload_hash = sha256Hex(mutated.payload_json);
      const reused = await exchange(A, [mutated]);
      assert.equal(reused.rejected_items[0].rejection_code, "item_idempotency_key_reused");
      const inBatch = item("equipment", "eq-3", 1, null, { code: "EQ-3" });
      const dupBatch = await exchange(A, [inBatch, inBatch]);
      assert.equal(dupBatch.acknowledged_items.length, 1);
      assert.equal(dupBatch.rejected_items[0].rejection_code, "duplicate_item_in_batch");
    }

    // ── Starvation: >300 own rows never stall a device (v2 and v1) ────────────────────────
    {
      await pullAll(A);
      const own = Array.from({ length: 350 }, (_, i) => item("work_orders", `wo-own-${i}`, 1, null, { n: i }));
      assert.equal((await exchange(A, own)).acknowledged_items.length, 350);
      await exchange(B, [item("work_orders", "wo-from-b", 1, null, { from: "B" })]);
      assert.deepEqual(
        (await pullAll(A)).map((i) => i.entity_sync_id),
        ["wo-from-b"],
        "A gets B's row past its own 350",
      );

      const v1 = async (outbox) => {
        const res = await exchangeRaw(V1, {
          protocol_version: "v1",
          idempotency_key: `v1-${randomUUID()}`,
          checkpoint_token: null,
          outbox_batch: outbox.map(({ base_row_version, owner_user_sync_id, ...rest }) => rest),
        });
        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.equal(res.json.protocol_version, "v1");
        return res.json;
      };
      for (let i = 0; i < 20; i += 1) {
        if ((await v1([])).inbound_items.length === 0) break;
      }
      await v1(Array.from({ length: 350 }, (_, i) => item("work_orders", `wo-v1-own-${i}`, 1, null, { n: i })));
      await exchange(B, [item("work_orders", "wo-for-v1", 1, null, { from: "B" })]);
      assert.ok(
        (await v1([])).inbound_items.some((i) => i.entity_sync_id === "wo-for-v1"),
        "a v1 device is not starved by its own 350 rows",
      );
      const seenByB = await pullAll(B);
      assert.equal(seenByB.filter((i) => i.entity_sync_id.startsWith("wo-v1-own-")).length, 350, "v1 writes reach v2 devices");
    }

    // ── Inbound paging (100 per response, has_more) ───────────────────────────────────────
    {
      await pullAll(C);
      await exchange(B, Array.from({ length: 250 }, (_, i) => item("articles", `art-${i}`, 1, null, { n: i })));
      const sizes = [];
      const seen = new Set();
      for (;;) {
        const res = await exchange(C);
        sizes.push(res.inbound_items.length);
        for (const i of res.inbound_items) seen.add(i.entity_sync_id);
        if (!res.has_more) break;
      }
      assert.deepEqual(sizes, [100, 100, 50]);
      assert.equal(seen.size, 250);
    }

    // ── Per-user scoping and user_snapshot_required ───────────────────────────────────────
    {
      A.users = ["user-1"];
      await pullAll(A);
      await exchange(A, [item("user_dismissals", "ud-1", 1, null, { banner: "x" }, { owner: "user-1" })]);
      assert.ok(!(await pullAll(B)).some((i) => i.entity_sync_id === "ud-1"), "B (no user-1) does not receive it");
      C.users = ["user-1"];
      const first = await exchange(C);
      assert.deepEqual(first.user_snapshot_required, ["user-1"], "first time C reports user-1");
      const cInbound = [...first.inbound_items, ...(first.has_more ? await pullAll(C) : [])];
      assert.ok(cInbound.some((i) => i.entity_sync_id === "ud-1" && i.owner_user_sync_id === "user-1"));
      assert.deepEqual((await exchange(C)).user_snapshot_required, [], "reported once");
      // B learns user-1 after the item was written: it is not in B's delta, a user snapshot has it.
      B.users = ["user-1"];
      const late = await exchange(B);
      assert.deepEqual(late.user_snapshot_required, ["user-1"]);
      assert.ok(!late.inbound_items.some((i) => i.entity_sync_id === "ud-1"));
      const userSnap = await snapshotAll(B, "user", 10);
      assert.deepEqual(userSnap.items.map((i) => i.entity_sync_id), ["ud-1"]);
    }

    // ── Snapshot paging and page-token binding ────────────────────────────────────────────
    {
      const D = device(C.token, ["user-1"]);
      const snap = await snapshotAll(D, "all", 37);
      const ids = snap.items.map((i) => `${i.entity_type}/${i.entity_sync_id}`);
      assert.equal(new Set(ids).size, ids.length, "no duplicates across pages");
      const [expected] = await sql(
        `SELECT COUNT(*)::int AS c FROM sync_entity_state
         WHERE tenant_id = $1 AND NOT deleted AND (owner_user_sync_id IS NULL OR owner_user_sync_id = 'user-1')`,
        [tenant.id],
      );
      assert.equal(snap.items.length, expected.c, "the snapshot returns every live row");
      assert.ok(!ids.includes("equipment/eq-1"), "tombstones are not in a snapshot");
      D.checkpoint = snap.checkpoint;
      assert.equal((await exchange(D)).inbound_items.length, 0, "nothing new right after the snapshot");
      await exchange(B, [item("equipment", "eq-after-snap", 1, null, { late: true })]);
      assert.deepEqual((await pullAll(D)).map((i) => i.entity_sync_id), ["eq-after-snap"]);

      const page1 = await snapshotRaw(D, {
        protocol_version: "v2",
        page_token: null,
        page_size: 5,
        scope: "all",
        current_user_sync_ids: ["user-1"],
      });
      const token = page1.json.next_page_token;
      assert.ok(token);
      for (const [label, dev, body] of [
        ["tampered", D, { page_token: flipLastChar(token), scope: "all", current_user_sync_ids: ["user-1"] }],
        ["scope changed", D, { page_token: token, scope: "user", current_user_sync_ids: ["user-1"] }],
        ["users changed", D, { page_token: token, scope: "all", current_user_sync_ids: [] }],
        ["other device", A, { page_token: token, scope: "all", current_user_sync_ids: ["user-1"] }],
      ]) {
        const r = await snapshotRaw(dev, { protocol_version: "v2", page_size: 5, ...body });
        assert.equal(r.status, 400, label);
        assert.equal(r.json.error, "invalid_page_token", label);
      }
    }

    // ── Checkpoint token checks ───────────────────────────────────────────────────────────
    {
      const [, payloadPart, sig] = A.checkpoint.split(".");
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
      payload.s = 0;
      const tamperedPayload = `v2.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
      for (const [label, token] of [
        ["tampered payload", tamperedPayload],
        ["tampered signature", flipLastChar(A.checkpoint)],
        ["other device", B.checkpoint],
        ["v1 token", `cp-${tenant.id}-3`],
        ["garbage", "not-a-token"],
      ]) {
        const r = await exchangeRaw(A, v2Body(A, [], { checkpoint_token: token }));
        assert.equal(r.status, 400, label);
        assert.equal(r.json.error, "invalid_checkpoint_token", label);
      }
      const ahead = await exchangeRaw(A, v2Body(A, [], { checkpoint_token: forgeCheckpoint(tenant.id, FP_A, 10_000_000) }));
      assert.equal(ahead.status, 409);
      assert.equal(ahead.json.error, "checkpoint_ahead_of_server");
    }

    // ── tenant_config and media_manifest are validated and stored ─────────────────────────
    {
      const mismatch = await exchangeRaw(
        A,
        v2Body(A, [], { tenant_config: { tenant_id: "tenant_other", is_activated: true, company_display_name: null } }),
      );
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.json.error, "tenant_config_mismatch");
      const malformed = await exchangeRaw(
        A,
        v2Body(A, [], { media_manifest: [{ entity_sync_id: "m1", content_sha256: "xyz", object_key: "k", byte_size: 1 }] }),
      );
      assert.equal(malformed.status, 400);
      assert.equal(malformed.json.error, "media_manifest_invalid");
      const foreign = await exchangeRaw(
        A,
        v2Body(A, [], {
          media_manifest: [{ entity_sync_id: "m1", content_sha256: sha256Hex("m"), object_key: "prod/media/tenant_other/x/y/z", byte_size: 1 }],
        }),
      );
      assert.equal(foreign.json.error, "media_manifest_invalid");
      const sha = sha256Hex("media-bytes");
      await exchange(A, [], {
        tenant_config: { tenant_id: tenant.id, is_activated: true, company_display_name: "Acme" },
        media_manifest: [{ entity_sync_id: "media-1", content_sha256: sha, object_key: `prod/media/${tenant.id}/work_orders/wo-1/${sha}`, byte_size: 11 }],
      });
      const [profile] = await sql(
        "SELECT device_class, tenant_config_json FROM sync_device_checkpoint WHERE tenant_id = $1 AND machine_fingerprint = $2",
        [tenant.id, FP_A],
      );
      assert.equal(profile.device_class, "desktop");
      assert.equal(JSON.parse(profile.tenant_config_json).company_display_name, "Acme");
      const [media] = await sql("SELECT byte_size FROM sync_media_manifest WHERE tenant_id = $1 AND entity_sync_id = 'media-1'", [tenant.id]);
      assert.equal(Number(media.byte_size), 11);
    }

    // ── Concurrent exchanges from two devices ─────────────────────────────────────────────
    {
      await exchange(A, [item("equipment", "eq-race", 1, null, { v: 0 })]);
      await pullAll(B);
      const fromA = [
        item("equipment", "eq-race", 2, 1, { by: "A" }),
        ...Array.from({ length: 60 }, (_, i) => item("articles", `race-a-${i}`, 1, null, { i })),
      ];
      const fromB = [
        item("equipment", "eq-race", 2, 1, { by: "B" }),
        ...Array.from({ length: 60 }, (_, i) => item("articles", `race-b-${i}`, 1, null, { i })),
      ];
      const [ra, rb] = await Promise.all([exchange(A, fromA), exchange(B, fromB)]);
      const won = [ra, rb].filter((r) => r.acknowledged_items.some((a) => a.entity_sync_id === "eq-race"));
      const lost = [ra, rb].filter((r) => r.conflict_items.some((c) => c.entity_sync_id === "eq-race"));
      assert.equal(won.length, 1, "exactly one device wins the concurrent edit");
      assert.equal(lost.length, 1, "the other one gets a conflict");
      assert.equal(ra.acknowledged_items.length + rb.acknowledged_items.length, 121);
      const seqs = [...ra.acknowledged_items, ...rb.acknowledged_items].map((a) => a.server_seq);
      assert.equal(new Set(seqs).size, seqs.length, "server_seq values are unique");
      const cAll = await pullAll(C);
      assert.equal(cAll.filter((i) => i.entity_sync_id.startsWith("race-")).length, 120, "a third device sees both batches");
    }

    // ── A failure at the last statement and a process kill keep nothing ───────────────────
    {
      await sql(`CREATE FUNCTION test_fail_on_marker() RETURNS trigger LANGUAGE plpgsql AS $$
                 BEGIN
                   IF NEW.idempotency_key LIKE 'crash-%' THEN RAISE EXCEPTION 'injected failure'; END IF;
                   IF NEW.idempotency_key LIKE 'slow-%' THEN PERFORM pg_sleep(4); END IF;
                   RETURN NEW;
                 END $$`);
      await sql(`CREATE TRIGGER test_fail_on_marker BEFORE INSERT ON sync_exchange_idempotency_v2
                 FOR EACH ROW EXECUTE FUNCTION test_fail_on_marker()`);
      const countLog = async () =>
        (await sql("SELECT COUNT(*)::int AS c FROM sync_mirror_ingress WHERE tenant_id = $1", [tenant.id]))[0].c;
      const countState = async (prefix) =>
        (await sql("SELECT COUNT(*)::int AS c FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id LIKE $2", [tenant.id, `${prefix}%`]))[0].c;
      const checkpointRow = () =>
        sql("SELECT acknowledged_seq, issued_seq FROM sync_device_checkpoint WHERE tenant_id = $1 AND machine_fingerprint = $2", [tenant.id, FP_A]);

      const logBefore = await countLog();
      const checkpointBefore = await checkpointRow();
      const body = v2Body(A, Array.from({ length: 20 }, (_, i) => item("articles", `crash-${i}`, 1, null, { i })), {
        idempotency_key: "crash-key-0001",
      });
      const failed = await exchangeRaw(A, body);
      assert.equal(failed.status, 500);
      assert.equal(failed.json.error, "sync_exchange_failed");
      assert.equal(await countLog(), logBefore, "no log rows kept");
      assert.equal(await countState("crash-"), 0, "no state rows kept");
      assert.deepEqual(await checkpointRow(), checkpointBefore, "device checkpoint unchanged");

      const slowBody = v2Body(A, Array.from({ length: 20 }, (_, i) => item("articles", `killed-${i}`, 1, null, { i })), {
        idempotency_key: "slow-key-0001",
      });
      const inFlight = exchangeRaw(A, slowBody).catch(() => ({ status: "network_error" }));
      await delay(1500);
      await stopApi("SIGKILL");
      assert.equal((await inFlight).status, "network_error", "the request died with the process");
      // Postgres rolls back the orphaned transaction once its session notices the client is gone.
      for (let i = 0; i < 60; i += 1) {
        const [busy] = await sql("SELECT COUNT(*)::int AS c FROM pg_stat_activity WHERE application_name = 'maintafox-control-api'");
        if (busy.c === 0) break;
        await delay(250);
      }
      assert.equal(await countState("killed-"), 0, "no partial state after a crash");
      assert.equal(await countLog(), logBefore, "no log rows after a crash");
      await sql("DROP TRIGGER test_fail_on_marker ON sync_exchange_idempotency_v2");
      startApi();
      await waitForHealth();
      // The same requests retried later are applied exactly once.
      const retried = await exchangeRaw(A, body);
      assert.equal(retried.status, 200);
      assert.equal(retried.json.acknowledged_items.filter((a) => !a.duplicate).length, 20);
      const retriedSlow = await exchangeRaw(A, slowBody);
      assert.equal(retriedSlow.status, 200);
      assert.equal(retriedSlow.json.acknowledged_items.filter((a) => !a.duplicate).length, 20);
      A.checkpoint = retriedSlow.json.checkpoint_token;
    }

    // ── Retention: compaction respects the slowest active device; old responses pruned ────
    {
      // Every v2 device acknowledges the current high-water mark (the second exchange sends it back).
      for (const d of [A, B, C]) {
        await pullAll(d);
        await exchange(d);
      }
      const [v1Cursor] = await sql(
        "SELECT last_delivered_ingress_id::int AS c FROM sync_device_cursor WHERE tenant_id = $1",
        [tenant.id],
      );
      await sql("UPDATE sync_mirror_ingress SET received_at_rfc3339 = '2000-01-01T00:00:00.000Z' WHERE tenant_id = $1", [tenant.id]);
      await sql("UPDATE sync_exchange_idempotency_v2 SET created_at = '2000-01-01T00:00:00Z' WHERE tenant_id = $1", [tenant.id]);
      const [aboveBefore] = await sql("SELECT COUNT(*)::int AS c FROM sync_mirror_ingress WHERE tenant_id = $1 AND id > $2", [tenant.id, v1Cursor.c]);
      const db = await openDatabase(databaseUrl, "sync-v2-retention-test");
      try {
        const report = await runSyncRetention(db, { ingressRetentionDays: 1, idempotencyRetentionDays: 1 });
        assert.equal(report.skipped_concurrent_run, false);
        assert.ok(report.ingress_rows_deleted > 0);
        assert.ok(report.idempotency_v2_deleted > 0);
      } finally {
        await db.close();
      }
      const [atOrBelow] = await sql("SELECT COUNT(*)::int AS c FROM sync_mirror_ingress WHERE tenant_id = $1 AND id <= $2", [tenant.id, v1Cursor.c]);
      const [aboveAfter] = await sql("SELECT COUNT(*)::int AS c FROM sync_mirror_ingress WHERE tenant_id = $1 AND id > $2", [tenant.id, v1Cursor.c]);
      assert.equal(atOrBelow.c, 0, "rows every active device has passed are compacted");
      assert.equal(aboveAfter.c, aboveBefore.c, "rows the v1 device has not read yet are kept");
      const [stateRows] = await sql("SELECT COUNT(*)::int AS c FROM sync_entity_state WHERE tenant_id = $1", [tenant.id]);
      assert.ok(stateRows.c > 0, "current state is never compacted");
      await exchange(B, [item("equipment", "eq-after-retention", 1, null, { ok: true })]);
      assert.deepEqual((await pullAll(A)).map((i) => i.entity_sync_id), ["eq-after-retention"], "delivery works after compaction");
    }

    // ── Tenant delete purges every sync table ─────────────────────────────────────────────
    {
      const del = await fetch(`${baseUrl}/api/v1/tenants/${tenant.id}`, { method: "DELETE", headers: admin });
      assert.equal(del.status, 204, await del.clone().text());
      for (const table of [
        "sync_tenant_checkpoint",
        "sync_mirror_ingress",
        "sync_exchange_idempotency",
        "sync_device_cursor",
        "sync_rejection_log",
        "sync_entity_state",
        "sync_device_checkpoint",
        "sync_device_user",
        "sync_exchange_idempotency_v2",
        "sync_conflict_log",
        "sync_media_manifest",
      ]) {
        const [r] = await sql(`SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id = $1`, [tenant.id]);
        assert.equal(r.c, 0, `${table} purged`);
      }
    }

    console.log("sync-protocol-v2: all checks passed");
  } catch (err) {
    console.error(serverOutput.split("\n").slice(-60).join("\n"));
    throw err;
  } finally {
    await stopApi();
    await testPg.stop();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

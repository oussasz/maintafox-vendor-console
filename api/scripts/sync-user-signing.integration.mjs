/**
 * Per-user signed sync changes against a real Postgres (sync-signing-design.md v9 §12).
 *
 * Covers: the signed message encoding (built here independently and compared with the server's),
 * founding administrator slot (single use, closed by another device), key enrolment (wrong
 * password, proof by another key, per-device lockout without a per-user lockout, oversized PHC
 * refused, seeded admin refused, disabled user refused, password never logged or stored), forged
 * actor (author field naming someone who did not sign, another user's key, bad signature bytes,
 * unsigned author-bearing items, protocol v1), valid signed change accepted and delivered with
 * its signatures, guarded author fields, replay (duplicate ack, row-version conflict, another
 * entity or version, another tenant), authority data (low-rights password reset of an
 * administrator refused and the administrator still enrols, self-grant refused, last
 * administrator kept), key revocation at a judged deactivation (later items refused, revocation
 * published), server-only `user_signing_keys` refused from a device, vendor recovery unit
 * (accepted once, replay refused, lone item refused, other PC refused, code older than 7 days
 * refused, codes consumed by the migration refused) and payload bytes served unchanged.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { argon2id } from "hash-wasm";
import pg from "pg";

import { buildAdminRecoveryCode } from "../dist/admin-recovery-signer.js";
import { changeSigningMessage } from "../dist/sync/signing.js";
import { startTestPostgres, TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

// buildAdminRecoveryCode signs with the entitlement key from the environment (test key only).
Object.assign(process.env, TEST_ENTITLEMENT_SIGNING_ENV);

const port = 33193;
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

async function stopApi() {
  if (!server) return;
  const proc = server;
  server = null;
  proc.kill("SIGTERM");
  await once(proc, "exit").catch(() => undefined);
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

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

// ── Signed message, built here independently of the server (design §7) ─────────────────────

function encodeSigned(tag, fields) {
  const parts = [];
  for (const value of [tag, ...fields]) {
    const bytes = Buffer.from(value, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    parts.push(len, bytes);
  }
  return Buffer.concat(parts);
}

function changeMessage(tenantId, it, signer, keyId) {
  return encodeSigned("mfx-sync-sig-v1", [
    tenantId,
    it.entity_type,
    it.entity_sync_id,
    it.operation,
    String(it.row_version),
    it.base_row_version === null ? "" : String(it.base_row_version),
    sha256Hex(it.payload_json),
    signer,
    keyId,
  ]);
}

/** A user's key on one PC. */
function newKey(userSyncId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return {
    user: userSyncId,
    privateKey,
    publicKeyB64: raw.toString("base64"),
    keyId: createHash("sha256").update(raw).digest("hex").slice(0, 32),
  };
}

function signatureOf(tenantId, it, key) {
  return {
    user_sync_id: key.user,
    key_id: key.keyId,
    signature: edSign(null, changeMessage(tenantId, it, key.user, key.keyId), key.privateKey).toString("base64"),
  };
}

// ── Wire helpers ────────────────────────────────────────────────────────────────────────────

function item(entityType, entitySyncId, rowVersion, baseRowVersion, payload, extra = {}) {
  const payload_json = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    idempotency_key: extra.idempotency_key ?? randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: extra.operation ?? (baseRowVersion === null ? "create" : "update"),
    row_version: rowVersion,
    base_row_version: baseRowVersion,
    payload_json,
    payload_hash: sha256Hex(payload_json),
    ...(extra.recovery_code !== undefined ? { recovery_code: extra.recovery_code } : {}),
  };
}

/** The item signed by `keys` (first = maker). */
function signed(tenantId, it, ...keys) {
  return { ...it, signatures: keys.map((k) => signatureOf(tenantId, it, k)) };
}

/** A PC: its token, fingerprint, checkpoint and every inbound item it has been delivered. */
function device(token, fp) {
  return { token, fp, checkpoint: null, received: [] };
}

async function post(path, dev, body) {
  const res = await fetch(`${baseUrl}${path}`, {
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
  return { status: res.status, json };
}

async function exchange(dev, outbox = []) {
  const r = await post("/api/v1/sync/exchange", dev, {
    protocol_version: "v2",
    idempotency_key: `ex-${randomUUID()}`,
    checkpoint_token: dev.checkpoint,
    current_user_sync_ids: [],
    device_class: "desktop",
    outbox_batch: outbox,
  });
  assert.equal(r.status, 200, `exchange failed: ${JSON.stringify(r.json)}`);
  dev.checkpoint = r.json.checkpoint_token;
  dev.received.push(...r.json.inbound_items);
  return r.json;
}

async function pullAll(dev) {
  const all = [];
  for (let i = 0; i < 100; i += 1) {
    const res = await exchange(dev);
    all.push(...res.inbound_items);
    if (!res.has_more) return all;
  }
  throw new Error("pullAll did not converge");
}

/** Pushes items; returns each item's outcome in order ("ack", "conflict" or its rejection code). */
async function push(dev, items) {
  const res = await exchange(dev, items);
  return items.map((i) => {
    if (res.acknowledged_items.some((a) => a.idempotency_key === i.idempotency_key)) return "ack";
    if (res.conflict_items.some((c) => c.idempotency_key === i.idempotency_key)) return "conflict";
    const r = res.rejected_items.find((x) => x.idempotency_key === i.idempotency_key);
    return r ? r.rejection_code : "missing";
  });
}

/** Like push, with each rejection's message: [outcome, message|null]. */
async function pushDetailed(dev, items) {
  const res = await exchange(dev, items);
  return items.map((i) => {
    if (res.acknowledged_items.some((a) => a.idempotency_key === i.idempotency_key)) return ["ack", null];
    const r = res.rejected_items.find((x) => x.idempotency_key === i.idempotency_key);
    return r ? [r.rejection_code, r.rejection_message] : ["missing", null];
  });
}

async function enrol(dev, tenantId, key, password, proofKey = key) {
  const proof = edSign(
    null,
    encodeSigned("mfx-user-key-enrol-v1", [tenantId, key.user, key.keyId, dev.fp]),
    proofKey.privateKey,
  ).toString("base64");
  return post("/api/v1/sync/user-keys/enrol", dev, {
    user_sync_id: key.user,
    public_key: key.publicKeyB64,
    password,
    proof_signature: proof,
  });
}

async function phcOf(password) {
  return argon2id({
    password,
    salt: Buffer.from(randomUUID().replace(/-/g, ""), "hex"),
    parallelism: 1,
    iterations: 2,
    memorySize: 1024,
    hashLength: 32,
    outputType: "encoded",
  });
}

async function run() {
  const testPg = await startTestPostgres();
  databaseUrl = await testPg.createDatabase();
  startApi();
  try {
    await waitForHealth();
    const session = await loginOperator(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    const op = { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" };

    async function makeTenant(slug) {
      const tenantRes = await fetch(`${baseUrl}/api/v1/tenants`, {
        method: "POST",
        headers: op,
        body: JSON.stringify({ slug, display_name: slug }),
      });
      assert.equal(tenantRes.status, 201);
      const tenant = await tenantRes.json();
      const licRes = await fetch(`${baseUrl}/api/v1/licenses`, {
        method: "POST",
        headers: op,
        body: JSON.stringify({ tenant_id: tenant.id, max_machines: 5, expires_at: "2099-01-01T00:00:00.000Z" }),
      });
      assert.equal(licRes.status, 201);
      const licence = await licRes.json();
      const claim = async (fp) => {
        const res = await fetch(`${baseUrl}/api/v1/activation/claim`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ license_key: licence.license_key, machine_fingerprint: fp, app_version: "0.9.3" }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        return device((await res.json()).activation_token, fp);
      };
      return { tenant, claim };
    }

    // ── Signed message: the server's encoding equals the one built here ────────────────────
    {
      const it = item("permit_types", "pt-vector", 2, 1, { "é": "ü", n: 1 });
      const fromServer = changeSigningMessage({
        tenantId: "t-1",
        entityType: it.entity_type,
        entitySyncId: it.entity_sync_id,
        operation: it.operation,
        rowVersion: it.row_version,
        baseRowVersion: it.base_row_version,
        payloadJson: it.payload_json,
        signerUserSyncId: "u-1",
        keyId: "0".repeat(32),
      });
      assert.ok(fromServer.equals(changeMessage("t-1", it, "u-1", "0".repeat(32))), "same signed bytes");
    }

    const { tenant, claim } = await makeTenant("signing-tenant");
    const T = tenant.id;
    const A = await claim("fp-sign-a"); // first activation: the founding PC
    const B = await claim("fp-sign-b");

    // ── Founding administrator (design §8) ────────────────────────────────────────────────
    const adminPw = "Boss-Passw0rd-1";
    const adminAccount = {
      username: "boss",
      display_name: "Boss",
      is_active: 1,
      is_admin: 1,
      deleted_at: null,
      force_password_change: 0,
      password_hash: await phcOf(adminPw),
      password_changed_at: null,
      password_changed_by_sync_id: null,
      status_changed_by_sync_id: null,
    };
    assert.deepEqual(await push(A, [item("user_accounts", "u-admin", 1, null, adminAccount)]), ["ack"], "founding admin");
    const [slot] = await sql(
      "SELECT slot_open, closed_reason, founding_account_sync_id FROM sync_tenant_founding WHERE tenant_id = $1",
      [T],
    );
    assert.deepEqual(slot, { slot_open: false, closed_reason: "founding_admin_created", founding_account_sync_id: "u-admin" });
    const selfMade = { ...adminAccount, username: "evil", password_hash: await phcOf("x-Passw0rd-1") };
    assert.deepEqual(
      await push(A, [item("user_accounts", "u-evil-a", 1, null, selfMade)]),
      ["signature_required"],
      "the founding slot is single-use",
    );
    assert.deepEqual(
      await push(B, [item("user_accounts", "u-evil-b", 1, null, selfMade)]),
      ["signature_required"],
      "self-made administrator from a non-founding PC",
    );

    // ── Enrolment (design §4) ─────────────────────────────────────────────────────────────
    const adminKeyA = newKey("u-admin");
    {
      const wrong = await enrol(A, T, adminKeyA, "not-the-password");
      assert.deepEqual([wrong.status, wrong.json.error], [403, "enrolment_refused"]);
      const badProof = await enrol(A, T, adminKeyA, adminPw, newKey("u-admin"));
      assert.deepEqual([badProof.status, badProof.json.error], [403, "enrolment_refused"], "proof made by another key");
      const ok = await enrol(A, T, adminKeyA, adminPw);
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.key_id, adminKeyA.keyId);
      const again = await enrol(A, T, adminKeyA, adminPw);
      assert.deepEqual([again.status, again.json.error], [409, "key_already_enrolled"]);
      assert.ok(!serverOutput.includes(adminPw) && !serverOutput.includes("not-the-password"), "passwords never logged");
      const dump = JSON.stringify(await sql("SELECT * FROM sync_user_key_enrol_attempts"));
      assert.ok(!dump.includes(adminPw), "passwords never stored");
    }
    const ADM = (it) => signed(T, it, adminKeyA);
    /** Signs as u-ua2, a user and role administrator who is not a plant administrator (set below). */
    let UA2 = null;

    // Accounts made by the administrator (signed, adm.users).
    const account = async (username, password, extra = {}) => ({
      username,
      display_name: username,
      is_active: 1,
      is_admin: 0,
      deleted_at: null,
      force_password_change: 0,
      password_hash: await phcOf(password),
      password_changed_at: null,
      password_changed_by_sync_id: null,
      status_changed_by_sync_id: null,
      ...extra,
    });
    const techPw = "Tech-Passw0rd-1";
    const techAccount = await account("tech", techPw);
    const lockPw = "Lock-Passw0rd-1";
    const oversized = await account("big", "Big-Passw0rd-1", {
      password_hash: "$argon2id$v=19$m=1048576,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo",
    });
    const seeded = await account("admin", "admin", { force_password_change: 1 });
    assert.deepEqual(
      await push(A, [
        ADM(item("user_accounts", "u-tech", 1, null, techAccount)),
        ADM(item("user_accounts", "u-lock", 1, null, await account("lock", lockPw))),
        ADM(item("user_accounts", "u-big", 1, null, oversized)),
        ADM(item("user_accounts", "u-seeded", 1, null, seeded)),
      ]),
      ["ack", "ack", "ack", "ack"],
    );
    {
      const t0 = Date.now();
      const big = await enrol(A, T, newKey("u-big"), "Big-Passw0rd-1");
      assert.deepEqual([big.status, big.json.error], [403, "enrolment_refused"], "oversized PHC refused");
      assert.ok(Date.now() - t0 < 5000, "refused before any Argon2 work");
      const builtin = await enrol(A, T, newKey("u-seeded"), "admin");
      assert.deepEqual([builtin.status, builtin.json.error], [403, "enrolment_refused"], "seeded admin, default password");
      const nobody = await enrol(A, T, newKey("u-nobody"), "whatever");
      assert.deepEqual([nobody.status, nobody.json.error], [403, "enrolment_refused"], "unknown user, same refusal");
    }
    {
      // Five failures on one PC lock that PC out for that user; another PC is only slowed down.
      for (let i = 0; i < 5; i += 1) {
        const r = await enrol(B, T, newKey("u-lock"), `wrong-${i}`);
        assert.equal(r.status, 403);
      }
      const locked = await enrol(B, T, newKey("u-lock"), lockPw);
      assert.deepEqual([locked.status, locked.json.error], [429, "enrolment_locked"], "per-device lockout");
      const elsewhere = await enrol(A, T, newKey("u-lock"), lockPw);
      assert.equal(elsewhere.status, 200, "no per-user lockout");

      // Parallel attempts cannot get past the per-device lockout (each is recorded before Argon2).
      const statuses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => enrol(B, T, newKey("u-lock"), `parallel-${i}`).then((r) => r.status)),
      );
      assert.ok(statuses.every((s) => s === 429), `locked PC stays locked under parallel attempts: ${statuses}`);
      const parUser = await account("par", "Par-Passw0rd-1");
      assert.deepEqual(await push(A, [ADM(item("user_accounts", "u-par", 1, null, parUser))]), ["ack"]);
      const parallel = await Promise.all(
        Array.from({ length: 10 }, (_, i) => enrol(B, T, newKey("u-par"), `parallel-${i}`).then((r) => r.status)),
      );
      assert.equal(parallel.filter((s) => s === 403).length, 5, `exactly five guesses reach Argon2: ${parallel}`);
      assert.equal(parallel.filter((s) => s === 429).length, 5);
    }
    const techKeyB = newKey("u-tech");
    assert.equal((await enrol(B, T, techKeyB, techPw)).status, 200);
    const TECH = (it) => signed(T, it, techKeyB);

    // ── Forged actor, valid signed change, delivery ───────────────────────────────────────
    {
      const event = (id, by) =>
        item("site_setting_events", id, 1, null, { setting_key: "self_approval", value: "off", changed_by_sync_id: by });
      const forged = TECH(event("sse-forged", "u-admin"));
      const unsigned = event("sse-unsigned", "u-tech");
      const keyItem = event("sse-key", "u-tech");
      const otherUsersKey = { ...keyItem, signatures: [{ ...signatureOf(T, keyItem, techKeyB), key_id: adminKeyA.keyId }] };
      const badBytes = TECH(event("sse-bytes", "u-tech"));
      badBytes.signatures[0].signature = Buffer.alloc(64, 7).toString("base64");
      const twice = signed(T, event("sse-twice", "u-tech"), techKeyB, techKeyB);
      const good = TECH(event("sse-good", "u-tech"));
      // Rule 3 needs a signature for authority types only: an unsigned change of an author type is
      // refused by rule 4 as soon as it names an author, and accepted when it names nobody (a
      // scheduler or background write).
      const background = event("sse-background", null);
      assert.deepEqual(await push(B, [forged, unsigned, otherUsersKey, badBytes, twice, good, background]), [
        "author_not_signer",
        "author_not_signer",
        "signing_key_unknown",
        "signature_invalid",
        "signature_invalid",
        "ack",
        "ack",
      ]);
      const [state] = await sql(
        "SELECT COUNT(*)::int AS c FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id LIKE 'sse-%'",
        [T],
      );
      assert.equal(state.c, 2, "refused items never enter the mirror (the signed and the background change do)");
      const delivered = (await pullAll(A)).find((i) => i.entity_sync_id === "sse-good");
      assert.ok(delivered, "the signed change reaches the other PC");
      assert.deepEqual(delivered.signatures, good.signatures, "with its verified signatures");
      assert.equal(typeof (await exchange(A)).signature_cutover_seq, "number");

      // Protocol v1 carries no signatures: author-bearing and server-only types are refused.
      const v1 = await post("/api/v1/sync/exchange", B, {
        protocol_version: "v1",
        idempotency_key: `v1-${randomUUID()}`,
        checkpoint_token: null,
        outbox_batch: [event("sse-v1", "u-tech"), item("user_signing_keys", "k-v1", 1, null, { a: 1 })].map((i) => ({
          idempotency_key: i.idempotency_key,
          entity_type: i.entity_type,
          entity_sync_id: i.entity_sync_id,
          operation: i.operation,
          row_version: i.row_version,
          payload_json: i.payload_json,
          payload_hash: i.payload_hash,
        })),
      });
      assert.equal(v1.status, 200, JSON.stringify(v1.json));
      assert.deepEqual(
        v1.json.rejected_items.map((r) => r.rejection_code),
        ["signature_required", "server_only_entity_type"],
      );
    }

    // ── Guarded author fields and replay (design §5 rule 4, §7) ───────────────────────────
    {
      const p1 = { name: "Hot work", requires_three_person_removal: 0, three_person_changed_by_sync_id: null };
      const create = TECH(item("permit_types", "pt-1", 1, null, p1));
      const p2 = { ...p1, requires_three_person_removal: 1, three_person_changed_by_sync_id: "u-tech" };
      const update = TECH(item("permit_types", "pt-1", 2, 1, p2));
      assert.deepEqual(await push(B, [create, update]), ["ack", "ack"]);
      const silent = TECH(
        item("permit_types", "pt-1", 3, 2, { ...p2, requires_three_person_removal: 0, three_person_changed_by_sync_id: null }),
      );
      const blamed = TECH(
        item("permit_types", "pt-1", 3, 2, { ...p2, requires_three_person_removal: 0, three_person_changed_by_sync_id: "u-admin" }),
      );
      const emptied = TECH(item("permit_types", "pt-1", 3, 2, { ...p2, three_person_changed_by_sync_id: null }));
      const archived = TECH(
        item("permit_types", "pt-1", 3, 2, { ...p2, three_person_changed_by_sync_id: "u-admin" }, { operation: "archive" }),
      );
      assert.deepEqual(
        await push(B, [silent, blamed, emptied, archived]),
        ["author_not_signer", "author_not_signer", "author_not_signer", "author_not_signer"],
        "a guarded change names its signer; the author is never emptied; archive is checked too",
      );

      // Same item again: duplicate ack, nothing applied twice.
      const dup = await exchange(B, [update]);
      assert.equal(dup.acknowledged_items[0].duplicate, true);
      // An older version replayed later under a new item key: row-version conflict, not applied.
      assert.deepEqual(await push(B, [{ ...create, idempotency_key: randomUUID() }]), ["conflict"]);
      // The signature moved to another entity or another version does not verify.
      const moved = { ...item("permit_types", "pt-2", 1, null, p1), signatures: create.signatures };
      const bumped = { ...item("permit_types", "pt-1", 3, 2, p2), signatures: update.signatures };
      assert.deepEqual(await push(B, [moved, bumped]), ["signature_invalid", "signature_invalid"]);
    }

    // ── Unsigned (background) writes, vouched content, settings authorities (§5 rules 3–5) ──
    {
      // A guard switched off without a signature, whether the author is kept or cleared.
      const p2 = { name: "Hot work", requires_three_person_removal: 1, three_person_changed_by_sync_id: "u-tech" };
      assert.deepEqual(
        await push(B, [
          item("permit_types", "pt-1", 3, 2, { ...p2, requires_three_person_removal: 0 }),
          item("permit_types", "pt-1", 3, 2, { ...p2, requires_three_person_removal: 0, three_person_changed_by_sync_id: null }),
        ]),
        ["author_not_signer", "author_not_signer"],
        "an unsigned item cannot switch a permit type's guard off",
      );

      // A per-site safety rule: its value needs the signature of the person it names.
      const rule = { site_node_sync_id: "site-1", setting_key: "permit.self_approval", value_json: "false", updated_by_sync_id: "u-tech" };
      assert.deepEqual(await push(B, [TECH(item("site_settings", "ss-1", 1, null, rule))]), ["ack"]);
      assert.deepEqual(
        await push(B, [
          item("site_settings", "ss-1", 2, 1, { ...rule, value_json: "true" }),
          item("site_settings", "ss-1", 2, 1, { ...rule, value_json: "true", updated_by_sync_id: null }),
          item("site_settings", "ss-2", 1, null, { ...rule, updated_by_sync_id: null }),
        ]),
        ["author_not_signer", "author_not_signer", "author_not_signer"],
        "a site rule is never changed or created unsigned, nor left credited to its last editor",
      );
      assert.deepEqual(
        await push(A, [ADM(item("site_settings", "ss-1", 2, 1, { ...rule, value_json: "true", updated_by_sync_id: "u-admin" }))]),
        ["ack"],
      );

      // A plant setting: the last modifier vouches for the value; a background write names nobody.
      const setting = { setting_key: "wo.reopen_window_days", setting_scope: "tenant", setting_value_json: "5", last_modified_by_sync_id: "u-tech" };
      assert.deepEqual(await push(B, [TECH(item("app_settings", "as-1", 1, null, setting))]), ["ack"]);
      assert.deepEqual(
        await push(B, [item("app_settings", "as-1", 2, 1, { ...setting, setting_value_json: "9" })]),
        ["author_not_signer"],
        "an unsigned value change is not credited to the last modifier",
      );
      assert.deepEqual(
        await push(B, [item("app_settings", "as-1", 2, 1, { ...setting, setting_value_json: "9", last_modified_by_sync_id: null })]),
        ["ack"],
        "a background write clears the modifier",
      );

      // HSE approval vouches for the permit's safety content.
      const permit = {
        title: "Hot work on line 2",
        work_description: "Weld bracket",
        hse_approved_by_sync_id: "u-tech",
        hse_approved_at: "2026-11-13T09:00:00Z",
        hse_approval_note: "ok",
        hse_self_approved: 0,
      };
      assert.deepEqual(await push(B, [TECH(item("work_permits", "wp-1", 1, null, permit))]), ["ack"]);
      const withdrawn = { ...permit, work_description: "Cut and weld", hse_approved_by_sync_id: null, hse_approved_at: null, hse_approval_note: null, hse_self_approved: null };
      assert.deepEqual(
        await push(B, [
          item("work_permits", "wp-1", 2, 1, { ...permit, work_description: "Cut and weld" }),
          item("work_permits", "wp-1", 2, 1, withdrawn),
          TECH(item("work_permits", "wp-1", 2, 1, { ...permit, work_description: "Cut and weld", hse_approved_by_sync_id: "u-admin" })),
          TECH(item("work_permits", "wp-1", 2, 1, withdrawn)),
        ]),
        ["author_not_signer", "signature_required", "author_not_signer", "ack"],
        "changed safety content needs its HSE approver, unless the approval is withdrawn with it by a signer",
      );

      // Count line: self_approved is vouched for by the approver. Clearing the approver may leave
      // it set only in a signed change (the PCs refuse such a line on arrival,
      // inventory/count_four_eyes.rs SYNC_APPROVAL_RECORD_INVALID); unsigned, it is refused.
      const line = { counted_qty: 4, counted_by_sync_id: "u-tech", approved_by_sync_id: "u-tech", approved_at: "2026-11-13T10:00:00Z", approval_note: "ok", self_approved: 0 };
      assert.deepEqual(await push(B, [TECH(item("inventory_count_lines", "icl-1", 1, null, line))]), ["ack"]);
      assert.deepEqual(
        await push(B, [
          item("inventory_count_lines", "icl-1", 2, 1, { ...line, self_approved: 1 }),
          item("inventory_count_lines", "icl-1", 2, 1, { ...line, approved_by_sync_id: null, approved_at: null, approval_note: null, self_approved: 1 }),
        ]),
        ["author_not_signer", "signature_required"],
      );

      // Creates and deletes: an unsigned create may not carry a guarded claim nobody answers for;
      // deleting a record that names people needs its maker (attachments are archived instead).
      const claim = { code: "WO-C", validated_at: "2026-11-13T11:00:00Z", validated_by_sync_id: null };
      assert.deepEqual(
        await push(B, [
          item("work_orders", "wo-claim", 1, null, claim),
          TECH(item("work_orders", "wo-claim-signed", 1, null, claim)),
          item("work_orders", "wo-background", 1, null, { code: "WO-B" }),
        ]),
        ["author_not_signer", "ack", "ack"],
      );
      assert.deepEqual(
        await push(B, [
          item("work_orders", "wo-background", 2, 1, { code: "WO-B" }, { operation: "delete" }),
          item("work_orders", "wo-background", 2, 1, {}, { operation: "archive" }),
          TECH(item("work_orders", "wo-claim-signed", 2, 1, claim, { operation: "delete" })),
        ]),
        ["signature_required", "signature_required", "ack"],
        "an unsigned delete or archive of a record that names people is refused",
      );
      // Nor may an unsigned item wipe a recorded claim (author and guards emptied).
      const validated = { code: "WO-V", validated_at: "2026-11-13T12:00:00Z", validated_by_sync_id: "u-tech" };
      assert.deepEqual(await push(B, [TECH(item("work_orders", "wo-validated", 1, null, validated))]), ["ack"]);
      assert.deepEqual(
        await push(B, [
          item("work_orders", "wo-validated", 2, 1, { code: "WO-V", validated_at: null, validated_by_sync_id: null }),
          item("work_orders", "wo-validated", 2, 1, {}),
        ]),
        ["signature_required", "signature_required"],
      );

      // Settings and organisation authorities: plant-wide holders only.
      assert.deepEqual(
        await push(B, [
          TECH(item("org_nodes", "on-1", 1, null, { name: "Plant 2" })),
          TECH(item("rbac_settings", "rbs-1", 1, null, { key: "session.idle_minutes", value: "30" })),
        ]),
        ["authority_refused", "authority_refused"],
      );
      assert.deepEqual(
        await push(A, [
          ADM(item("org_nodes", "on-1", 1, null, { name: "Plant 2" })),
          ADM(item("rbac_settings", "rbs-1", 1, null, { key: "session.idle_minutes", value: "30" })),
        ]),
        ["ack", "ack"],
      );
    }

    // ── Server-only type, payload bytes ───────────────────────────────────────────────────
    {
      assert.deepEqual(
        await push(B, [item("user_signing_keys", techKeyB.keyId, 9, null, { user_sync_id: "u-tech", public_key: adminKeyA.publicKeyB64 })]),
        ["server_only_entity_type"],
      );
      const raw = '{"z":1,  "a":"é\\u00e9", "n":1.50 ,"k":[ ]}';
      assert.deepEqual(await push(B, [item("equipment", "eq-bytes", 1, null, raw)]), ["ack"]);
      const got = (await pullAll(A)).find((i) => i.entity_sync_id === "eq-bytes");
      assert.equal(got.payload_json, raw, "payload served byte for byte");
    }

    // ── Authority data (design §5 rule 5) ─────────────────────────────────────────────────
    {
      const reset = {
        ...adminAccount,
        password_hash: await phcOf("Taken-Over-1"),
        password_changed_by_sync_id: "u-tech",
        force_password_change: 1,
      };
      assert.deepEqual(
        await push(B, [TECH(item("user_accounts", "u-admin", 2, 1, reset))]),
        ["authority_refused"],
        "a low-rights user cannot reset an administrator's password",
      );
      const grant = {
        user_sync_id: "u-tech",
        role_sync_id: "role-x",
        scope_type: "tenant",
        is_emergency: 0,
        deleted_at: null,
        valid_from: null,
        valid_to: null,
      };
      assert.deepEqual(await push(B, [TECH(item("user_scope_assignments", "usa-self", 1, null, grant))]), ["authority_refused"]);

      // A user administrator (adm.users through a role, not an administrator) may grant ordinary
      // roles to others, never to themself, and loses the right with a soft-deleted role.
      const grantOf = (user, role) => ({ ...grant, user_sync_id: user, role_sync_id: role });
      const uadmPw = "Uadm-Passw0rd-1";
      assert.deepEqual(
        await push(A, [
          ADM(item("roles", "role-uadm", 1, null, { name: "User admins", deleted_at: null })),
          ADM(item("role_permissions", "rp-uadm", 1, null, { role_sync_id: "role-uadm", permission_key: "adm.users", deleted_at: null })),
          ADM(item("roles", "role-ops", 1, null, { name: "Operators", deleted_at: null })),
          ADM(item("user_accounts", "u-uadm", 1, null, await account("uadm", uadmPw))),
          ADM(item("user_scope_assignments", "usa-uadm", 1, null, grantOf("u-uadm", "role-uadm"))),
        ]),
        ["ack", "ack", "ack", "ack", "ack"],
      );
      const uadmKey = newKey("u-uadm");
      assert.equal((await enrol(A, T, uadmKey, uadmPw)).status, 200);
      const UADM = (it) => signed(T, it, uadmKey);
      const [[selfCode, selfMessage], [otherCode]] = await pushDetailed(A, [
        UADM(item("user_scope_assignments", "usa-uadm-self", 1, null, grantOf("u-uadm", "role-ops"))),
        UADM(item("user_scope_assignments", "usa-par-ops", 1, null, grantOf("u-par", "role-ops"))),
      ]);
      assert.equal(selfCode, "authority_refused");
      assert.match(selfMessage, /own account/, "refused as a self-grant");
      assert.equal(otherCode, "ack", "an adm.users holder grants an ordinary role to someone else");
      assert.deepEqual(
        await push(A, [ADM(item("roles", "role-uadm", 2, 1, { name: "User admins", deleted_at: "2026-11-13T00:00:00Z" }))]),
        ["ack"],
      );
      assert.deepEqual(
        await push(A, [UADM(item("user_scope_assignments", "usa-lock-ops", 1, null, grantOf("u-lock", "role-ops")))]),
        ["authority_refused"],
        "a right held only through a soft-deleted role is gone",
      );

      // A second user administrator (not an administrator) can neither grant the soft-deleted role
      // that still carries adm.users, nor revive it.
      const ua2Pw = "Ua2-Passw0rd-1";
      assert.deepEqual(
        await push(A, [
          ADM(item("roles", "role-ua2", 1, null, { name: "User admins 2", deleted_at: null })),
          ADM(item("role_permissions", "rp-ua2-users", 1, null, { role_sync_id: "role-ua2", permission_key: "adm.users", deleted_at: null })),
          ADM(item("role_permissions", "rp-ua2-roles", 1, null, { role_sync_id: "role-ua2", permission_key: "adm.roles", deleted_at: null })),
          ADM(item("user_accounts", "u-ua2", 1, null, await account("ua2", ua2Pw))),
          ADM(item("user_scope_assignments", "usa-ua2", 1, null, grantOf("u-ua2", "role-ua2"))),
        ]),
        ["ack", "ack", "ack", "ack", "ack"],
      );
      const ua2Key = newKey("u-ua2");
      assert.equal((await enrol(A, T, ua2Key, ua2Pw)).status, 200);
      UA2 = (it) => signed(T, it, ua2Key);
      assert.deepEqual(
        await push(A, [
          UA2(item("user_scope_assignments", "usa-revive", 1, null, grantOf("u-lock", "role-uadm"))),
          UA2(item("roles", "role-uadm", 3, 2, { name: "User admins", deleted_at: null })),
        ]),
        ["authority_refused", "authority_refused"],
        "a soft-deleted role keeps its administration rights for these checks",
      );
      // The administrator's password is unchanged: they still enrol on the other PC.
      assert.equal((await enrol(B, T, newKey("u-admin"), adminPw)).status, 200);
      // Last administrator: the only one cannot disable themself.
      const off = { ...adminAccount, is_active: 0, status_changed_by_sync_id: "u-admin" };
      assert.deepEqual(await push(A, [ADM(item("user_accounts", "u-admin", 2, 1, off))]), ["last_administrator_required"]);
    }

    // ── Revocation at a judged deactivation (design §6) ───────────────────────────────────
    {
      const noAuthor = { ...techAccount, is_active: 0 };
      assert.deepEqual(
        await push(A, [ADM(item("user_accounts", "u-tech", 2, 1, noAuthor))]),
        ["author_not_signer"],
        "a status change names who made it",
      );
      const disabled = { ...techAccount, is_active: 0, status_changed_by_sync_id: "u-admin" };
      assert.deepEqual(await push(A, [ADM(item("user_accounts", "u-tech", 2, 1, disabled))]), ["ack"]);
      const [key] = await sql(
        "SELECT revoked_reason FROM sync_user_signing_keys WHERE tenant_id = $1 AND key_id = $2",
        [T, techKeyB.keyId],
      );
      assert.equal(key.revoked_reason, "account_disabled");
      const late = TECH(
        item("site_setting_events", "sse-late", 1, null, { setting_key: "x", value: "y", changed_by_sync_id: "u-tech" }),
      );
      assert.deepEqual(await push(B, [late]), ["signing_key_revoked"], "a disabled user's key is refused");
      assert.equal((await enrol(B, T, newKey("u-tech"), techPw)).status, 403, "a disabled user cannot enrol");
      await pullAll(A);
      // Delivered either in a pull or in the response to A's own push of the deactivation.
      const published = A.received.filter(
        (i) => i.entity_type === "user_signing_keys" && i.entity_sync_id === techKeyB.keyId,
      );
      assert.ok(published.length > 0);
      assert.equal(JSON.parse(published.at(-1).payload_json).revoked_reason, "account_disabled", "revocation published");
    }

    // ── Another tenant: slot closed by another device; signatures do not travel ───────────
    {
      const other = await makeTenant("signing-tenant-2");
      const X = await other.claim("fp-other-x");
      const Y = await other.claim("fp-other-y");
      assert.deepEqual(await push(Y, [item("equipment", "eq-y", 1, null, { a: 1 })]), ["ack"]);
      assert.deepEqual(
        await push(X, [item("user_accounts", "u-founder", 1, null, adminAccount)]),
        ["signature_required"],
        "the slot closes as soon as another device pushes",
      );
      const replay = ADM(
        item("site_setting_events", "sse-cross", 1, null, { setting_key: "x", value: "y", changed_by_sync_id: "u-admin" }),
      );
      assert.deepEqual(await push(Y, [replay]), ["signing_key_unknown"], "a key of another tenant is unknown here");
    }

    // ── Vendor recovery unit (design §8) ──────────────────────────────────────────────────
    {
      assert.deepEqual(
        await push(A, [ADM(item("roles", "role-admin", 1, null, { name: "Administrator", deleted_at: null }))]),
        ["ack"],
      );
      const [{ license_id: licenseId }] = await sql(
        "SELECT license_id FROM machine_activations WHERE tenant_id = $1 AND machine_fingerprint = $2",
        [T, A.fp],
      );
      const issue = async (issuedAt) => {
        const code = buildAdminRecoveryCode({ tenantId: T, machineFingerprint: A.fp, licenseId, issuedAt });
        await sql(
          `INSERT INTO admin_recovery_codes (code_id, tenant_id, license_id, machine_fingerprint, issued_by, reason,
             requested_by, identity_check, issued_at, expires_at, key_id, audit_record_id)
           VALUES ($1,$2,$3,$4,'op','test','Karim B.','in_person',$5,$6,$7,'audit-test')`,
          [code.payload.code_id, T, licenseId, A.fp, code.payload.issued_at, code.payload.expires_at, code.payload.key_id],
        );
        return code;
      };
      const unit = async (code, n, grantId = `usa-rec-${n}`) => [
        item("user_accounts", `u-rec-${n}`, 1, null, await account(`rescue${n}`, "Rescue-Passw0rd-1"), {
          recovery_code: code.code,
        }),
        item(
          "user_scope_assignments",
          grantId,
          1,
          null,
          {
            user_sync_id: `u-rec-${n}`,
            role_sync_id: "role-admin",
            scope_type: "tenant",
            is_emergency: 0,
            deleted_at: null,
            valid_from: null,
            valid_to: null,
          },
          { recovery_code: code.code },
        ),
      ];

      const code = await issue();
      const isConsumed = async (c) =>
        (await sql("SELECT consumed_at FROM admin_recovery_codes WHERE code_id = $1", [c.payload.code_id]))[0].consumed_at !== null;

      // Another item reusing a recovery item's idempotency key never inherits the exemption.
      {
        const [account0, grant0] = await unit(code, 0);
        const smuggled = item(
          "site_setting_events",
          "sse-smuggled",
          1,
          null,
          { setting_key: "self_approval", value: "off", changed_by_sync_id: "u-admin" },
          { idempotency_key: account0.idempotency_key },
        );
        // Two items share a key, so the outcomes are read in processing order, not by key.
        const res = await exchange(A, [smuggled, account0, grant0]);
        assert.equal(res.acknowledged_items.length, 0);
        assert.deepEqual(
          res.rejected_items.map((r) => r.rejection_code),
          ["author_not_signer", "duplicate_item_in_batch", "recovery_refused"],
        );
        assert.equal(await isConsumed(code), false, "the code is not spent by a refused unit");
      }
      // Both or neither: a grant that cannot be applied as a new row refuses the whole unit.
      {
        assert.deepEqual(
          await push(A, [ADM(item("user_scope_assignments", "usa-taken", 1, null, {
            user_sync_id: "u-par", role_sync_id: "role-ops", scope_type: "tenant", is_emergency: 0, deleted_at: null, valid_from: null, valid_to: null,
          }))]),
          ["ack"],
        );
        // The grant's own row-version conflict comes first; the account is refused with the unit.
        assert.deepEqual(await push(A, await unit(code, 7, "usa-taken")), ["recovery_refused", "conflict"]);
        assert.equal(await isConsumed(code), false);
        const [{ n }] = await sql("SELECT COUNT(*)::int AS n FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id = 'u-rec-7'", [T]);
        assert.equal(n, 0, "the account of a refused unit is not applied either");
      }

      const unit1 = await unit(code, 1);
      assert.deepEqual(await push(A, unit1), ["ack", "ack"], "a valid recovery unit is accepted");
      await pullAll(B);
      const delivered = B.received.filter((i) => i.entity_sync_id === "u-rec-1" || i.entity_sync_id === "usa-rec-1");
      assert.deepEqual(delivered.map((i) => i.server_attestation), ["recovery", "recovery"], "delivered with its attestation");
      const [consumed] = await sql(
        "SELECT consumed_at, consumed_entity_sync_id FROM admin_recovery_codes WHERE code_id = $1",
        [code.payload.code_id],
      );
      assert.ok(consumed.consumed_at !== null);
      assert.equal(consumed.consumed_entity_sync_id, "u-rec-1");
      assert.deepEqual(await push(A, await unit(code, 2)), ["recovery_refused", "recovery_refused"], "a used code is refused");

      // The recovered administrator (Administrator role, is_admin 0) once deactivated stays protected:
      // a user administrator cannot reactivate it with a password of their choosing.
      const off = { ...JSON.parse(unit1[0].payload_json), is_active: 0, status_changed_by_sync_id: "u-admin" };
      assert.deepEqual(await push(A, [ADM(item("user_accounts", "u-rec-1", 2, 1, off))]), ["ack"]);
      const takeover = {
        ...off,
        is_active: 1,
        status_changed_by_sync_id: "u-ua2",
        password_hash: await phcOf("Taken-Over-2"),
        password_changed_by_sync_id: "u-ua2",
      };
      assert.deepEqual(
        await push(A, [UA2(item("user_accounts", "u-rec-1", 3, 2, takeover))]),
        ["authority_refused"],
        "a deactivated administrator cannot be taken over",
      );

      const lone = await issue();
      assert.deepEqual(await push(A, [(await unit(lone, 3))[0]]), ["recovery_refused"], "a recovery is exactly two items");
      assert.deepEqual(await push(B, await unit(lone, 4)), ["recovery_refused", "recovery_refused"], "only from the code's PC");

      const old = await issue(new Date(Date.now() - 8 * 24 * 3600_000));
      assert.deepEqual(await push(A, await unit(old, 5)), ["recovery_refused", "recovery_refused"], "older than 7 days");

      // Codes issued before the cutover: the migration's own statement marks them consumed.
      const preCutover = await issue();
      const migration = readFileSync(new URL("../migrations/022_sync_user_signing.sql", import.meta.url), "utf8");
      const statement = migration.match(/^UPDATE admin_recovery_codes SET consumed_at = now\(\) WHERE consumed_at IS NULL;$/m);
      assert.ok(statement, "migration 022 consumes earlier codes");
      await sql(statement[0]);
      assert.deepEqual(await push(A, await unit(preCutover, 6)), ["recovery_refused", "recovery_refused"], "pre-cutover code");
      const [{ c }] = await sql(
        "SELECT COUNT(*)::int AS c FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id LIKE 'u-rec-%'",
        [T],
      );
      assert.equal(c, 1, "only the one valid recovery reached the mirror");
    }

    console.log("sync-user-signing: all checks passed");
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

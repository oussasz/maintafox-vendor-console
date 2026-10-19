/**
 * Administrator recovery codes against a real Postgres and the real API: an operator with
 * entitlement.manage issues a code for one PC with a reason and an `admin_recovery_code` step-up;
 * the code verifies against the public key of the server's (TEST) signing key and is bound to the
 * stored activation; refusals for unknown tenant / device, suspended tenant, revoked activation,
 * revoked or expired licence, too many unexpired codes; the ledger and the database never hold the
 * code string; the console lists issued codes without it.
 */
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";

import { canonicalAdminRecoveryPayload } from "../dist/admin-recovery-signer.js";
import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { TEST_ENTITLEMENT_KEY_ID, TEST_ENTITLEMENT_PUBLIC_KEY_HEX } from "./lib/test-signing-key.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(TEST_ENTITLEMENT_PUBLIC_KEY_HEX, "hex")]),
  format: "der",
  type: "spki",
});

/** The desktop's checks that do not need its local state: format, canonical bytes, signature. */
function decodeAndVerify(code) {
  const [prefix, b64, sigHex, ...rest] = code.split(".");
  assert.equal(prefix, "MFXREC1");
  assert.equal(rest.length, 0);
  assert.match(b64, /^[A-Za-z0-9_-]+$/, "base64url without padding");
  assert.match(sigHex, /^[0-9a-f]{128}$/);
  const payloadJson = Buffer.from(b64, "base64url").toString("utf8");
  const payload = JSON.parse(payloadJson);
  assert.equal(canonicalAdminRecoveryPayload(payload), payloadJson, "canonical key order");
  assert.ok(
    verify(null, Buffer.from(`maintafox-admin-recovery:v1\n${payloadJson}`, "utf8"), publicKey, Buffer.from(sigHex, "hex")),
    "signature verifies with the public key of the server's signing key",
  );
  return { payload, sigHex };
}

const api = await startControlApi({ port: 33261 });

try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const admin = owner.accessToken;
  const privileged = async (kind = "admin_recovery_code", reason = "customer lost every admin") => ({
    "X-Operator-Reason": reason,
    "X-Step-Up-Token": await owner.stepUp(kind),
  });
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;

  const setup = async (slug, maxMachines = 3) => {
    const tenant = (await api.call("POST", "/api/v1/tenants", admin, { slug, display_name: slug, rollout_cohort: "stable-main", update_channel: "stable" })).json;
    const licence = (await api.call("POST", "/api/v1/licenses", admin, { tenant_id: tenant.id, max_machines: maxMachines })).json;
    return { tenant, licence };
  };
  const issue = (tenantId, fp, headers, token = admin) =>
    api.call("POST", `/api/v1/tenants/${encodeURIComponent(tenantId)}/machines/${encodeURIComponent(fp)}/admin-recovery-code`, token, {}, headers);
  /** Like api.call, with the response headers (Cache-Control checks). */
  const raw = async (method, path, headers = {}) => {
    const res = await fetch(`${api.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : "{}",
    });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  const list = (tenantId, fp, token = admin) =>
    api.call("GET", `/api/v1/tenants/${encodeURIComponent(tenantId)}/admin-recovery-codes${fp ? `?machine_fingerprint=${encodeURIComponent(fp)}` : ""}`, token);

  const { tenant, licence } = await setup("recovery");
  const fpA = "fp-recovery-A:Ünïcode/ok";
  await api.claimDevice(licence.license_key, fpA);

  // ── Guard: reason, step-up, step-up kind ────────────────────────────────────────────────
  const noReason = await issue(tenant.id, fpA, { "X-Step-Up-Token": await owner.stepUp("admin_recovery_code") });
  assert.deepEqual([noReason.status, noReason.json.reason], [403, "missing_reason_code"]);
  const noStepUp = await issue(tenant.id, fpA, { "X-Operator-Reason": "customer lost every admin" });
  assert.deepEqual([noStepUp.status, noStepUp.json.reason], [403, "missing_step_up_token"]);
  const wrongKind = await issue(tenant.id, fpA, await privileged("machine_trust_change"));
  assert.deepEqual([wrongKind.status, wrongKind.json.reason], [403, "step_up_action_kind_mismatch"]);
  assert.equal((await api.su("SELECT count(*)::int AS n FROM admin_recovery_codes"))[0].n, 0, "nothing issued on a refusal");
  assert.equal(await audited("admin_recovery_code_issued"), 0);

  // ── Issue ────────────────────────────────────────────────────────────────────────────────
  const before = Date.now();
  const issuedRaw = await raw(
    "POST",
    `/api/v1/tenants/${encodeURIComponent(tenant.id)}/machines/${encodeURIComponent(fpA)}/admin-recovery-code`,
    await privileged(),
  );
  assert.equal(issuedRaw.status, 201, JSON.stringify(issuedRaw.json));
  assert.equal(issuedRaw.headers.get("cache-control"), "no-store", "the code is not cached");
  const issued = { status: issuedRaw.status, json: issuedRaw.json };
  const { payload, sigHex } = decodeAndVerify(issued.json.code);
  assert.deepEqual(Object.keys(payload), [
    "v", "purpose", "code_id", "tenant_id", "machine_fingerprint", "license_id", "issuer", "key_id", "signature_alg", "issued_at", "expires_at",
  ]);
  assert.equal(payload.v, 1);
  assert.equal(payload.purpose, "admin_recovery");
  assert.equal(payload.signature_alg, "ed25519:admin-recovery:v1");
  assert.equal(payload.issuer, "maintafox-vps");
  assert.equal(payload.key_id, TEST_ENTITLEMENT_KEY_ID);
  assert.equal(payload.tenant_id, tenant.id);
  assert.equal(payload.license_id, licence.id);
  const [stored] = await api.su("SELECT machine_fingerprint FROM machine_activations WHERE tenant_id = $1", [tenant.id]);
  assert.equal(payload.machine_fingerprint, stored.machine_fingerprint, "fingerprint byte for byte as stored");
  assert.equal(payload.code_id, issued.json.code_id);
  assert.equal(payload.expires_at, issued.json.expires_at);
  assert.equal(Date.parse(payload.expires_at) - Date.parse(payload.issued_at), 24 * 3_600_000, "valid 24 h");
  assert.ok(Math.abs(Date.parse(payload.issued_at) - before) < 60_000);
  assert.ok(issued.json.audit_record_id);

  // ── The code string is stored nowhere; the ledger has the identifiers ─────────────────────
  assert.equal(await audited("admin_recovery_code_issued"), 1);
  const [ledger] = await api.su("SELECT * FROM audit_records WHERE action_code = 'admin_recovery_code_issued'");
  assert.equal(ledger.record_id, issued.json.audit_record_id);
  assert.equal(ledger.action_category, "entitlement");
  assert.equal(ledger.scope_tenant_id, tenant.id);
  assert.equal(ledger.reason_code, "customer lost every admin");
  assert.deepEqual(JSON.parse(ledger.entity_refs_json), { tenant_id: tenant.id, entitlement_id: licence.id, machine_id: fpA });
  const [row] = await api.su("SELECT * FROM admin_recovery_codes WHERE code_id = $1", [payload.code_id]);
  assert.equal(row.audit_record_id, ledger.record_id);
  assert.equal(row.reason, "customer lost every admin");
  assert.equal(row.expires_at, payload.expires_at);
  assert.equal(row.key_id, TEST_ENTITLEMENT_KEY_ID);
  const b64 = issued.json.code.split(".")[1];
  for (const [table, rows] of [
    ["audit_records", await api.su("SELECT * FROM audit_records")],
    ["admin_recovery_codes", await api.su("SELECT * FROM admin_recovery_codes")],
    ["idempotency_keys", await api.su("SELECT * FROM idempotency_keys")],
  ]) {
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(sigHex) && !dump.includes(b64) && !dump.includes("MFXREC1"), `${table} never holds the code`);
  }

  // Nor in the API's own output (logs).
  const logs = api.output();
  assert.ok(logs.length > 0, "server output captured");
  for (const secret of ["MFXREC1", b64, sigHex]) assert.ok(!logs.includes(secret), "the API never logs the code");

  // ── Listing (no code strings) ─────────────────────────────────────────────────────────────
  const listed = await list(tenant.id, fpA);
  assert.equal(listed.status, 200, listed.text);
  const listedRaw = await raw("GET", `/api/v1/tenants/${encodeURIComponent(tenant.id)}/admin-recovery-codes`);
  assert.equal(listedRaw.headers.get("cache-control"), "no-store", "the listing (operator reasons) is not cached");
  assert.equal(listed.json.length, 1);
  assert.equal(listed.json[0].code_id, payload.code_id);
  assert.equal(listed.json[0].expired, false);
  assert.equal(listed.json[0].issued_by, ledger.actor_id);
  assert.ok(!("code" in listed.json[0]) && !JSON.stringify(listed.json).includes("MFXREC1"));
  assert.equal((await list(tenant.id, "fp-other")).json.length, 0, "filtered by device");
  assert.equal((await list(tenant.id)).json.length, 1);

  // ── Re-issue allowed, capped at 3 unexpired codes per PC ─────────────────────────────────
  assert.equal((await issue(tenant.id, fpA, await privileged())).status, 201);
  assert.equal((await issue(tenant.id, fpA, await privileged())).status, 201);
  const capped = await issue(tenant.id, fpA, await privileged());
  assert.deepEqual([capped.status, capped.json.error, capped.json.max_unexpired], [409, "admin_recovery_code_limit", 3]);
  await api.su("UPDATE admin_recovery_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code_id = $1", [payload.code_id]);
  assert.equal((await issue(tenant.id, fpA, await privileged())).status, 201, "an expired code frees its place");
  const afterCap = (await list(tenant.id, fpA)).json;
  assert.equal(afterCap.length, 4);
  assert.equal(afterCap.find((r) => r.code_id === payload.code_id).expired, true);
  assert.equal(new Set(afterCap.map((r) => r.code_id)).size, 4, "each code has its own code_id");

  // ── Refusals ──────────────────────────────────────────────────────────────────────────────
  const unknownTenant = await issue("ten_does_not_exist", fpA, await privileged());
  assert.deepEqual([unknownTenant.status, unknownTenant.json.error], [404, "tenant_not_found"]);
  const unknownDevice = await issue(tenant.id, "fp-never-activated", await privileged());
  assert.deepEqual([unknownDevice.status, unknownDevice.json.error], [404, "activation_not_found"]);

  const fpB = "fp-recovery-B";
  await api.claimDevice(licence.license_key, fpB);
  const revoked = await api.call(
    "POST",
    `/api/v1/tenants/${tenant.id}/machines/${fpB}/revoke`,
    admin,
    { reason: "stolen" },
    await privileged("machine_trust_change", "stolen laptop"),
  );
  assert.equal(revoked.status, 200, revoked.text);
  const onRevoked = await issue(tenant.id, fpB, await privileged());
  assert.deepEqual([onRevoked.status, onRevoked.json.error, onRevoked.json.revocation_kind], [409, "activation_revoked", "machine"]);

  // Licence revoked / expired with the activation row untouched, and a suspended tenant: the
  // server checks each one itself.
  const lr = await setup("recovery-lic-revoked");
  await api.claimDevice(lr.licence.license_key, "fp-recovery-lr");
  await api.su("UPDATE license_keys SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE id = $1", [lr.licence.id]);
  const onLicRevoked = await issue(lr.tenant.id, "fp-recovery-lr", await privileged());
  assert.deepEqual([onLicRevoked.status, onLicRevoked.json.error], [409, "license_revoked"]);

  const le = await setup("recovery-lic-expired");
  await api.claimDevice(le.licence.license_key, "fp-recovery-le");
  await api.su("UPDATE license_keys SET expires_at = '2001-01-01T00:00:00.000Z' WHERE id = $1", [le.licence.id]);
  const onLicExpired = await issue(le.tenant.id, "fp-recovery-le", await privileged());
  assert.deepEqual([onLicExpired.status, onLicExpired.json.error], [409, "license_expired"]);

  const ts = await setup("recovery-suspended");
  await api.claimDevice(ts.licence.license_key, "fp-recovery-ts");
  const suspended = await api.call(
    "POST",
    `/api/v1/tenants/${ts.tenant.id}/suspend`,
    admin,
    { reason: "unpaid invoice" },
    await privileged("entitlement_suspension", "unpaid invoice"),
  );
  assert.equal(suspended.status, 200, suspended.text);
  const onSuspended = await issue(ts.tenant.id, "fp-recovery-ts", await privileged());
  assert.deepEqual([onSuspended.status, onSuspended.json.error], [409, "tenant_suspended"]);
  assert.equal(await audited("admin_recovery_code_issued"), 4, "refusals issue nothing");

  // ── Permission: entitlement.manage to issue, console.view to list ────────────────────────
  const created = await api.call(
    "POST",
    "/api/v1/operators",
    admin,
    { email: "support@maintafox.systems", display_name: "Support", role: "support", initial_password: "Initial-support-pass-1" },
    await privileged("vendor_user_admin", "hire support"),
  );
  assert.equal(created.status, 201, created.text);
  const support = await loginOperator(api.baseUrl, "support@maintafox.systems", "Initial-support-pass-1", {
    enrolmentCode: created.json.enrolment_code,
  });
  const denied = await issue(tenant.id, fpA, { "X-Operator-Reason": "trying", "X-Step-Up-Token": await support.stepUp("admin_recovery_code") }, support.accessToken);
  assert.deepEqual([denied.status, denied.json], [403, { error: "permission_denied", required_permission: "entitlement.manage" }]);
  assert.equal((await list(tenant.id, fpA, support.accessToken)).status, 200, "support may see the history");

  assert.ok(!api.output().includes("MFXREC1"), "no code in the server output after every issuance");
  console.log("admin-recovery integration: OK");
} catch (err) {
  console.error(api.output().slice(-4000));
  throw err;
} finally {
  await api.stop();
}

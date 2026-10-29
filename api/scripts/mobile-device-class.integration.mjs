/**
 * Mobile device class (migration 019) on the real API and a real Postgres:
 * - a licence counts desktops against max_machines and phones against max_mobile_devices;
 * - max_mobile_devices is 0 (mobile not licensed) until an operator sets it, which is validated
 *   (0..1000) and audited; a request without device_class is a desktop, so existing desktops work
 *   unchanged;
 * - phones join only through an administrator's enrolment (mobile-enrolment.integration.mjs covers
 *   it in detail): the licence key path refuses them with 403 mobile_enrolment_required;
 * - a fingerprint keeps its class (claim, preview, policy refresh and every sync route refuse the
 *   other class with 409 device_class_mismatch);
 * - the device learns its class from the response and from the signed envelope (policy_json);
 * - machine reinstatement and the console overview count each class separately.
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { randomUUID } from "node:crypto";

import { startControlApi } from "./lib/control-api.mjs";
import { TEST_ENTITLEMENT_PUBLIC_KEY_HEX } from "./lib/test-signing-key.mjs";

const api = await startControlApi({ port: 33271 });

const publicKey = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(TEST_ENTITLEMENT_PUBLIC_KEY_HEX, "hex")]),
  format: "der",
  type: "spki",
});

/** Rebuilds the canonical payload the desktop verifies (entitlement-signer.ts canonicalPayload). */
function envelopeVerifies(env) {
  const canonical = JSON.stringify({
    envelope_id: env.envelope_id,
    previous_envelope_id: env.previous_envelope_id,
    lineage_version: env.lineage_version,
    issuer: env.issuer,
    key_id: env.key_id,
    signature_alg: env.signature_alg,
    tier: env.tier,
    state: env.state,
    channel: env.channel,
    machine_slots: env.machine_slots,
    feature_flags_json: env.feature_flags_json,
    capabilities_json: env.capabilities_json,
    policy_json: env.policy_json,
    issued_at: env.issued_at,
    valid_from: env.valid_from,
    valid_until: env.valid_until,
    offline_grace_until: env.offline_grace_until,
  });
  return verify(null, Buffer.from(canonical, "utf8"), publicKey, Buffer.from(env.signature, "hex"));
}

try {
  const admin = await api.adminToken();
  let opCounter = 0;
  const idem = () => ({ "Idempotency-Key": `mobile-class-${(opCounter += 1)}` });
  const privileged = async (reason, kind) => ({
    ...idem(),
    "X-Operator-Reason": reason,
    "X-Step-Up-Token": await api.stepUpToken(admin, kind),
  });

  const tenant = (await api.call("POST", "/api/v1/tenants", admin, { slug: "mobile-class-co", display_name: "Mobile Class Co" })).json;
  assert.ok(tenant?.id, "tenant create must succeed");

  // ── Licence without max_mobile_devices: mobile not licensed ─────────────────────────────────
  const issued = await api.call(
    "POST",
    "/api/v1/licenses",
    admin,
    {
      tenant_id: tenant.id,
      max_machines: 1,
      expires_at: "2099-01-01T00:00:00.000Z",
      operator_reason_code: "ONBOARDING",
      operator_rationale: "Mobile device class integration test.",
    },
    idem(),
  );
  assert.equal(issued.status, 201, issued.text);
  assert.equal(issued.json.max_mobile_devices, 0, "an issued licence has no phones unless the operator sets some");
  const licence = issued.json;
  const listed = (await api.call("GET", `/api/v1/tenants/${tenant.id}/licenses`, admin)).json;
  assert.equal(listed[0].max_mobile_devices, 0);

  const claim = (fingerprint, deviceClass) =>
    api.call("POST", "/api/v1/activation/claim", null, {
      license_key: licence.license_key,
      machine_fingerprint: fingerprint,
      app_version: "1.2.3",
      ...(deviceClass ? { device_class: deviceClass } : {}),
    });
  const preview = (fingerprint, deviceClass) =>
    api.call("POST", "/api/v1/activation/preview", null, {
      license_key: licence.license_key,
      machine_fingerprint: fingerprint,
      ...(deviceClass ? { device_class: deviceClass } : {}),
    });
  const refresh = (token, body = {}) => api.call("POST", "/api/v1/activation/policy-refresh", token, body);

  // An unknown class is a validation error, not a desktop.
  assert.equal((await claim("fp-tablet-0001", "tablet")).status, 400);

  // ── Desktop without device_class: unchanged behaviour, told it is a desktop ─────────────────
  const desktopA = "fp-desktop-a-0001";
  const claimA = await claim(desktopA);
  assert.equal(claimA.status, 200, claimA.text);
  assert.equal(claimA.json.device_class, "desktop");
  assert.equal(claimA.json.device_limit, 1);
  assert.equal(claimA.json.activated_device_count, 1);
  const envA = claimA.json.entitlement_envelope;
  assert.equal(envA.machine_slots, 1);
  assert.equal(JSON.parse(envA.policy_json).device_class, "desktop", "the class is inside the signed policy");
  assert.ok(Array.isArray(JSON.parse(envA.policy_json).grace_allowed_modules), "desktop policy keys are unchanged");
  assert.ok(envelopeVerifies(envA), "desktop envelope signature verifies");
  const tokenA = claimA.json.activation_token;
  const [rowA] = await api.su("SELECT device_class FROM machine_activations WHERE machine_fingerprint = $1", [desktopA]);
  assert.equal(rowA.device_class, "desktop");

  // ── Phones never join with the licence key ──────────────────────────────────────────────────
  for (const r of [await preview("fp-phone-1-0001", "mobile"), await claim("fp-phone-1-0001", "mobile")]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "mobile_enrolment_required");
    assert.equal(typeof r.json.message, "string");
  }

  // Phones join through an enrolment issued from an activated desktop.
  let personSeq = 0;
  const issueFor = (deskToken) => {
    personSeq += 1;
    return api.call("POST", "/api/v1/mobile-enrolments", deskToken, {
      person_sync_id: `person-${personSeq}`,
      person_label: `Technicien ${personSeq}`,
      site_sync_id: "site-1",
      site_label: "Usine 1",
      issued_by_sync_id: "admin-1",
      issued_by_label: "Admin",
    });
  };
  const enrolPhone = async (fingerprint) => {
    const issued = await issueFor(tokenA);
    if (issued.status !== 201) return issued;
    return api.call("POST", "/api/v1/mobile-enrolments/redeem", null, {
      token: issued.json.token,
      machine_fingerprint: fingerprint,
      app_version: "1.2.3",
      device_class: "mobile",
    });
  };

  // ── Licence with 0 mobile devices: 403 mobile_not_licensed ──────────────────────────────────
  {
    const r = await enrolPhone("fp-phone-1-0001");
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "mobile_not_licensed");
  }
  assert.equal((await api.su("SELECT count(*)::int AS n FROM machine_activations WHERE device_class = 'mobile'"))[0].n, 0);

  // ── Operator sets max_mobile_devices: validated and audited ─────────────────────────────────
  for (const bad of [-1, 1001, 1.5, "2"]) {
    const r = await api.call("PATCH", `/api/v1/licenses/${licence.id}`, admin, { max_mobile_devices: bad });
    assert.equal(r.status, 400, `max_mobile_devices ${JSON.stringify(bad)} must be refused`);
  }
  const auditsBefore = (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = 'license_update'"))[0].n;
  const patched = await api.call(
    "PATCH",
    `/api/v1/licenses/${licence.id}`,
    admin,
    { max_mobile_devices: 2, operator_rationale: "Customer bought two field phones." },
    { "X-Operator-Reason": "MOBILE-SEATS" },
  );
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.max_mobile_devices, 2);
  assert.equal(patched.json.max_machines, 1, "desktop slots are untouched");
  const audits = await api.su(
    "SELECT payload_canonical_sha256, reason_code FROM audit_records WHERE action_code = 'license_update' ORDER BY sequence",
  );
  assert.equal(audits.length, auditsBefore + 1, "the change is in the audit ledger");
  const expectedPayload = JSON.stringify({
    from: { max_machines: 1, max_mobile_devices: 0, expires_at: "2099-01-01T00:00:00.000Z", update_channel: licence.update_channel },
    to: { max_machines: 1, max_mobile_devices: 2, expires_at: "2099-01-01T00:00:00.000Z", update_channel: licence.update_channel },
    operator_rationale: "Customer bought two field phones.",
  });
  assert.equal(
    audits.at(-1).payload_canonical_sha256,
    createHash("sha256").update(expectedPayload).digest("hex"),
    "the audited payload records max_mobile_devices before and after",
  );
  assert.equal(audits.at(-1).reason_code, "MOBILE-SEATS");

  // ── Phones claim their own slots; desktops keep theirs ──────────────────────────────────────
  const phone1 = "fp-phone-1-0001";
  const claimP1 = await enrolPhone(phone1);
  assert.equal(claimP1.status, 200, claimP1.text);
  assert.equal(claimP1.json.device_class, "mobile");
  assert.equal(claimP1.json.device_limit, 2);
  assert.equal(claimP1.json.activated_device_count, 1, "only phones are counted for a phone");
  const envP1 = claimP1.json.entitlement_envelope;
  assert.equal(envP1.machine_slots, 2, "a phone's envelope carries the mobile slots");
  assert.equal(JSON.parse(envP1.policy_json).device_class, "mobile");
  assert.ok(envelopeVerifies(envP1), "mobile envelope signature verifies");
  const tokenP1 = claimP1.json.activation_token;

  // The phone did not take the desktop slot, and the desktop slot is full.
  const desktopB = await claim("fp-desktop-b-0001", "desktop");
  assert.equal(desktopB.status, 409, desktopB.text);
  assert.deepEqual(desktopB.json, { error: "slot_limit_reached", device_class: "desktop", limit: 1, max_machines: 1 });

  const claimP2 = await enrolPhone("fp-phone-2-0001");
  assert.equal(claimP2.status, 200, claimP2.text);
  assert.equal(claimP2.json.activated_device_count, 2);
  const phone3 = await enrolPhone("fp-phone-3-0001");
  assert.equal(phone3.status, 409, phone3.text);
  assert.deepEqual(phone3.json, { error: "slot_limit_reached", device_class: "mobile", limit: 2, max_mobile_devices: 2 });

  // ── A fingerprint keeps its class ───────────────────────────────────────────────────────────
  for (const r of [await claim(desktopA, "mobile"), await preview(desktopA, "mobile")]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "mobile_enrolment_required", "a desktop cannot turn into a phone with the key");
  }
  for (const r of [await claim(phone1), await claim(phone1, "desktop")]) {
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "device_class_mismatch");
    assert.equal(r.json.device_class, "mobile");
    assert.equal(r.json.requested_device_class, "desktop");
  }
  const classes = await api.su("SELECT machine_fingerprint, device_class FROM machine_activations ORDER BY machine_fingerprint");
  assert.deepEqual(
    classes.map((r) => `${r.machine_fingerprint}=${r.device_class}`),
    ["fp-desktop-a-0001=desktop", "fp-phone-1-0001=mobile", "fp-phone-2-0001=mobile"],
    "no activation was re-classed",
  );
  // A refused re-class did not supersede the phone's token.
  const tokenP1b = tokenP1;

  // ── Policy refresh checks the class ─────────────────────────────────────────────────────────
  const refreshA = await refresh(tokenA);
  assert.equal(refreshA.status, 200, refreshA.text);
  assert.equal(refreshA.json.device_class, "desktop", "a desktop sending {} is a desktop");
  assert.equal(refreshA.json.device_limit, 1);
  assert.equal(refreshA.json.activated_device_count, 1);
  assert.equal(JSON.parse(refreshA.json.entitlement_envelope.policy_json).device_class, "desktop");
  const refreshAasMobile = await refresh(tokenA, { device_class: "mobile" });
  assert.equal(refreshAasMobile.status, 409);
  assert.equal(refreshAasMobile.json.error, "device_class_mismatch");
  const refreshP1NoClass = await refresh(tokenP1b);
  assert.equal(refreshP1NoClass.status, 409, "a phone must say it is a phone");
  assert.equal(refreshP1NoClass.json.device_class, "mobile");
  const refreshP1 = await refresh(tokenP1b, { device_class: "mobile" });
  assert.equal(refreshP1.status, 200, refreshP1.text);
  assert.equal(refreshP1.json.device_class, "mobile");
  assert.equal(refreshP1.json.device_limit, 2);
  assert.equal(refreshP1.json.activated_device_count, 2);
  assert.equal(refreshP1.json.entitlement_envelope.machine_slots, 2);
  assert.ok(envelopeVerifies(refreshP1.json.entitlement_envelope));
  const tokenP1c = refreshP1.json.activation_token;

  // ── Sync routes re-check the class of the activation behind the token ───────────────────────
  const v1 = (deviceClass) => ({
    protocol_version: "v1",
    idempotency_key: `v1-${randomUUID()}`,
    outbox_batch: [],
    ...(deviceClass ? { device_class: deviceClass } : {}),
  });
  const v2 = (deviceClass) => ({
    protocol_version: "v2",
    idempotency_key: `v2-${randomUUID()}`,
    checkpoint_token: null,
    current_user_sync_ids: [],
    device_class: deviceClass,
    outbox_batch: [],
  });
  const snapshot = (deviceClass) => ({
    protocol_version: "v2",
    page_token: null,
    page_size: 10,
    scope: "all",
    current_user_sync_ids: [],
    ...(deviceClass ? { device_class: deviceClass } : {}),
  });
  const sync = (path, token, body) => api.call("POST", `/api/v1/sync/${path}`, token, body);

  // Desktop: no device_class (v1, snapshot) stays accepted as a desktop.
  assert.equal((await sync("exchange", tokenA, v1())).status, 200, "v1 desktop without device_class");
  assert.equal((await sync("exchange", tokenA, v1("desktop"))).status, 200);
  assert.equal((await sync("exchange", tokenA, v2("desktop"))).status, 200);
  assert.equal((await sync("snapshot", tokenA, snapshot())).status, 200, "snapshot desktop without device_class");
  // Phone: must send "mobile".
  assert.equal((await sync("exchange", tokenP1c, v1("mobile"))).status, 200);
  assert.equal((await sync("exchange", tokenP1c, v2("mobile"))).status, 200);
  assert.equal((await sync("snapshot", tokenP1c, snapshot("mobile"))).status, 200);
  const mismatches = [
    await sync("exchange", tokenA, v1("mobile")),
    await sync("exchange", tokenA, v2("mobile")),
    await sync("snapshot", tokenA, snapshot("mobile")),
    await sync("exchange", tokenP1c, v1()),
    await sync("exchange", tokenP1c, v2("desktop")),
    await sync("snapshot", tokenP1c, snapshot()),
  ];
  for (const r of mismatches) {
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "device_class_mismatch");
  }
  // A malformed class is still a validation error.
  assert.equal((await sync("snapshot", tokenA, snapshot("tablet"))).status, 400);

  // ── Console: activations and overview count each class ──────────────────────────────────────
  const activations = (await api.call("GET", `/api/v1/tenants/${tenant.id}/activations`, admin)).json;
  const byId = new Map((Array.isArray(activations) ? activations : activations.items).map((a) => [a.machine_id, a]));
  assert.equal(byId.get(desktopA).device_class, "desktop");
  assert.equal(byId.get(phone1).device_class, "mobile");
  const overview = (await api.call("GET", "/api/v1/console/overview", admin)).json;
  const customer = overview.customers.find((c) => c.tenant_id === tenant.id);
  assert.equal(customer.devices_used, 1);
  assert.equal(customer.seats, 1);
  assert.equal(customer.mobile_devices_used, 2);
  assert.equal(customer.mobile_seats, 2);
  assert.equal(overview.figures.mobile_devices_in_use, 2);
  assert.equal(overview.figures.mobile_seats_total, 2);
  assert.equal(overview.figures.mobile_seats_free, 0);
  assert.equal(overview.figures.seats_free, 0);

  // ── Reinstatement needs a free slot of the device's own class ───────────────────────────────
  const machineAction = async (fingerprint, action) =>
    api.call(
      "POST",
      `/api/v1/tenants/${tenant.id}/machines/${encodeURIComponent(fingerprint)}/${action}`,
      admin,
      { reason: `integration ${action}` },
      await privileged(`MACHINE-${action.toUpperCase()}`, "machine_trust_change"),
    );
  assert.equal((await machineAction("fp-phone-2-0001", "revoke")).status, 200);
  assert.equal((await enrolPhone("fp-phone-3-0001")).status, 200, "the revoked phone's slot is free for another phone");
  const reinstate = await machineAction("fp-phone-2-0001", "reinstate");
  assert.equal(reinstate.status, 409, reinstate.text);
  assert.deepEqual(reinstate.json, { error: "slot_limit_reached", device_class: "mobile", limit: 2, max_mobile_devices: 2 });
  const released = await machineAction("fp-phone-3-0001", "release");
  assert.equal(released.status, 200, released.text);
  assert.equal(released.json.device_class, "mobile");
  assert.equal(released.json.active_slots, 1);
  assert.equal((await machineAction("fp-phone-2-0001", "reinstate")).status, 200, "reinstated on a freed phone slot");

  // ── Setting the count back to 0 stops phones, never desktops ────────────────────────────────
  const zero = await api.call("PATCH", `/api/v1/licenses/${licence.id}`, admin, { max_mobile_devices: 0 });
  assert.equal(zero.status, 200, zero.text);
  const p1Refused = await refresh(tokenP1c, { device_class: "mobile" });
  assert.equal(p1Refused.status, 403);
  assert.equal(p1Refused.json.error, "mobile_not_licensed");
  // Sync stops the phone at once too (exchange v1/v2 and snapshot), never the desktop.
  for (const [path, body] of [
    ["exchange", v1("mobile")],
    ["exchange", v2("mobile")],
    ["snapshot", snapshot("mobile")],
  ]) {
    const r = await sync(path, tokenP1c, body);
    assert.equal(r.status, 403, `${path} ${body.protocol_version}: ${r.text}`);
    assert.equal(r.json.error, "mobile_not_licensed");
  }
  assert.equal((await sync("exchange", tokenA, v2("desktop"))).status, 200, "the desktop still syncs");
  assert.equal((await enrolPhone("fp-phone-4-0001")).json.error, "mobile_not_licensed");
  assert.equal((await refresh(tokenA)).status, 200, "the desktop is not affected");

  // ── A licence can be issued with phones ─────────────────────────────────────────────────────
  const withPhones = await api.call(
    "POST",
    "/api/v1/licenses",
    admin,
    { tenant_id: tenant.id, max_machines: 2, max_mobile_devices: 5, expires_at: "2099-01-01T00:00:00.000Z" },
    idem(),
  );
  assert.equal(withPhones.status, 201, withPhones.text);
  assert.equal(withPhones.json.max_mobile_devices, 5);
  assert.equal(
    (await api.call("POST", "/api/v1/licenses", admin, { tenant_id: tenant.id, max_mobile_devices: 1001 }, idem())).status,
    400,
  );

  // ── Schema: the class and the count are constrained ─────────────────────────────────────────
  await assert.rejects(
    api.su("UPDATE machine_activations SET device_class = 'tablet' WHERE machine_fingerprint = $1", [desktopA]),
    /machine_activations_device_class_check/,
  );
  await assert.rejects(
    api.su("UPDATE license_keys SET max_mobile_devices = -1 WHERE id = $1", [licence.id]),
    /license_keys_max_mobile_devices_check/,
  );

  console.log("mobile-device-class: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

/**
 * Admin-issued phone enrolment (migration 020) on the real API and a real Postgres:
 * - an activated desktop issues an enrolment for one person at one site (refused without a free
 *   phone slot, counting open enrolments; refused to phones); only hashes of its secrets are stored;
 * - the phone redeems the QR token or the typed code once (case, dashes and look-alike letters
 *   ignored), within 15 minutes, unless cancelled; it gets a device token, a signed mobile envelope
 *   and its person / site binding; an enrolled phone cannot take a second enrolment;
 * - the desktop lists its phones (person, site, enrolled by / at, last sync) and revokes one, or every
 *   phone of a disabled person; the slot is free at once; the revoked phone may only upload (push
 *   only: nothing comes back) and confirm its wipe, then its token is refused everywhere;
 * - another tenant's desktop sees none of it; each step is in the audit ledger.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { startControlApi } from "./lib/control-api.mjs";

const api = await startControlApi({ port: 33281 });

function item(entityType, entitySyncId, payload) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: "create",
    row_version: 1,
    base_row_version: null,
    payload_json,
    payload_hash: createHash("sha256").update(payload_json).digest("hex"),
  };
}

try {
  const admin = await api.adminToken();
  let opCounter = 0;
  const idem = () => ({ "Idempotency-Key": `mobile-enrol-${(opCounter += 1)}` });

  async function customer(slug, maxMobile) {
    const tenant = (await api.call("POST", "/api/v1/tenants", admin, { slug, display_name: slug })).json;
    assert.ok(tenant?.id, "tenant create must succeed");
    const lic = await api.call(
      "POST",
      "/api/v1/licenses",
      admin,
      { tenant_id: tenant.id, max_machines: 2, max_mobile_devices: maxMobile, expires_at: "2099-01-01T00:00:00.000Z" },
      idem(),
    );
    assert.equal(lic.status, 201, lic.text);
    const desk = await api.call("POST", "/api/v1/activation/claim", null, {
      license_key: lic.json.license_key,
      machine_fingerprint: `fp-${slug}-desk`,
      app_version: "1.2.3",
    });
    assert.equal(desk.status, 200, desk.text);
    return { tenant, licence: lic.json, desk: desk.json.activation_token };
  }

  const a = await customer("enrol-a", 2);
  const b = await customer("enrol-b", 1);

  const person = (n) => ({
    person_sync_id: `user-${n}`,
    person_label: `Technicien ${n}`,
    site_sync_id: "site-nord",
    site_label: "Usine Nord",
    issued_by_sync_id: "user-admin",
    issued_by_label: "Admin Principal",
  });
  const issue = (desk, n) => api.call("POST", "/api/v1/mobile-enrolments", desk, person(n));
  const redeem = (secret, fingerprint) =>
    api.call("POST", "/api/v1/mobile-enrolments/redeem", null, {
      ...secret,
      machine_fingerprint: fingerprint,
      machine_label: "Mobile (test)",
      app_version: "1.2.3",
      device_class: "mobile",
    });
  const status = (desk, id) => api.call("GET", `/api/v1/mobile-enrolments/${id}`, desk);
  const actor = { actor_sync_id: "user-admin", actor_label: "Admin Principal" };
  const refresh = (token) => api.call("POST", "/api/v1/activation/policy-refresh", token, { device_class: "mobile" });
  const v2 = (outbox = []) => ({
    protocol_version: "v2",
    idempotency_key: `v2-${randomUUID()}`,
    checkpoint_token: null,
    current_user_sync_ids: [],
    device_class: "mobile",
    outbox_batch: outbox,
  });
  const exchange = (token, body) => api.call("POST", "/api/v1/sync/exchange", token, body);
  const list = (desk) => api.call("GET", "/api/v1/mobile-devices", desk);

  // ── Issue: validated, desktops only, licence must count phones ──────────────────────────────
  assert.equal((await api.call("POST", "/api/v1/mobile-enrolments", a.desk, { person_sync_id: "x" })).status, 400);
  assert.equal((await api.call("POST", "/api/v1/mobile-enrolments", null, person(1))).status, 401);
  const zero = await customer("enrol-zero", 0);
  const refusedZero = await issue(zero.desk, 1);
  assert.equal(refusedZero.status, 403, refusedZero.text);
  assert.equal(refusedZero.json.error, "mobile_not_licensed");

  const e1 = await issue(a.desk, 1);
  assert.equal(e1.status, 201, e1.text);
  assert.match(e1.json.token, /^[A-Za-z0-9_-]{43}$/, "QR token: 32 random bytes, base64url");
  assert.match(e1.json.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, "typed code: XXXX-XXXX, Crockford base32");
  const ttl = Date.parse(e1.json.expires_at) - Date.parse(e1.json.issued_at);
  assert.equal(ttl, 15 * 60 * 1000, "an enrolment lasts 15 minutes");
  const stored = await api.su("SELECT * FROM mobile_enrolments WHERE id = $1", [e1.json.enrolment_id]);
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(e1.json.token), "the token is not stored");
  assert.ok(!JSON.stringify(stored).includes(e1.json.code.replace("-", "")), "the code is not stored");
  assert.equal(stored[0].issued_by_machine, "fp-enrol-a-desk");
  assert.equal((await status(a.desk, e1.json.enrolment_id)).json.status, "pending");

  // ── Slots: open enrolments count; the same person's open one is replaced ─────────────────────
  const e2 = await issue(a.desk, 2);
  assert.equal(e2.status, 201, e2.text);
  const full = await issue(a.desk, 3);
  assert.equal(full.status, 409, full.text);
  assert.deepEqual(full.json, { error: "slot_limit_reached", device_class: "mobile", limit: 2, max_mobile_devices: 2 });
  const e2b = await issue(a.desk, 2);
  assert.equal(e2b.status, 201, "a new QR for the same person replaces the open one");
  assert.equal((await status(a.desk, e2.json.enrolment_id)).json.status, "cancelled");

  // ── Redeem: wrong, unknown or malformed secrets ─────────────────────────────────────────────
  for (const bad of [{ code: "ZZZZ-ZZZZ" }, { code: "short" }, { token: "x".repeat(43) }]) {
    const r = await redeem(bad, "fp-phone-x");
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.error, "enrolment_invalid");
  }
  assert.equal((await redeem({}, "fp-phone-x")).status, 400, "token or code is required");
  assert.equal((await redeem({ token: e1.json.token, code: e1.json.code }, "fp-phone-x")).status, 400, "not both");
  const asDesktop = await api.call("POST", "/api/v1/mobile-enrolments/redeem", null, {
    token: e1.json.token,
    machine_fingerprint: "fp-phone-x",
    device_class: "desktop",
  });
  assert.equal(asDesktop.status, 400, "only phones redeem");

  // ── Redeem with the typed code (lower case, no dash, O for 0, L for 1) ─────────────────────
  const typed = e1.json.code.replace("-", "").toLowerCase().replace(/0/g, "o").replace(/1/g, "l");
  const p1 = await redeem({ code: typed }, "fp-phone-1");
  assert.equal(p1.status, 200, p1.text);
  assert.equal(p1.json.device_class, "mobile");
  assert.equal(p1.json.device_limit, 2);
  assert.equal(JSON.parse(p1.json.entitlement_envelope.policy_json).device_class, "mobile");
  const { enrolled_at: enrolledAt, ...binding } = p1.json.enrolment;
  assert.ok(enrolledAt);
  assert.deepEqual(binding, {
    enrolment_id: e1.json.enrolment_id,
    person_sync_id: "user-1",
    person_label: "Technicien 1",
    site_sync_id: "site-nord",
    site_label: "Usine Nord",
  });
  assert.ok(!JSON.stringify(p1.json).includes(a.licence.license_key), "the licence key never reaches the phone");
  const tokenP1 = p1.json.activation_token;
  assert.equal((await refresh(tokenP1)).status, 200, "the device token works");
  const st1 = (await status(a.desk, e1.json.enrolment_id)).json;
  assert.equal(st1.status, "redeemed");
  assert.ok(st1.device_id);

  // Single use: neither the code nor the QR token works again.
  assert.equal((await redeem({ code: e1.json.code }, "fp-phone-9")).status, 404);
  assert.equal((await redeem({ token: e1.json.token }, "fp-phone-9")).status, 404);
  // A cancelled (replaced) enrolment is refused.
  assert.equal((await redeem({ token: e2.json.token }, "fp-phone-9")).status, 404);

  // An enrolled phone cannot take another enrolment.
  const again = await redeem({ token: e2b.json.token }, "fp-phone-1");
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.error, "already_enrolled");
  assert.equal((await status(a.desk, e2b.json.enrolment_id)).json.status, "pending", "the refused enrolment is still usable");

  // Expiry.
  await api.su(
    "UPDATE mobile_enrolments SET issued_at = now() - interval '1 hour', expires_at = now() - interval '45 minutes' WHERE id = $1",
    [e2b.json.enrolment_id],
  );
  assert.equal((await redeem({ token: e2b.json.token }, "fp-phone-2")).status, 404, "an expired enrolment is refused");
  assert.equal((await status(a.desk, e2b.json.enrolment_id)).json.status, "expired");

  // Cancel.
  const e3 = await issue(a.desk, 3);
  assert.equal(e3.status, 201, "the expired enrolment no longer holds a slot");
  const cancel = await api.call("POST", `/api/v1/mobile-enrolments/${e3.json.enrolment_id}/cancel`, a.desk, actor);
  assert.equal(cancel.status, 200, cancel.text);
  assert.deepEqual(cancel.json, { enrolment_id: e3.json.enrolment_id, status: "cancelled", changed: true });
  assert.equal((await redeem({ token: e3.json.token }, "fp-phone-3")).status, 404);
  const cancelAgain = await api.call("POST", `/api/v1/mobile-enrolments/${e3.json.enrolment_id}/cancel`, a.desk, actor);
  assert.equal(cancelAgain.json.changed, false);

  // A second phone, for person 3; then the licence is full.
  const e4 = await issue(a.desk, 3);
  assert.equal(e4.status, 201, e4.text);
  const p3 = await redeem({ token: e4.json.token }, "fp-phone-3");
  assert.equal(p3.status, 200, p3.text);
  const tokenP3 = p3.json.activation_token;
  assert.equal((await issue(a.desk, 4)).status, 409, "two phones enrolled: no free slot");

  // ── Phones cannot use desktop routes; other tenants see nothing ──────────────────────────────
  for (const r of [
    await issue(tokenP1, 5),
    await list(tokenP1),
    await status(tokenP1, e1.json.enrolment_id),
    await api.call("POST", `/api/v1/mobile-devices/${st1.device_id}/revoke`, tokenP1, actor),
  ]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "desktop_only");
  }
  assert.equal((await status(b.desk, e1.json.enrolment_id)).status, 404);
  assert.equal((await api.call("POST", `/api/v1/mobile-enrolments/${e4.json.enrolment_id}/cancel`, b.desk, actor)).status, 404);
  assert.equal((await api.call("POST", `/api/v1/mobile-devices/${st1.device_id}/revoke`, b.desk, actor)).status, 404);
  assert.deepEqual((await list(b.desk)).json.devices, []);

  // ── List: person, site, enrolled by / at, last sync ─────────────────────────────────────────
  assert.equal((await exchange(tokenP1, v2())).status, 200, "phone 1 syncs once");
  const listed = await list(a.desk);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.max_mobile_devices, 2);
  assert.equal(listed.json.active_mobile_devices, 2);
  assert.equal(listed.json.open_enrolments, 0);
  const d1 = listed.json.devices.find((d) => d.person_sync_id === "user-1");
  assert.equal(d1.person_label, "Technicien 1");
  assert.equal(d1.site_label, "Usine Nord");
  assert.equal(d1.enrolled_by_label, "Admin Principal");
  assert.equal(d1.status, "active");
  assert.ok(d1.enrolled_at);
  assert.ok(d1.last_sync_at, "last sync is shown once the phone exchanged");
  assert.equal(listed.json.devices.find((d) => d.person_sync_id === "user-3").last_sync_at, null);

  // ── Revoke: slot free at once; upload only, then wipe ───────────────────────────────────────
  const desktopPush = await exchange(a.desk, {
    ...v2([item("equipment", "eq-after-revoke", { code: "EQ-R", name: "Pompe" })]),
    device_class: "desktop",
  });
  assert.equal(desktopPush.status, 200, desktopPush.text);

  // An exchange answered before the phone is removed, whose answer was lost: the phone retries it.
  const beforeRevoke = v2();
  const firstAnswer = await exchange(tokenP1, beforeRevoke);
  assert.equal(firstAnswer.status, 200, firstAnswer.text);
  assert.ok(firstAnswer.json.inbound_items.length > 0, "the desktop's change reached the phone while it was enrolled");

  const revoke = await api.call("POST", `/api/v1/mobile-devices/${d1.device_id}/revoke`, a.desk, actor);
  assert.equal(revoke.status, 200, revoke.text);
  assert.equal(revoke.json.revoked_now, true);
  const afterRevoke = (await list(a.desk)).json;
  assert.equal(afterRevoke.active_mobile_devices, 1, "the slot is free at once");
  assert.equal(afterRevoke.devices.find((d) => d.device_id === d1.device_id).status, "wipe_pending");
  const e5 = await issue(a.desk, 5);
  assert.equal(e5.status, 201, "the freed slot can be enrolled again");

  const wipeRequired = await refresh(tokenP1);
  assert.equal(wipeRequired.status, 403, wipeRequired.text);
  assert.equal(wipeRequired.json.error, "device_wipe_required");
  for (const r of [
    await api.call("POST", "/api/v1/sync/snapshot", tokenP1, {
      protocol_version: "v2",
      page_token: null,
      page_size: 10,
      scope: "all",
      current_user_sync_ids: [],
      device_class: "mobile",
    }),
    await exchange(tokenP1, { protocol_version: "v1", idempotency_key: `v1-${randomUUID()}`, outbox_batch: [], device_class: "mobile" }),
    await api.call("GET", "/api/v1/activation/tenant-status", tokenP1),
  ]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "device_wipe_required");
  }
  const finalUpload = await exchange(tokenP1, v2([item("equipment", "eq-from-phone", { code: "EQ-P", name: "Vanne" })]));
  assert.equal(finalUpload.status, 200, finalUpload.text);
  assert.equal(finalUpload.json.acknowledged_items.length, 1, "the pending work is accepted");
  assert.deepEqual(finalUpload.json.inbound_items, [], "nothing goes back to a removed phone");
  assert.deepEqual(finalUpload.json.conflict_items, []);
  assert.deepEqual(finalUpload.json.user_snapshot_required, []);
  assert.equal(finalUpload.json.has_more, false);
  const replay = await exchange(tokenP1, beforeRevoke);
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.json.inbound_items, [], "a replayed answer sends nothing back to a removed phone");
  assert.deepEqual(replay.json.conflict_items, []);
  assert.deepEqual(replay.json.user_snapshot_required, []);
  const [revokedRow] = await api.su("SELECT revoked_by_sync_id, revoke_reason FROM machine_activations WHERE id = $1", [d1.device_id]);
  assert.deepEqual(revokedRow, { revoked_by_sync_id: "user-admin", revoke_reason: "admin" });

  const wiped = await api.call("POST", "/api/v1/mobile-device/wipe-confirmed", tokenP1, {});
  assert.equal(wiped.status, 200, wiped.text);
  for (const r of [await refresh(tokenP1), await exchange(tokenP1, v2())]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "activation_revoked");
  }
  assert.ok(!(await list(a.desk)).json.devices.some((d) => d.device_id === d1.device_id), "a wiped phone leaves the list");
  assert.equal((await api.call("POST", "/api/v1/mobile-device/wipe-confirmed", tokenP3, {})).status, 409, "only a removed phone confirms a wipe");

  // ── A disabled person: every phone and open enrolment ───────────────────────────────────────
  assert.equal((await issue(a.desk, 6)).status, 409, "person 3 holds a phone and person 5 an open enrolment: full");
  const byPerson = await api.call("POST", "/api/v1/mobile-devices/revoke-person", a.desk, { ...actor, person_sync_id: "user-3" });
  assert.equal(byPerson.status, 200, byPerson.text);
  assert.equal(byPerson.json.revoked_device_ids.length, 1);
  assert.equal((await refresh(tokenP3)).json.error, "device_wipe_required");
  const byPersonOpen = await api.call("POST", "/api/v1/mobile-devices/revoke-person", a.desk, { ...actor, person_sync_id: "user-5" });
  assert.deepEqual(byPersonOpen.json.revoked_device_ids, []);
  assert.deepEqual(byPersonOpen.json.cancelled_enrolment_ids, [e5.json.enrolment_id], "a disabled person's QR is cancelled");
  assert.equal((await redeem({ token: e5.json.token }, "fp-phone-5")).status, 404);

  // ── A wiped phone can be enrolled again ─────────────────────────────────────────────────────
  const e7 = await issue(a.desk, 7);
  assert.equal(e7.status, 201, e7.text);
  // ...but not one still waiting to erase its previous person's data.
  const notWiped = await redeem({ token: e7.json.token }, "fp-phone-3");
  assert.equal(notWiped.status, 409, notWiped.text);
  assert.equal(notWiped.json.error, "wipe_pending");
  const reEnrolled = await redeem({ token: e7.json.token }, "fp-phone-1");
  assert.equal(reEnrolled.status, 200, reEnrolled.text);
  assert.equal(reEnrolled.json.enrolment.person_sync_id, "user-7");
  assert.equal((await refresh(reEnrolled.json.activation_token)).status, 200);

  // ── The final upload is limited in time; a lost phone gets none ─────────────────────────────
  await api.su("UPDATE machine_activations SET revoked_at = now() - interval '169 hours' WHERE machine_fingerprint = 'fp-phone-3'");
  const late = await exchange(tokenP3, v2());
  assert.equal(late.status, 403, late.text);
  assert.equal(late.json.error, "activation_revoked", "past the upload window the phone is simply revoked");
  const lostRevoke = await api.call("POST", `/api/v1/mobile-devices/${(await status(a.desk, e7.json.enrolment_id)).json.device_id}/revoke`, a.desk, { ...actor, lost: true });
  assert.equal(lostRevoke.status, 200, lostRevoke.text);
  for (const r of [await refresh(reEnrolled.json.activation_token), await exchange(reEnrolled.json.activation_token, v2())]) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error, "activation_revoked", "a lost phone uploads nothing");
  }
  assert.equal((await list(a.desk)).json.devices.find((d) => d.person_sync_id === "user-7").lost, true);

  // ── Audit ledger ────────────────────────────────────────────────────────────────────────────
  const audits = await api.su(
    `SELECT action_code, count(*)::int AS n FROM audit_records
     WHERE action_code LIKE 'mobile_%' GROUP BY action_code ORDER BY action_code`,
  );
  const counts = Object.fromEntries(audits.map((r) => [r.action_code, r.n]));
  assert.equal(counts.mobile_enrolment_issued, 7, JSON.stringify(counts));
  assert.equal(counts.mobile_enrolment_redeemed, 3, JSON.stringify(counts));
  assert.equal(counts.mobile_enrolment_cancelled, 2, JSON.stringify(counts));
  assert.equal(counts.mobile_device_revoked, 3, JSON.stringify(counts));
  assert.equal(counts.mobile_device_wiped, 1, JSON.stringify(counts));

  // ── Schema constraints ──────────────────────────────────────────────────────────────────────
  await assert.rejects(
    api.su("UPDATE machine_activations SET revoke_reason = 'other' WHERE machine_fingerprint = 'fp-phone-1'"),
    /machine_activations_revoke_reason_check/,
  );
  await assert.rejects(
    api.su("UPDATE mobile_enrolments SET cancelled_at = now() WHERE id = $1", [e7.json.enrolment_id]),
    /mobile_enrolments_single_end_check/,
  );

  console.log("mobile-enrolment: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

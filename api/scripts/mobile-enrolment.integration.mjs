/**
 * Admin-issued phone enrolment (migration 020) on the real API and a real Postgres:
 * - an activated desktop issues an enrolment for one person at one site (refused without a free
 *   phone slot, counting open enrolments; refused to phones); only hashes of its secrets are stored;
 * - the phone redeems the QR token or the typed code once (case, dashes and look-alike letters
 *   ignored), within 15 minutes, unless cancelled; it gets a device token, a signed mobile envelope
 *   and its person / site binding; an enrolled phone cannot take a second enrolment;
 * - a redeem whose answer was lost is answered again for the same phone only (same token, no second
 *   slot, a "replayed" audit event), within the enrolment's 15 minutes, never once revoked; two
 *   concurrent redeems of one secret give one activation;
 * - the desktop lists its phones (person, site, enrolled by / at, last sync) and revokes one, or every
 *   phone of a disabled person; the slot is free at once; the revoked phone may only upload (push
 *   only: nothing comes back), presign uploads of the files of its own work (never downloads, never
 *   another device's files) and confirm its wipe (with what it dropped), then its token is refused
 *   everywhere;
 * - activation_revoked carries the erase marker (wipe: without_upload) only for a phone reported lost
 *   or past its upload window; a missing activation row, a vendor revocation and a released slot
 *   answer without it;
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

  // Replay: the answer was lost on mobile data; the same phone presents the same enrolment again
  // (here its QR token after the typed code: either secret of that enrolment).
  // (Redeems and claims share a limit of 30 per address per 15 minutes: this test stays below it.)
  const p1Again = await redeem({ token: e1.json.token }, "fp-phone-1");
  assert.equal(p1Again.status, 200, p1Again.text);
  assert.equal(p1Again.json.activation_token, tokenP1, "the same activation and token");
  assert.deepEqual(p1Again.json.enrolment, p1.json.enrolment, "the same binding, the original enrolled_at");
  assert.equal(p1Again.json.activated_device_count, 1, "no second slot");
  assert.equal(JSON.parse(p1Again.json.entitlement_envelope.policy_json).device_class, "mobile");
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
  // Files of the final upload: presign-put only, only for this phone's own announced media.
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const mediaKey = (parentType, parentId, digest) => `ci/media/${a.tenant.id}/${parentType}/${parentId}/${digest}`;
  const shaPhone = sha("phone photo");
  const keyPhone = mediaKey("work_orders", "wo-1", shaPhone);
  const shaAlone = sha("announced without its record");
  const keyAlone = mediaKey("work_orders", "wo-1", shaAlone);
  const shaDesk = sha("desktop photo");
  const keyDesk = mediaKey("equipment", "eq-after-revoke", shaDesk);
  const presignPut = (token, parentType, parentId, digest, key) =>
    api.call("POST", "/api/v1/sync/media/presign-put", token, {
      parent_entity_type: parentType,
      parent_entity_sync_id: parentId,
      content_sha256: digest,
      object_key: key,
    });
  const deskMedia = await exchange(a.desk, {
    ...v2([item("media_attachments", "ma-desk-1", { object_key: keyDesk })]),
    device_class: "desktop",
    media_manifest: [{ entity_sync_id: "ma-desk-1", content_sha256: shaDesk, object_key: keyDesk, byte_size: 13 }],
  });
  assert.equal(deskMedia.status, 200, deskMedia.text);
  const phoneMedia = await exchange(tokenP1, {
    ...v2([item("media_attachments", "ma-phone-1", { object_key: keyPhone })]),
    media_manifest: [
      { entity_sync_id: "ma-phone-1", content_sha256: shaPhone, object_key: keyPhone, byte_size: 11 },
      { entity_sync_id: "ma-phone-2", content_sha256: shaAlone, object_key: keyAlone, byte_size: 28 },
    ],
  });
  assert.equal(phoneMedia.status, 200, phoneMedia.text);
  assert.equal(phoneMedia.json.acknowledged_items.length, 1);
  // Allowed: past the guard and the ownership check it reaches the object store (none is
  // configured in this test, hence 503; the real upload is in media-presign.integration.mjs).
  const ownPut = await presignPut(tokenP1, "work_orders", "wo-1", shaPhone, keyPhone);
  assert.equal(ownPut.status, 503, ownPut.text);
  assert.equal(ownPut.json.error, "object_storage_unavailable");
  for (const [label, r] of [
    ["another device's file", await presignPut(tokenP1, "equipment", "eq-after-revoke", shaDesk, keyDesk)],
    ["announced without its record", await presignPut(tokenP1, "work_orders", "wo-1", shaAlone, keyAlone)],
    ["never announced", await presignPut(tokenP1, "work_orders", "wo-1", sha("other"), mediaKey("work_orders", "wo-1", sha("other")))],
    ["key not matching the body", await presignPut(tokenP1, "work_orders", "wo-2", shaPhone, keyPhone)],
    ["non-canonical key", await presignPut(tokenP1, "work_orders", "wo-1", shaPhone, `${keyPhone}/x`)],
  ]) {
    assert.equal(r.status, 403, `${label}: ${r.text}`);
    assert.equal(r.json.error, "media_not_from_this_device", label);
  }
  const getRefused = await api.call("POST", "/api/v1/sync/media/presign-get", tokenP1, { object_key: keyPhone });
  assert.equal(getRefused.status, 403, getRefused.text);
  assert.equal(getRefused.json.error, "device_wipe_required", "a removed phone downloads nothing");
  // The ownership check is for removed phones only: an enrolled phone is not limited by it.
  const activePut = await presignPut(tokenP3, "equipment", "eq-after-revoke", shaDesk, keyDesk);
  assert.equal(activePut.status, 503, activePut.text);

  const replay = await exchange(tokenP1, beforeRevoke);
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.json.inbound_items, [], "a replayed answer sends nothing back to a removed phone");
  assert.deepEqual(replay.json.conflict_items, []);
  assert.deepEqual(replay.json.user_snapshot_required, []);
  const [revokedRow] = await api.su("SELECT revoked_by_sync_id, revoke_reason FROM machine_activations WHERE id = $1", [d1.device_id]);
  assert.deepEqual(revokedRow, { revoked_by_sync_id: "user-admin", revoke_reason: "admin" });

  // The wipe confirmation: an invalid body changes nothing; what was dropped is audited.
  const wipe = (token, body) => api.call("POST", "/api/v1/mobile-device/wipe-confirmed", token, body);
  for (const bad of [
    { dropped: { total: -1, by_kind: {} } },
    { dropped: { total: 1.5, by_kind: {} } },
    { dropped: { total: 1 } },
    { dropped: { total: 1, by_kind: { work_orders: -1 } } },
    { dropped: { total: 1, by_kind: { ["k".repeat(65)]: 1 } } },
    { dropped: { total: 1, by_kind: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`kind_${i}`, 1])) } },
    { dropped: { total: 1, by_kind: {}, extra: 1 } },
    { dropped_total: 1 },
  ]) {
    const r = await wipe(tokenP1, bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad).slice(0, 80)}: ${r.text}`);
  }
  const [notWipedYet] = await api.su("SELECT wiped_at FROM machine_activations WHERE id = $1", [d1.device_id]);
  assert.equal(notWipedYet.wiped_at, null, "an invalid confirmation changes nothing");
  assert.equal((await refresh(tokenP1)).json.error, "device_wipe_required");
  const dropped = { total: 3, by_kind: { work_orders: 1, media_attachments: 2 } };
  const wiped = await wipe(tokenP1, { dropped });
  assert.equal(wiped.status, 200, wiped.text);
  const [wipedAudit] = await api.su(
    "SELECT payload_canonical_sha256 FROM audit_records WHERE action_code = 'mobile_device_wiped' ORDER BY sequence DESC LIMIT 1",
  );
  assert.equal(
    wipedAudit.payload_canonical_sha256,
    sha(JSON.stringify({ device_id: d1.device_id, dropped })),
    "what the phone dropped is in the audit ledger",
  );
  for (const r of [await refresh(tokenP1), await exchange(tokenP1, v2()), await presignPut(tokenP1, "work_orders", "wo-1", shaPhone, keyPhone)]) {
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(
      [r.json.error, r.json.wipe, r.json.reason],
      ["activation_revoked", "without_upload", "upload_window_closed"],
      "a wiped phone is told to erase without uploading",
    );
  }
  assert.ok(!(await list(a.desk)).json.devices.some((d) => d.device_id === d1.device_id), "a wiped phone leaves the list");
  assert.equal((await api.call("POST", "/api/v1/mobile-device/wipe-confirmed", tokenP3, {})).status, 409, "only a removed phone confirms a wipe");
  assert.equal((await api.call("POST", "/api/v1/mobile-device/wipe-confirmed", tokenP3)).status, 409, "no body at all is accepted as empty");

  // ── A disabled person: every phone and open enrolment ───────────────────────────────────────
  assert.equal((await issue(a.desk, 6)).status, 409, "person 3 holds a phone and person 5 an open enrolment: full");
  const byPerson = await api.call("POST", "/api/v1/mobile-devices/revoke-person", a.desk, { ...actor, person_sync_id: "user-3" });
  assert.equal(byPerson.status, 200, byPerson.text);
  assert.equal(byPerson.json.revoked_device_ids.length, 1);
  assert.equal((await refresh(tokenP3)).json.error, "device_wipe_required");
  // An automatic revocation by the desktop may name no actor (null), never an empty one.
  const emptyActor = await api.call("POST", "/api/v1/mobile-devices/revoke-person", a.desk, { actor_sync_id: "", actor_label: "Automatique", person_sync_id: "user-5" });
  assert.equal(emptyActor.status, 400, emptyActor.text);
  const byPersonOpen = await api.call("POST", "/api/v1/mobile-devices/revoke-person", a.desk, { actor_sync_id: null, actor_label: "Automatique", person_sync_id: "user-5" });
  assert.equal(byPersonOpen.status, 200, byPersonOpen.text);
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
  assert.deepEqual(
    [late.json.error, late.json.wipe, late.json.reason],
    ["activation_revoked", "without_upload", "upload_window_closed"],
    "past the upload window the phone erases without uploading",
  );
  const lostRevoke = await api.call("POST", `/api/v1/mobile-devices/${(await status(a.desk, e7.json.enrolment_id)).json.device_id}/revoke`, a.desk, { ...actor, lost: true });
  assert.equal(lostRevoke.status, 200, lostRevoke.text);
  for (const r of [await refresh(reEnrolled.json.activation_token), await exchange(reEnrolled.json.activation_token, v2())]) {
    assert.equal(r.status, 403, r.text);
    assert.deepEqual([r.json.error, r.json.wipe, r.json.reason], ["activation_revoked", "without_upload", "lost"], "a lost phone uploads nothing");
  }
  // Lost wins over the tenant's state: a suspended tenant's lost phone still erases.
  await api.su("UPDATE tenants SET is_active = 0 WHERE id = $1", [a.tenant.id]);
  const lostSuspended = await refresh(reEnrolled.json.activation_token);
  assert.deepEqual([lostSuspended.status, lostSuspended.json.wipe, lostSuspended.json.reason], [403, "without_upload", "lost"]);
  await api.su("UPDATE tenants SET is_active = 1 WHERE id = $1", [a.tenant.id]);
  const afterLost = (await list(a.desk)).json.devices;
  assert.ok(!afterLost.some((d) => d.person_sync_id === "user-7"), "a lost phone leaves the list at once");
  assert.ok(!afterLost.some((d) => d.person_sync_id === "user-3"), "so does a removed phone past its upload window");
  // A removed phone that never came back within the window can be enrolled again.
  const e8 = await issue(a.desk, 8);
  assert.equal(e8.status, 201, e8.text);
  const afterWindow = await redeem({ token: e8.json.token }, "fp-phone-3");
  assert.equal(afterWindow.status, 200, afterWindow.text);

  // ── Concurrent redeems of one secret ────────────────────────────────────────────────────────
  // Same phone twice (a retry racing the first request): one activation, both answers alike.
  const e9 = await issue(a.desk, 9);
  assert.equal(e9.status, 201, e9.text);
  const [r9a, r9b] = await Promise.all([redeem({ token: e9.json.token }, "fp-phone-9"), redeem({ token: e9.json.token }, "fp-phone-9")]);
  assert.deepEqual([r9a.status, r9b.status], [200, 200], `${r9a.text} ${r9b.text}`);
  assert.equal(r9a.json.activation_token, r9b.json.activation_token, "one activation for both answers");
  assert.deepEqual(r9a.json.enrolment, r9b.json.enrolment);
  const [{ n: phone9Rows }] = await api.su("SELECT count(*)::int AS n FROM machine_activations WHERE machine_fingerprint = 'fp-phone-9'");
  assert.equal(phone9Rows, 1);
  // Not once the phone is revoked, even within the 15 minutes.
  const phone9 = (await status(a.desk, e9.json.enrolment_id)).json.device_id;
  assert.equal((await api.call("POST", `/api/v1/mobile-devices/${phone9}/revoke`, a.desk, actor)).status, 200);
  const replayRevoked = await redeem({ token: e9.json.token }, "fp-phone-9");
  assert.equal(replayRevoked.status, 404, replayRevoked.text);
  assert.equal(replayRevoked.json.error, "enrolment_invalid");

  // Two phones racing for one secret: exactly one gets it. Whichever ran second was refused as a
  // replay by another phone (the first one to run always wins).
  const eb = await issue(b.desk, 1);
  assert.equal(eb.status, 201, eb.text);
  const race = await Promise.all([redeem({ token: eb.json.token }, "fp-b-phone-1"), redeem({ token: eb.json.token }, "fp-b-phone-2")]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 404], race.map((r) => r.text).join(" "));
  const winner = race[0].status === 200 ? "fp-b-phone-1" : "fp-b-phone-2";
  const tokenB = race.find((r) => r.status === 200).json.activation_token;
  assert.equal(race.find((r) => r.status === 404).json.error, "enrolment_invalid");
  // After the enrolment's 15 minutes, no replay.
  await api.su(
    "UPDATE mobile_enrolments SET issued_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes', redeemed_at = now() - interval '6 minutes' WHERE id = $1",
    [eb.json.enrolment_id],
  );
  assert.equal((await redeem({ token: eb.json.token }, winner)).status, 404, "no replay after the enrolment's lifetime");

  // ── activation_revoked without the erase marker: the phone locks and keeps its data ─────────
  const privileged = async (reason) => ({
    ...idem(),
    "X-Operator-Reason": reason,
    "X-Step-Up-Token": await api.stepUpToken(admin, "machine_trust_change"),
  });
  const machineAction = async (tenantId, fingerprint, action) =>
    api.call(
      "POST",
      `/api/v1/tenants/${tenantId}/machines/${encodeURIComponent(fingerprint)}/${action}`,
      admin,
      { reason: `integration ${action}` },
      await privileged(`MACHINE-${action.toUpperCase()}`),
    );
  const noMarker = (r, label) => {
    assert.equal(r.status, 403, `${label}: ${r.text}`);
    assert.equal(r.json.error, "activation_revoked", label);
    assert.equal(r.json.wipe, undefined, `${label}: no erase marker`);
    assert.equal(r.json.reason, undefined, label);
  };
  // A slot released by the vendor.
  assert.equal((await machineAction(b.tenant.id, winner, "release")).status, 200);
  noMarker(await refresh(tokenB), "released slot");
  noMarker(await exchange(tokenB, v2()), "released slot (exchange)");
  // A phone revoked by the vendor (the phone enrolled again after its upload window, above).
  const tokenP3c = afterWindow.json.activation_token;
  assert.equal((await machineAction(a.tenant.id, "fp-phone-3", "revoke")).status, 200);
  noMarker(await refresh(tokenP3c), "vendor revocation");
  // No activation row at all (a database restored from before the phone was enrolled, a deleted row).
  assert.equal((await machineAction(a.tenant.id, "fp-phone-3", "reinstate")).status, 200);
  assert.equal((await refresh(tokenP3c)).status, 200, "reinstated");
  await api.su("DELETE FROM machine_activations WHERE machine_fingerprint = 'fp-phone-3'");
  noMarker(await refresh(tokenP3c), "missing activation row");
  noMarker(await exchange(tokenP3c, v2()), "missing activation row (exchange)");

  // ── Audit ledger ────────────────────────────────────────────────────────────────────────────
  const audits = await api.su(
    `SELECT action_code, count(*)::int AS n FROM audit_records
     WHERE action_code LIKE 'mobile_%' GROUP BY action_code ORDER BY action_code`,
  );
  const counts = Object.fromEntries(audits.map((r) => [r.action_code, r.n]));
  assert.equal(counts.mobile_enrolment_issued, 10, JSON.stringify(counts));
  assert.equal(counts.mobile_enrolment_redeemed, 6, JSON.stringify(counts));
  assert.equal(counts.mobile_enrolment_redeem_replayed, 2, JSON.stringify(counts));
  assert.equal(counts.mobile_enrolment_cancelled, 2, JSON.stringify(counts));
  assert.equal(counts.mobile_device_revoked, 4, JSON.stringify(counts));
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

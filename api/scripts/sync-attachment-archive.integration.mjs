/**
 * Undoable attachment deletes / overwrites and the forensic device log (CMMS Advisor decision
 * 2026-10-20, migration 017) against a real Postgres and the real API, through the real exchange:
 *
 * - every replacement of a live attachment row is archived with the device that sent it: device
 *   deletes, device overwrites (a caption edit too, hidden from the default listing) and operator
 *   restores that replace a live row; a delete of nothing / of a delete marker is recorded as
 *   unknown / already_deleted and cannot be restored;
 * - restore (sync.operate, reason, `sync_attachment_restore` step-up, the entity's current version
 *   and hash from the listing) brings back that entry's prior payload byte for byte to every device,
 *   above every version seen, any time and as often as asked; a stale listing gets 409
 *   entity_changed_since_listing with the current state. The reviewer's probes m1 / m2 / m3 (delete
 *   twice, junk twice, junk then delete) and an ABA rewrite by v1 all end with the good version back;
 * - companion pairing (photo, request and work order attachments), v1 lower versions, document
 *   links, refusal of deletes of append-only history;
 * - every accepted change of site_settings / site_setting_events / permit_types is kept with its
 *   sending device in sync_forensic_change_log, which retention never compacts.
 *
 * Optional: TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY, TEST_S3_REGION (an S3-compatible server) add
 * the byte-identical file check (upload → delete → restore → download the same bytes).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

// ── The server never deletes stored objects (static check of the API sources) ───────────────
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const deleting = sources(join(here, "..", "src")).filter((f) => /DeleteObjects?Command|deleteObject|RemoveObject/.test(readFileSync(f, "utf8")));
// backup-offsite prunes its own backup bucket, never the tenant media bucket.
assert.deepEqual(
  deleting.map((f) => f.replace(/\\/g, "/").replace(/.*\/src\//, "src/")).filter((f) => f !== "src/tools/backup-offsite.ts"),
  [],
  "no API code deletes tenant media objects",
);

const s3 = {
  endpoint: process.env.TEST_S3_ENDPOINT?.trim(),
  accessKey: process.env.TEST_S3_ACCESS_KEY?.trim(),
  secretKey: process.env.TEST_S3_SECRET_KEY?.trim(),
  region: process.env.TEST_S3_REGION?.trim(),
  bucket: `mfx-archive-test-${randomBytes(4).toString("hex")}`,
};
const withObjectStore = Boolean(s3.endpoint && s3.accessKey && s3.secretKey && s3.region);
// CI's object-storage job sets REQUIRE_S3=1: there the byte-identical check must run, never skip.
if (process.env.REQUIRE_S3 === "1" && !withObjectStore) {
  console.error("REQUIRE_S3=1 but TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY / TEST_S3_REGION are not all set.");
  process.exit(1);
}
// The API never creates its bucket (the object store's own setup does, deploy/OBJECT_STORAGE.md).
if (withObjectStore) {
  await new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
  }).send(new CreateBucketCommand({ Bucket: s3.bucket }));
}
const api = await startControlApi({
  port: 33251,
  extraEnv: withObjectStore
    ? {
        S3_ENDPOINT: s3.endpoint,
        S3_ACCESS_KEY: s3.accessKey,
        S3_SECRET_KEY: s3.secretKey,
        S3_REGION: s3.region,
        S3_BUCKET: s3.bucket,
        S3_FORCE_PATH_STYLE: "true",
        DEPLOYMENT_ENV: "test",
      }
    : {},
});

const registryTypes = new Set(
  JSON.parse(readFileSync(join(here, "..", "..", "shared", "sync-entity-registry.v2.json"), "utf8")).entity_types.map((e) => e.entity_type),
);

function item(entityType, entitySyncId, rowVersion, baseRowVersion, payloadJson, operation) {
  return {
    idempotency_key: randomUUID(),
    entity_type: entityType,
    entity_sync_id: entitySyncId,
    operation: operation ?? (baseRowVersion === null ? "create" : "update"),
    row_version: rowVersion,
    base_row_version: baseRowVersion,
    payload_json: payloadJson,
    payload_hash: sha256Hex(payloadJson),
  };
}

try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const token = owner.accessToken;
  const tenant = (await api.call("POST", "/api/v1/tenants", token, { slug: "archive", display_name: "Archive" })).json;
  const licence = (await api.call("POST", "/api/v1/licenses", token, { tenant_id: tenant.id, max_machines: 3 })).json;

  const device = async (fp) => {
    const claimed = await api.call("POST", "/api/v1/activation/claim", null, {
      license_key: licence.license_key,
      machine_fingerprint: fp,
      app_version: "1.0.0",
    });
    assert.equal(claimed.status, 200, claimed.text);
    return { fp, token: claimed.json.activation_token, checkpoint: null };
  };
  const exchange = async (dev, outbox = [], extra = {}) => {
    const r = await api.call("POST", "/api/v1/sync/exchange", dev.token, {
      protocol_version: "v2",
      idempotency_key: `ex-${randomUUID()}`,
      checkpoint_token: dev.checkpoint,
      current_user_sync_ids: [],
      device_class: "desktop",
      outbox_batch: outbox,
      ...extra,
    });
    assert.equal(r.status, 200, r.text);
    dev.checkpoint = r.json.checkpoint_token;
    return r.json;
  };
  const exchangeV1 = async (dev, outbox) => {
    const r = await api.call("POST", "/api/v1/sync/exchange", dev.token, {
      protocol_version: "v1",
      idempotency_key: `v1-${randomUUID()}`,
      device_class: "desktop",
      outbox_batch: outbox.map((i) => {
        const v1Item = { ...i };
        delete v1Item.base_row_version;
        return v1Item;
      }),
    });
    assert.equal(r.status, 200, r.text);
    return r.json;
  };
  /** Every inbound item until the device is up to date. */
  const pullAll = async (dev) => {
    const items = [];
    for (let i = 0; i < 50; i += 1) {
      const r = await exchange(dev);
      items.push(...r.inbound_items);
      if (!r.has_more) return items;
    }
    throw new Error("delta did not converge");
  };

  const A = await device("fp-archive-device-a");
  const B = await device("fp-archive-device-b");
  await pullAll(A);
  await pullAll(B);

  // ── A uploads a photo: media_attachments row + manifest (+ the file when S3 is available) ──
  const fileBytes = Buffer.from(`photo of pump P-101 ${randomUUID()}`);
  const contentSha = createHash("sha256").update(fileBytes).digest("hex");
  let objectKey = `test/media/${tenant.id}/equipment/eq-101/${contentSha}`;
  if (withObjectStore) {
    const put = await api.call("POST", "/api/v1/sync/media/presign-put", A.token, {
      parent_entity_type: "equipment",
      parent_entity_sync_id: "eq-101",
      content_sha256: contentSha,
    });
    assert.equal(put.status, 200, put.text);
    objectKey = put.json.object_key;
    const up = await fetch(put.json.url, { method: "PUT", body: fileBytes });
    assert.ok(up.ok, `upload ${up.status}`);
  }
  const mediaId = "media-archive-1";
  const mediaPayload = JSON.stringify({
    entity_sync_id: mediaId,
    parent_entity_type: "equipment",
    parent_entity_sync_id: "eq-101",
    content_sha256: contentSha,
    mime_type: "image/jpeg",
    byte_size: fileBytes.length,
    object_key: objectKey,
    file_name: "pump.jpg",
    caption: "Seal leak, before repair",
  });
  const created = await exchange(A, [item("media_attachments", mediaId, 1, null, mediaPayload, "upsert")], {
    media_manifest: [{ entity_sync_id: mediaId, content_sha256: contentSha, object_key: objectKey, byte_size: fileBytes.length }],
  });
  assert.equal(created.acknowledged_items.length, 1);
  const bSees = (await pullAll(B)).find((i) => i.entity_sync_id === mediaId);
  assert.equal(bSees.payload_json, mediaPayload);

  // ── B deletes it by sync: accepted exactly as before, and archived ─────────────────────────
  const deleted = await exchange(B, [item("media_attachments", mediaId, 2, 1, JSON.stringify({ entity_sync_id: mediaId }), "delete")]);
  assert.equal(deleted.acknowledged_items.length, 1, "the delete is accepted");
  assert.deepEqual(deleted.rejected_items, []);
  assert.deepEqual(deleted.conflict_items, []);
  const aSeesDelete = (await pullAll(A)).find((i) => i.entity_sync_id === mediaId);
  assert.equal(aSeesDelete.operation, "delete");
  assert.equal(aSeesDelete.deleted, true);

  const deletePayload = JSON.stringify({ entity_sync_id: mediaId });
  const [archived] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE tenant_id = $1 AND entity_sync_id = $2", [tenant.id, mediaId]);
  assert.ok(archived, "the delete is archived");
  assert.equal(archived.entity_type, "media_attachments");
  assert.equal(archived.change_kind, "delete");
  assert.equal(archived.locator_changed, true);
  assert.equal(archived.prior_state, "present");
  assert.equal(archived.prior_payload_raw, mediaPayload, "the prior payload, byte for byte");
  assert.equal(archived.prior_payload_hash, sha256Hex(mediaPayload));
  assert.equal(Number(archived.prior_row_version), 1);
  assert.equal(archived.prior_origin_machine_fingerprint, A.fp);
  assert.equal(archived.changed_by_machine_fingerprint, B.fp, "the deleting device");
  assert.equal(archived.changed_by_license_id, licence.id);
  assert.equal(archived.changed_by_operator, null);
  assert.equal(Number(archived.change_row_version), 2);
  assert.equal(archived.object_refs.payload.object_key, objectKey);
  assert.equal(archived.object_refs.payload.content_sha256, contentSha);
  assert.equal(archived.object_refs.media_manifest.object_key, objectKey);

  // ── Listing (sync.operate), no payload, with the entity's current state ──────────────────────
  const listUrl = `/api/v1/tenants/${tenant.id}/sync/deleted-attachments`;
  const list = async (query = "") => {
    const r = await api.call("GET", `${listUrl}${query}`, token);
    assert.equal(r.status, 200, r.text);
    return r.json.items;
  };
  const listAll = () => list("?view=all&limit=200");
  const listed = await api.call("GET", listUrl, token);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.items.length, 1);
  const entry = listed.json.items[0];
  assert.equal(entry.entity_sync_id, mediaId);
  assert.equal(entry.changed_by.machine_fingerprint, B.fp);
  assert.equal(entry.change_kind, "delete");
  assert.equal(entry.locator_changed, true);
  assert.equal(entry.restorable, true);
  assert.deepEqual(entry.restores, []);
  assert.deepEqual(entry.current, { row_version: 2, payload_hash: sha256Hex(deletePayload), deleted: true });
  assert.equal(entry.file_on_server, true, "the manifest says the server has the file");
  assert.equal(entry.content_sha256, contentSha);
  assert.ok(!listed.text.includes("Seal leak"), "no payload in the listing");
  assert.equal((await api.call("GET", `${listUrl}?view=bogus`, token)).status, 400);
  assert.equal((await api.call("GET", `${listUrl}?limit=201`, token)).status, 400, "page size at most 200");
  assert.equal((await api.call("GET", `${listUrl}?cursor=not-a-cursor`, token)).status, 400);
  assert.equal((await api.call("GET", `${listUrl}?status=all`, token)).status, 400, "unknown query keys are refused");
  assert.equal((await list(`?since=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).length, 0, "time filter");
  assert.equal((await list(`?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`)).length, 1);
  assert.equal((await api.call("GET", `/api/v1/tenants/no-such-tenant/sync/deleted-attachments`, token)).status, 404);

  // ── Restore guards: permission, reason, step-up kind, body, stale listing ──────────────────────
  const restoreUrl = (id) => `/api/v1/tenants/${tenant.id}/sync/deleted-attachments/${id}/restore`;
  const reasonOnly = { "X-Operator-Reason": "deleted by mistake on the tablet" };
  const expect = (current) => ({
    expected_current_row_version: current?.row_version ?? null,
    expected_current_payload_hash: current?.payload_hash ?? null,
    expected_current_deleted: current?.deleted ?? null,
  });
  const noReason = await api.call("POST", restoreUrl(entry.id), token, expect(entry.current), {
    "X-Step-Up-Token": await owner.stepUp("sync_attachment_restore"),
  });
  assert.equal(noReason.status, 403);
  assert.equal(noReason.json.reason, "missing_reason_code");
  const noStepUp = await api.call("POST", restoreUrl(entry.id), token, expect(entry.current), reasonOnly);
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.reason, "missing_step_up_token");
  const wrongKind = await api.call("POST", restoreUrl(entry.id), token, expect(entry.current), {
    ...reasonOnly,
    "X-Step-Up-Token": await owner.stepUp("sync_repair"),
  });
  assert.equal(wrongKind.json.reason, "step_up_action_kind_mismatch");
  const privileged = { ...reasonOnly, "X-Step-Up-Token": await owner.stepUp("sync_attachment_restore") };
  assert.equal((await api.call("POST", restoreUrl(entry.id), token, {}, privileged)).status, 400, "the expected current state is required");
  const stale = await api.call("POST", restoreUrl(entry.id), token, { ...expect(entry.current), expected_current_row_version: 1 }, privileged);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, "entity_changed_since_listing");
  assert.deepEqual(stale.json.current, entry.current, "the refusal shows the state to confirm");

  // An auditor (no sync.operate) can neither list nor restore.
  const hire = await api.call(
    "POST",
    "/api/v1/operators",
    token,
    { email: "auditor@maintafox.systems", display_name: "Auditor", role: "auditor", initial_password: "Initial-auditor-pass-1" },
    { "X-Operator-Reason": "archive test", "X-Step-Up-Token": await owner.stepUp("vendor_user_admin") },
  );
  assert.equal(hire.status, 201, hire.text);
  const auditor = await loginOperator(api.baseUrl, "auditor@maintafox.systems", "Initial-auditor-pass-1", {
    enrolmentCode: hire.json.enrolment_code,
  });
  assert.equal((await api.call("GET", listUrl, auditor.accessToken)).status, 403);
  const auditorRestore = await api.call("POST", restoreUrl(entry.id), auditor.accessToken, expect(entry.current), reasonOnly);
  assert.equal(auditorRestore.status, 403);
  assert.equal(auditorRestore.json.error, "permission_denied");

  const stillDeleted = await api.su("SELECT deleted FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id = $2", [tenant.id, mediaId]);
  assert.equal(stillDeleted[0].deleted, true, "refused restores changed nothing");
  assert.equal((await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = 'sync_attachment_restored'"))[0].n, 0);

  /** Restores an entry against the current state the listing shows now. */
  const restoreNow = async (archiveId) => {
    const it = (await listAll()).find((i) => i.id === String(archiveId));
    assert.ok(it, `archive entry ${archiveId} listed`);
    const r = await api.call("POST", restoreUrl(archiveId), token, expect(it.current), privileged);
    assert.equal(r.status, 200, r.text);
    return r.json;
  };

  // ── Restore ───────────────────────────────────────────────────────────────────────────────
  const restored = await api.call("POST", restoreUrl(entry.id), token, expect(entry.current), privileged);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.row_version, 3, "above every version seen");
  assert.equal(restored.json.replaced_archive_id, null, "a delete marker is not archived again");
  assert.equal((await api.call("POST", restoreUrl("999999"), token, expect(null), privileged)).status, 404);
  assert.equal((await api.call("POST", restoreUrl("not-a-number"), token, expect(null), privileged)).status, 404);

  // Both devices — the one that deleted it included — receive the row again, identical.
  for (const dev of [A, B]) {
    const back = (await pullAll(dev)).find((i) => i.entity_sync_id === mediaId);
    assert.ok(back, `${dev.fp} receives the restored row`);
    assert.equal(back.deleted, false);
    assert.equal(back.operation, "upsert");
    assert.equal(back.row_version, 3);
    assert.equal(back.payload_json, mediaPayload, "identical payload");
    assert.equal(back.payload_hash, sha256Hex(mediaPayload));
    const p = JSON.parse(back.payload_json);
    assert.equal(p.object_key, objectKey, "same object key");
    assert.equal(p.content_sha256, contentSha, "same checksum");
  }
  // A new device bootstrapping from a snapshot gets it too.
  const C = await device("fp-archive-device-c");
  const snap = await api.call("POST", "/api/v1/sync/snapshot", C.token, {
    protocol_version: "v2",
    page_size: 1000,
    scope: "all",
    current_user_sync_ids: [],
  });
  assert.equal(snap.status, 200, snap.text);
  assert.equal(snap.json.items.find((i) => i.entity_sync_id === mediaId)?.payload_json, mediaPayload);
  C.checkpoint = snap.json.checkpoint_token;
  await pullAll(C);
  // The manifest row (object key, checksum, size) is untouched.
  const [manifest] = await api.su("SELECT object_key, content_sha256, byte_size FROM sync_media_manifest WHERE tenant_id = $1 AND entity_sync_id = $2", [tenant.id, mediaId]);
  assert.deepEqual({ ...manifest, byte_size: Number(manifest.byte_size) }, { object_key: objectKey, content_sha256: contentSha, byte_size: fileBytes.length });
  if (withObjectStore) {
    const get = await api.call("POST", "/api/v1/sync/media/presign-get", B.token, { object_key: objectKey });
    assert.equal(get.status, 200, get.text);
    const down = Buffer.from(await (await fetch(get.json.url)).arrayBuffer());
    assert.ok(down.equals(fileBytes), "the restored attachment's file is byte-identical");
  }

  const [logRow] = await api.su("SELECT * FROM sync_attachment_restore_log WHERE archive_id = $1", [archived.id]);
  assert.equal(logRow.reason, "deleted by mistake on the tablet");
  assert.equal(Number(logRow.restore_row_version), 3);
  const [ledger] = await api.su("SELECT * FROM audit_records WHERE action_code = 'sync_attachment_restored'");
  assert.ok(ledger, "audited");
  assert.equal(ledger.record_id, logRow.audit_record_id);
  assert.equal(ledger.scope_tenant_id, tenant.id);
  assert.ok(!JSON.stringify(ledger).includes("Seal leak"), "no payload in the ledger");
  const [ingress] = await api.su("SELECT machine_fingerprint, row_version, base_row_version FROM sync_mirror_ingress WHERE id = $1", [logRow.restore_ingress_id]);
  assert.equal(ingress.machine_fingerprint, "server:attachment-restore");
  assert.equal(Number(ingress.base_row_version), 2);
  // Archive entries and restore records are evidence: never updated, even by the database owner.
  await assert.rejects(api.su("UPDATE sync_deleted_attachment_archive SET prior_payload_raw = 'x' WHERE id = $1", [archived.id]), /append-only/);
  await assert.rejects(api.su("UPDATE sync_attachment_restore_log SET reason = 'x' WHERE id = $1", [logRow.id]), /append-only/);
  const afterFirst = (await list()).find((i) => i.id === entry.id);
  assert.equal(afterFirst.restores.length, 1);
  assert.equal(afterFirst.restores[0].reason, "deleted by mistake on the tablet");
  assert.equal(afterFirst.restorable, true, "an entry stays restorable");

  // The same entry can be restored again (same payload now: nothing replaced, a new version).
  const again = await restoreNow(entry.id);
  assert.equal(again.row_version, 4);
  assert.equal(again.replaced_archive_id, null);
  assert.equal((await list()).find((i) => i.id === entry.id).restores.length, 2);

  // ── Caption edit: archived (never destroyed) but hidden from the default listing ─────────────
  const captioned = mediaPayload.replace("before repair", "after repair");
  assert.equal((await exchange(A, [item("media_attachments", mediaId, 5, 4, captioned, "upsert")])).acknowledged_items.length, 1);
  const [caption] = await api.su(
    "SELECT * FROM sync_deleted_attachment_archive WHERE tenant_id = $1 AND entity_sync_id = $2 AND change_kind = 'overwrite'",
    [tenant.id, mediaId],
  );
  assert.equal(caption.locator_changed, false, "a caption edit does not move the file");
  const captionListed = (await list()).find((i) => i.id === String(caption.id));
  assert.ok(captionListed, "every replacement of a live row is listed by default, whatever field changed");
  assert.equal(captionListed.locator_changed, false, "locator_changed is informative only");

  // ── Probe m1: delete, then delete again. The good version stays restorable ──────────────────
  const good = (id) => JSON.stringify({ entity_sync_id: id, object_key: `test/media/${tenant.id}/equipment/eq-9/${"a".repeat(64)}`, content_sha256: "a".repeat(64) });
  const junkOf = (id) => JSON.stringify({ entity_sync_id: id, object_key: `test/media/${tenant.id}/x/y/${"0".repeat(64)}`, content_sha256: "0".repeat(64) });
  const entriesOf = async (id) =>
    api.su("SELECT id, change_kind, prior_state, change_row_version FROM sync_deleted_attachment_archive WHERE tenant_id = $1 AND entity_sync_id = $2 ORDER BY id", [tenant.id, id]);
  await exchange(A, [item("media_attachments", "m1", 1, null, good("m1"), "upsert")]);
  await exchange(B, [item("media_attachments", "m1", 2, 1, JSON.stringify({ entity_sync_id: "m1" }), "delete")]);
  await exchange(B, [item("media_attachments", "m1", 3, 2, JSON.stringify({ entity_sync_id: "m1", x: 1 }), "delete")]);
  const m1 = await entriesOf("m1");
  assert.deepEqual(m1.map((e) => e.prior_state), ["present", "already_deleted"]);
  assert.ok(!(await list()).some((i) => i.id === String(m1[1].id)), "an entry that kept nothing is not in the default view");
  const m1Second = (await listAll()).find((i) => i.id === String(m1[1].id));
  const nothing = await api.call("POST", restoreUrl(m1[1].id), token, expect(m1Second.current), privileged);
  assert.equal(nothing.json.error, "nothing_to_restore");
  assert.equal((await restoreNow(m1[0].id)).row_version, 4);
  assert.equal((await pullAll(A)).find((i) => i.entity_sync_id === "m1")?.payload_json, good("m1"), "the good version is back");

  // ── Probe m2: junk overwrite, then the same junk again. The good version stays restorable ─────
  await exchange(A, [item("media_attachments", "m2", 1, null, good("m2"), "upsert")]);
  await exchange(B, [item("media_attachments", "m2", 2, 1, junkOf("m2"), "upsert")]);
  await exchange(B, [item("media_attachments", "m2", 3, 2, junkOf("m2"), "upsert")]);
  const m2 = await entriesOf("m2");
  assert.deepEqual(m2.map((e) => e.change_kind), ["overwrite"], "the identical re-send replaced nothing new");
  const m2Entry = (await list()).find((i) => i.id === String(m2[0].id));
  assert.equal(m2Entry.locator_changed, true, "a junk object key moves the file: listed by default");
  const m2Restore = await restoreNow(m2[0].id);
  assert.equal(m2Restore.row_version, 4);
  assert.notEqual(m2Restore.replaced_archive_id, null, "the junk the restore replaced is archived too");
  const [m2Replaced] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE id = $1", [m2Restore.replaced_archive_id]);
  assert.equal(m2Replaced.change_kind, "restore");
  assert.equal(m2Replaced.prior_payload_raw, junkOf("m2"));
  assert.equal(m2Replaced.changed_by_machine_fingerprint, "server:attachment-restore");
  assert.match(m2Replaced.changed_by_operator, /^user_/);
  assert.equal(m2Replaced.changed_by_license_id, null);
  assert.equal((await pullAll(B)).find((i) => i.entity_sync_id === "m2")?.payload_json, good("m2"));

  // ── Probe m3: junk overwrite, then delete. Either archived version can be restored ──────────
  await exchange(A, [item("media_attachments", "m3", 1, null, good("m3"), "upsert")]);
  await exchange(B, [item("media_attachments", "m3", 2, 1, junkOf("m3"), "upsert")]);
  await exchange(B, [item("media_attachments", "m3", 3, 2, JSON.stringify({ entity_sync_id: "m3" }), "delete")]);
  const m3 = await entriesOf("m3");
  assert.deepEqual(m3.map((e) => [e.change_kind, e.prior_state]), [["overwrite", "present"], ["delete", "present"]]);
  const m3Restore = await restoreNow(m3[0].id);
  assert.equal(m3Restore.row_version, 4);
  assert.equal(m3Restore.replaced_archive_id, null, "it replaced a delete marker");
  assert.equal((await pullAll(A)).find((i) => i.entity_sync_id === "m3")?.payload_json, good("m3"));

  // Concurrency: a device change after the listing → 409 with the new state; listing again works.
  const m3Listed = (await list()).find((i) => i.id === String(m3[1].id));
  await exchange(A, [item("media_attachments", "m3", 5, 4, junkOf("m3"), "upsert")]);
  const raced = await api.call("POST", restoreUrl(m3[1].id), token, expect(m3Listed.current), privileged);
  assert.equal(raced.status, 409);
  assert.equal(raced.json.error, "entity_changed_since_listing");
  assert.equal(raced.json.current.row_version, 5);
  assert.equal((await restoreNow(m3[0].id)).row_version, 6, "after listing again");

  // ── Equipment photo deleted with a LIVE prior row, paired with its "Photo or file" entry ────
  const photoPath = "asset_photos/101/4b1d.jpg";
  const photoBytes = Buffer.from("equipment photo bytes");
  const photoSha = createHash("sha256").update(photoBytes).digest("hex");
  const photoKey = `test/media/${tenant.id}/equipment/eq-101/${photoSha}`;
  const companionPayload = JSON.stringify({ entity_sync_id: "media-photo-1", relative_path: photoPath, content_sha256: photoSha, object_key: photoKey });
  const photoPayload = JSON.stringify({ entity_sync_id: "photo-1", file_name: "pump.jpg", relative_path: photoPath, caption: "Nameplate" });
  await exchange(
    A,
    [item("media_attachments", "media-photo-1", 1, null, companionPayload, "upsert"), item("asset_photos", "photo-1", 1, null, photoPayload, "upsert")],
    { media_manifest: [{ entity_sync_id: "media-photo-1", content_sha256: photoSha, object_key: photoKey, byte_size: photoBytes.length }] },
  );
  const photoDel = await exchange(B, [item("asset_photos", "photo-1", 2, 1, JSON.stringify({ entity_sync_id: "photo-1" }), "delete")]);
  assert.equal(photoDel.acknowledged_items.length, 1);
  const photoEntry = (await list()).find((i) => i.entity_sync_id === "photo-1");
  assert.equal(photoEntry.prior_state, "present");
  assert.deepEqual(photoEntry.companion, { entity_sync_id: "media-photo-1", archive_id: null, live: true, file_on_server: true });
  assert.equal(photoEntry.file_on_server, true);
  // The companion deleted too: the listing points at its archive entry.
  await exchange(B, [item("media_attachments", "media-photo-1", 2, 1, JSON.stringify({ entity_sync_id: "media-photo-1" }), "delete")]);
  const paired = await list();
  const companionEntry = paired.find((i) => i.entity_sync_id === "media-photo-1");
  assert.deepEqual(paired.find((i) => i.entity_sync_id === "photo-1").companion, {
    entity_sync_id: "media-photo-1",
    archive_id: companionEntry.id,
    live: false,
    file_on_server: true,
  });
  await restoreNow(photoEntry.id);
  await restoreNow(companionEntry.id);
  const photoBack = await pullAll(A);
  assert.equal(photoBack.find((i) => i.entity_sync_id === "photo-1")?.payload_json, photoPayload);
  assert.equal(photoBack.find((i) => i.entity_sync_id === "media-photo-1")?.payload_json, companionPayload);

  // Request and work order attachments pair with their companion the same way.
  for (const [type, path] of [
    ["di_attachments", "di_attachments/7/leak.jpg"],
    ["work_order_attachments", "work_order_attachments/12/report.pdf"],
  ]) {
    const mediaPair = `media-${type}`;
    await exchange(A, [
      item("media_attachments", mediaPair, 1, null, JSON.stringify({ entity_sync_id: mediaPair, relative_path: path }), "upsert"),
      item(type, `${type}-pair`, 1, null, JSON.stringify({ entity_sync_id: `${type}-pair`, relative_path: path }), "upsert"),
    ]);
    await exchange(B, [item(type, `${type}-pair`, 2, 1, JSON.stringify({ entity_sync_id: `${type}-pair` }), "delete")]);
    const e = (await list()).find((i) => i.entity_sync_id === `${type}-pair`);
    assert.deepEqual(e.companion, { entity_sync_id: mediaPair, archive_id: null, live: true, file_on_server: false }, type);
    assert.equal(e.file_on_server, false, `${type}: no manifest, no server copy`);
  }

  // ── v1 delete with a LOWER version than the row it removes: archived; restore goes above both ──
  const diPayload = JSON.stringify({ entity_sync_id: "di-att-1", file_name: "leak.pdf", relative_path: "di_attachments/7/leak.pdf" });
  await exchangeV1(A, [item("di_attachments", "di-att-1", 7, null, diPayload, "upsert")]);
  await exchangeV1(B, [item("di_attachments", "di-att-1", 1, null, JSON.stringify({ entity_sync_id: "di-att-1" }), "delete")]);
  const [v1Del] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'di-att-1'");
  assert.equal(v1Del.protocol_version, "v1", "a v1 delete is archived");
  assert.equal(v1Del.change_kind, "delete");
  assert.equal(Number(v1Del.prior_row_version), 7);
  assert.equal(Number(v1Del.change_row_version), 1);
  assert.equal(v1Del.changed_by_machine_fingerprint, B.fp);
  assert.equal((await restoreNow(v1Del.id)).row_version, 8, "max(current 1, prior 7) + 1");
  const diBack = (await pullAll(A)).find((i) => i.entity_sync_id === "di-att-1");
  assert.equal(diBack.row_version, 8);
  assert.equal(diBack.payload_json, diPayload);

  // ── ABA: v1 writes (version, payload) back to an earlier state; nothing is lost ──────────────
  const P1 = JSON.stringify({ entity_sync_id: "aba", relative_path: "work_order_attachments/1/a.pdf" });
  const P2 = JSON.stringify({ entity_sync_id: "aba", relative_path: "work_order_attachments/1/b.pdf" });
  await exchangeV1(A, [item("work_order_attachments", "aba", 1, null, P1, "upsert")]);
  await exchangeV1(B, [item("work_order_attachments", "aba", 2, null, P2, "upsert")]);
  await exchangeV1(A, [item("work_order_attachments", "aba", 1, null, P1, "upsert")]);
  const aba = await api.su(
    "SELECT id, prior_payload_raw, prior_row_version FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'aba' ORDER BY id",
  );
  assert.deepEqual(aba.map((e) => [e.prior_payload_raw, Number(e.prior_row_version)]), [[P1, 1], [P2, 2]], "both versions archived");
  const abaP2 = await restoreNow(aba[1].id);
  assert.equal(abaP2.row_version, 3, "above every version seen (2), not just current (1)");
  assert.notEqual(abaP2.replaced_archive_id, null, "P1 (live) archived again by the restore");
  const abaP1 = await restoreNow(aba[0].id);
  assert.equal(abaP1.row_version, 4);
  assert.equal((await pullAll(B)).find((i) => i.entity_sync_id === "aba")?.payload_json, P1);

  // ── A document link is archived too ───────────────────────────────────────────────────────
  await exchange(A, [item("asset_document_links", "doclink-1", 1, null, JSON.stringify({ entity_sync_id: "doclink-1", document_ref: "DOC-1" }), "upsert")]);
  await exchange(B, [item("asset_document_links", "doclink-1", 2, 1, JSON.stringify({ entity_sync_id: "doclink-1", document_ref: "DOC-9" }), "upsert")]);
  const [docRow] = await api.su("SELECT prior_state, change_kind, locator_changed FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'doclink-1'");
  assert.deepEqual(docRow, { prior_state: "present", change_kind: "overwrite", locator_changed: true }, "document_ref is the locator");

  // ── Deletes of append-only history are refused (v2 and v1); upserts are not ──────────────────
  const evidence = JSON.stringify({ entity_sync_id: "ev-1", note: "gauge reading photo" });
  assert.equal((await exchange(A, [item("inspection_evidence", "ev-1", 1, null, evidence, "upsert")])).acknowledged_items.length, 1);
  for (const op of ["delete", "archive"]) {
    const refusedV2 = await exchange(B, [item("inspection_evidence", "ev-1", 2, 1, JSON.stringify({ entity_sync_id: "ev-1" }), op)]);
    assert.deepEqual(refusedV2.acknowledged_items, []);
    assert.equal(refusedV2.rejected_items[0].rejection_code, "operation_not_allowed_for_type", `v2 ${op}`);
    assert.equal(refusedV2.rejected_items[0].entity_type, "inspection_evidence");
  }
  const refusedV1 = await exchangeV1(B, [item("inspection_evidence", "ev-1", 2, 1, JSON.stringify({ entity_sync_id: "ev-1" }), "delete")]);
  assert.deepEqual(refusedV1.acknowledged_items, []);
  assert.equal(refusedV1.rejected_items[0].rejection_code, "operation_not_allowed_for_type", "v1 delete");
  const [evState] = await api.su("SELECT deleted, row_version FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id = 'ev-1'", [tenant.id]);
  assert.deepEqual({ deleted: evState.deleted, row_version: Number(evState.row_version) }, { deleted: false, row_version: 1 }, "no tombstone written");
  const evLog = await api.su("SELECT count(*)::int AS n FROM sync_mirror_ingress WHERE entity_sync_id = 'ev-1'");
  assert.equal(evLog[0].n, 1, "refused deletes are not logged");

  // ── Byte size per type (asset_photos file_size_bytes, others size_bytes) ─────────────────────
  await exchange(A, [item("asset_photos", "size-1", 1, null, JSON.stringify({ relative_path: "asset_photos/1/s.jpg", file_size_bytes: 4321 }), "upsert")]);
  await exchange(B, [item("asset_photos", "size-1", 2, 1, JSON.stringify({ entity_sync_id: "size-1" }), "delete")]);
  await exchange(A, [item("library_documents", "size-2", 1, null, JSON.stringify({ relative_path: "library/m.pdf", size_bytes: 9876 }), "upsert")]);
  await exchange(B, [item("library_documents", "size-2", 2, 1, JSON.stringify({ entity_sync_id: "size-2" }), "delete")]);
  const sized = await list();
  assert.equal(sized.find((i) => i.entity_sync_id === "size-1").byte_size, 4321);
  assert.equal(sized.find((i) => i.entity_sync_id === "size-2").byte_size, 9876);

  // ── Probe C: identical v2 re-sends raise the version to 10, then v1 writes it back down ───────
  const cPayload = (tag) => JSON.stringify({ entity_sync_id: "c", object_key: `test/media/${tenant.id}/c/${tag}` });
  await exchange(A, [item("media_attachments", "c", 1, null, cPayload("g0"), "upsert")]);
  await exchange(A, [item("media_attachments", "c", 2, 1, cPayload("g1"), "upsert")]);
  for (let v = 3; v <= 10; v += 1) await exchange(A, [item("media_attachments", "c", v, v - 1, cPayload("g1"), "upsert")]);
  assert.equal((await pullAll(B)).find((i) => i.entity_sync_id === "c")?.row_version, 10, "a device holds v10");
  await exchangeV1(A, [item("media_attachments", "c", 1, null, cPayload("g1"), "upsert")]);
  await exchangeV1(A, [item("media_attachments", "c", 2, null, cPayload("junk"), "upsert")]);
  // Compacting the log must not lose the high-water mark: drop this entity's log rows outright.
  await api.su("DELETE FROM sync_mirror_ingress WHERE tenant_id = $1 AND entity_sync_id = 'c'", [tenant.id]);
  const cG0 = (await api.su(
    "SELECT id FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'c' AND prior_row_version = 1 AND change_row_version = 2 ORDER BY id LIMIT 1",
  ))[0];
  const cRestore = await restoreNow(cG0.id);
  assert.ok(cRestore.row_version >= 11, `restore written above what devices hold (got ${cRestore.row_version})`);
  const cBack = (await pullAll(B)).find((i) => i.entity_sync_id === "c");
  assert.equal(cBack.row_version, cRestore.row_version);
  assert.equal(cBack.payload_json, cPayload("g0"));

  // ── N-1: a v1 delete with the same version and payload flips only `deleted`: stale listing ─────
  const eGood = JSON.stringify({ entity_sync_id: "e", object_key: `test/media/${tenant.id}/e/good` });
  const eJunk = JSON.stringify({ entity_sync_id: "e", object_key: `test/media/${tenant.id}/e/junk` });
  await exchange(A, [item("media_attachments", "e", 1, null, eGood, "upsert")]);
  await exchange(A, [item("media_attachments", "e", 2, 1, eJunk, "upsert")]);
  const eEntry = (await list("?entity_type=media_attachments&entity_sync_id=e"))[0];
  assert.deepEqual(eEntry.current, { row_version: 2, payload_hash: sha256Hex(eJunk), deleted: false });
  await exchangeV1(B, [item("media_attachments", "e", 2, null, eJunk, "delete")]);
  const eStale = await api.call("POST", restoreUrl(eEntry.id), token, expect(eEntry.current), privileged);
  assert.equal(eStale.status, 409, "same version and hash, but now deleted");
  assert.equal(eStale.json.error, "entity_changed_since_listing");
  assert.equal(eStale.json.current.deleted, true);

  // ── B-2 probe F: a flood of deletes of unknown ids never hides a real entry ──────────────────
  await exchange(A, [item("media_attachments", "f", 1, null, JSON.stringify({ entity_sync_id: "f", object_key: "k-f" }), "upsert")]);
  await exchange(B, [item("media_attachments", "f", 2, 1, JSON.stringify({ entity_sync_id: "f" }), "delete")]);
  const beforeFlood = new Date().toISOString();
  for (let b = 0; b < 6; b += 1) {
    const batch = [];
    for (let i = 0; i < 100; i += 1) {
      batch.push(item("media_attachments", `ghost-${b}-${i}`, 1, null, JSON.stringify({ entity_sync_id: `ghost-${b}-${i}` }), "delete"));
    }
    assert.equal((await exchange(B, batch)).acknowledged_items.length, 100);
  }
  const defaultPage = await api.call("GET", listUrl, token);
  assert.ok(defaultPage.json.items.some((i) => i.entity_sync_id === "f"), "the real delete is in the default view");
  assert.ok(defaultPage.json.items.every((i) => i.prior_state === "present"), "default view: only entries that kept a version");
  const flood = defaultPage.json.nothing_kept_summary.find((g) => g.machine_fingerprint === B.fp && g.entity_type === "media_attachments");
  assert.ok(flood && flood.count >= 600, `counted per device and type: ${JSON.stringify(defaultPage.json.nothing_kept_summary)}`);
  assert.equal(flood.license_id, licence.id);
  const sinceHour = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString());
  assert.ok((await list(`?since=${sinceHour}`)).some((i) => i.entity_sync_id === "f"), "and with since=1h");
  // since + before together: only the flood window, which has no kept entry.
  const inFlood = await api.call("GET", `${listUrl}?view=nothing_kept&since=${encodeURIComponent(beforeFlood)}&before=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}&limit=200`, token);
  assert.equal(inFlood.json.items.length, 200);
  assert.ok(inFlood.json.items.every((i) => i.entity_sync_id.startsWith("ghost-")));
  assert.equal((await list(`?before=${encodeURIComponent(beforeFlood)}&view=nothing_kept&entity_sync_id=ghost-0-0`)).length, 0, "before excludes later changes");
  // Cursor paging through the flood: stable order, no duplicates, nothing missed.
  const seenIds = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const r = await api.call(
      "GET",
      `${listUrl}?view=nothing_kept&since=${encodeURIComponent(beforeFlood)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    );
    assert.equal(r.status, 200, r.text);
    for (const it of r.json.items) {
      assert.ok(!seenIds.has(it.id), "no entry twice across pages");
      seenIds.add(it.id);
    }
    cursor = r.json.next_cursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(seenIds.size, 600);
  assert.equal(pages, 3);
  // Item filter: exact type + id.
  const fOnly = await list("?entity_type=media_attachments&entity_sync_id=f");
  assert.deepEqual(fOnly.map((i) => i.entity_sync_id), ["f"]);
  assert.equal((await list("?view=nothing_kept&entity_sync_id=ghost-3-7")).length, 1);

  // ── SF-3: crafted cursors are refused with 400, never a 500 ───────────────────────────────────
  const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  for (const bad of [
    b64({ t: "Thu, 01 Jan 1970 00:00:00 GMT", id: 1 }),
    b64({ us: "12abc", id: 1 }),
    b64({ us: "1".repeat(17), id: 1 }),
    b64({ us: "1000", id: 0 }),
    b64({ us: "1000", id: 1, extra: true }),
    b64([1, 2]),
    "%%%",
  ]) {
    const r = await api.call("GET", `${listUrl}?cursor=${encodeURIComponent(bad)}`, token);
    assert.equal(r.status, 400, `cursor ${bad}: ${r.text}`);
    assert.equal(r.json.error, "invalid_cursor");
  }

  // ── SF-1 probe 4: a device buries a real entry under entries about rows it wrote itself ──────
  await exchange(A, [item("media_attachments", "VICTIM", 1, null, JSON.stringify({ entity_sync_id: "VICTIM", object_key: "k-victim" }), "upsert")]);
  await exchange(B, [item("media_attachments", "VICTIM", 2, 1, JSON.stringify({ entity_sync_id: "VICTIM" }), "delete")]);
  for (let b = 0; b < 3; b += 1) {
    const batch = [];
    for (let i = 0; i < 500; i += 1) {
      const id = `own-${b}-${i}`;
      batch.push(item("media_attachments", id, 1, null, JSON.stringify({ entity_sync_id: id, object_key: `k-${id}` }), "upsert"));
      batch.push(item("media_attachments", id, 2, 1, JSON.stringify({ entity_sync_id: id }), "delete"));
    }
    assert.equal((await exchange(B, batch)).acknowledged_items.length, 1000);
  }
  const buried = await api.call("GET", listUrl, token);
  assert.ok(!buried.json.items.some((i) => i.entity_sync_id === "VICTIM"), "without the filter the victim is buried (page 1 is the flood)");
  const crossPage = await api.call("GET", `${listUrl}?cross_device=1`, token);
  assert.equal(crossPage.status, 200, crossPage.text);
  const victimEntry = crossPage.json.items.find((i) => i.entity_sync_id === "VICTIM");
  assert.ok(victimEntry, "with cross_device=1 the victim is on page 1");
  assert.equal(victimEntry.prior_origin, A.fp);
  assert.equal(victimEntry.changed_by.machine_fingerprint, B.fp);
  assert.ok(crossPage.json.items.every((i) => i.prior_origin !== i.changed_by.machine_fingerprint), "only versions another device wrote");
  assert.ok(!crossPage.json.items.some((i) => i.entity_sync_id.startsWith("own-")));
  // Device filter: only changes sent by that device.
  const byA = await api.call("GET", `${listUrl}?machine_fingerprint=${encodeURIComponent(A.fp)}&view=all&limit=200`, token);
  assert.ok(byA.json.items.length > 0 && byA.json.items.every((i) => i.changed_by.machine_fingerprint === A.fp));
  const byBOwn = await list(`?machine_fingerprint=${encodeURIComponent(B.fp)}&entity_sync_id=own-1-7`);
  assert.equal(byBOwn.length, 1);
  // kept_summary: kept entries per sending device, and how many are about another device's version.
  const truth = await api.su(
    `SELECT changed_by_machine_fingerprint AS fp, count(*)::int AS n,
            count(*) FILTER (WHERE prior_origin_machine_fingerprint IS DISTINCT FROM changed_by_machine_fingerprint)::int AS cross
     FROM sync_deleted_attachment_archive WHERE tenant_id = $1 AND prior_state = 'present' GROUP BY 1`,
    [tenant.id],
  );
  const keptB = buried.json.kept_summary.find((g) => g.machine_fingerprint === B.fp);
  const truthB = truth.find((t) => t.fp === B.fp);
  assert.ok(keptB.count >= 1500);
  assert.deepEqual([keptB.count, keptB.cross_device_count, keptB.license_id], [truthB.n, truthB.cross, licence.id]);
  assert.equal(truthB.n - truthB.cross >= 1500, true, "the flood is all about B's own rows");
  for (const t of truth) {
    const g = buried.json.kept_summary.find((x) => x.machine_fingerprint === t.fp);
    assert.deepEqual([g.count, g.cross_device_count], [t.n, t.cross], `kept_summary for ${t.fp}`);
  }

  // ── SF-2: the migration backfill covers history from before the high-water table ─────────────
  // Simulates an entity whose v50 is only in the ingress log (written before migration 017), then
  // runs the backfill statement of migration 017 itself.
  const migration = readFileSync(join(here, "..", "migrations", "017_sync_attachment_archive.sql"), "utf8");
  const backfillSql = migration.slice(migration.indexOf("-- backfill:begin"), migration.indexOf("-- backfill:end"));
  assert.ok(backfillSql.includes("INSERT INTO sync_attachment_version_high_water"));
  await exchange(A, [item("media_attachments", "old", 1, null, JSON.stringify({ entity_sync_id: "old", object_key: "k-old" }), "upsert")]);
  await api.su(
    `INSERT INTO sync_mirror_ingress (tenant_id, idempotency_key, entity_type, entity_sync_id, operation, row_version,
       payload_json, payload_hash, machine_fingerprint, received_at_rfc3339, protocol_version)
     VALUES ($1, 'pre-017-old', 'media_attachments', 'old', 'upsert', 50, '{}', $2, 'fp-retired', '2026-01-01T00:00:00Z', 'v1')`,
    [tenant.id, sha256Hex("{}")],
  );
  await api.su("DELETE FROM sync_attachment_version_high_water WHERE tenant_id = $1 AND entity_sync_id = 'old'", [tenant.id]);
  await api.su(backfillSql);
  const [hw] = await api.su("SELECT max_row_version FROM sync_attachment_version_high_water WHERE tenant_id = $1 AND entity_sync_id = 'old'", [tenant.id]);
  assert.equal(Number(hw.max_row_version), 50, "backfilled from the ingress log");
  await api.su(backfillSql); // idempotent
  await exchange(B, [item("media_attachments", "old", 2, 1, JSON.stringify({ entity_sync_id: "old" }), "delete")]);
  const oldEntry = (await list("?entity_sync_id=old"))[0];
  assert.equal((await restoreNow(oldEntry.id)).row_version, 51, "the restore goes above the backfilled history");

  // ── A delete of something the server never held: archived as unknown, not restorable ───────
  const ghost = await exchange(B, [item("asset_photos", "photo-never-seen", 2, 1, JSON.stringify({ id: 9 }), "delete")]);
  assert.equal(ghost.acknowledged_items.length, 1, "acceptance unchanged");
  const [ghostRow] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'photo-never-seen'");
  assert.equal(ghostRow.prior_state, "unknown");
  assert.equal(ghostRow.prior_payload_raw, null);
  const ghostListed = (await list("?view=nothing_kept")).find((i) => i.id === String(ghostRow.id));
  assert.equal(ghostListed.restorable, false);
  const ghostRestore = await api.call("POST", restoreUrl(ghostRow.id), token, expect(ghostListed.current), privileged);
  assert.equal(ghostRestore.json.error, "nothing_to_restore");
  // A delete of an ordinary type is not archived.
  await exchange(A, [item("equipment", "eq-plain", 1, null, JSON.stringify({ code: "EQ" }))]);
  await exchange(A, [item("equipment", "eq-plain", 2, 1, JSON.stringify({ code: "EQ" }), "delete")]);
  assert.equal((await api.su("SELECT count(*)::int AS n FROM sync_deleted_attachment_archive WHERE entity_type = 'equipment'"))[0].n, 0);

  // ── Forensic device log: site_settings, site_setting_events, permit_types ──────────────────
  const forensicTypes = ["site_settings", "site_setting_events", "permit_types"];
  const viaV2 = forensicTypes.filter((t) => registryTypes.has(t));
  const viaV1 = forensicTypes.filter((t) => !registryTypes.has(t));
  for (const t of viaV2) {
    const r = await exchange(B, [item(t, `${t}-1`, 1, null, JSON.stringify({ rule: "three_person_lock_removal", value: true }))]);
    assert.equal(r.acknowledged_items.length, 1, `${t} accepted (v2)`);
    const u = await exchange(A, [item(t, `${t}-1`, 2, 1, JSON.stringify({ rule: "three_person_lock_removal", value: false }))]);
    assert.equal(u.acknowledged_items.length, 1, `${t} update accepted (v2)`);
  }
  for (const t of viaV1) {
    // Not in this server's v2 registry yet (added with the desktop change that stages it): the v1
    // path accepts any well-formed type and goes through the same hook.
    await exchangeV1(B, [item(t, `${t}-1`, 1, null, JSON.stringify({ rule: "three_person_lock_removal", value: true }), "upsert")]);
    await exchangeV1(A, [item(t, `${t}-1`, 2, 1, JSON.stringify({ rule: "three_person_lock_removal", value: false }), "upsert")]);
  }
  for (const t of forensicTypes) {
    const rows = await api.su(
      `SELECT entity_sync_id, operation, row_version, license_id, machine_fingerprint, payload_hash, server_seq, protocol_version
       FROM sync_forensic_change_log WHERE tenant_id = $1 AND entity_type = $2 ORDER BY id`,
      [tenant.id, t],
    );
    assert.equal(rows.length, 2, `${t}: one row per accepted change`);
    assert.deepEqual(rows.map((r) => r.machine_fingerprint), [B.fp, A.fp], `${t}: the sending devices, in order`);
    assert.ok(rows.every((r) => r.license_id === licence.id));
    assert.equal(rows[0].payload_hash, sha256Hex(JSON.stringify({ rule: "three_person_lock_removal", value: true })));
    assert.equal(rows[0].protocol_version, viaV2.includes(t) ? "v2" : "v1");
  }
  // Ordinary types are not logged; the log is append-only.
  assert.equal((await api.su("SELECT count(*)::int AS n FROM sync_forensic_change_log WHERE entity_type = 'equipment'"))[0].n, 0);
  await assert.rejects(api.su("UPDATE sync_forensic_change_log SET machine_fingerprint = 'forged'"), /append-only/);

  // Retention compacts the ingress log but never the forensic log or the archive.
  await api.su("UPDATE sync_mirror_ingress SET received_at_rfc3339 = '2000-01-01T00:00:00Z' WHERE tenant_id = $1", [tenant.id]);
  await api.su("UPDATE sync_device_checkpoint SET acknowledged_seq = 1000000 WHERE tenant_id = $1", [tenant.id]);
  // The real retention job, in the system scope the API's timer uses.
  const { runSyncRetention } = await import("../dist/sync/retention.js");
  const { Database } = await import("../dist/db/database.js");
  const { runAsSystem } = await import("../dist/app/scope.js");
  const db = new Database(new pg.Pool({ connectionString: api.env.DATABASE_URL, max: 2 }));
  try {
    const report = await runAsSystem(db, "test-retention", () =>
      runSyncRetention(db, { ingressRetentionDays: 1, idempotencyRetentionDays: 1 }),
    );
    assert.ok(report.ingress_rows_deleted > 0, "the ingress log was compacted");
  } finally {
    await db.close();
  }
  assert.equal((await api.su("SELECT count(*)::int AS n FROM sync_mirror_ingress WHERE tenant_id = $1", [tenant.id]))[0].n, 0);
  assert.equal((await api.su("SELECT count(*)::int AS n FROM sync_forensic_change_log WHERE tenant_id = $1", [tenant.id]))[0].n, 6);
  assert.ok((await api.su("SELECT count(*)::int AS n FROM sync_deleted_attachment_archive WHERE tenant_id = $1", [tenant.id]))[0].n >= 4);

  // ── Tenant delete purges the archive, the restore log and the forensic log ───────────────────────────────────────────────────────
  const purge = await api.call("DELETE", `/api/v1/tenants/${tenant.id}`, token, { confirm_slug: "archive" }, {
    "X-Operator-Reason": "archive test cleanup",
    "X-Step-Up-Token": await owner.stepUp("tenant_delete"),
  });
  assert.equal(purge.status, 204, purge.text);
  for (const table of ["sync_deleted_attachment_archive", "sync_attachment_restore_log", "sync_forensic_change_log"]) {
    assert.equal((await api.su(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant.id]))[0].n, 0, `${table} purged`);
  }

  console.log(
    `sync attachment archive: all checks passed (${withObjectStore ? "byte-identical file checked against S3" : "object storage not configured: object key, checksum and manifest checked, file bytes not"}; forensic types via v2: ${viaV2.join(", ") || "none"}, via v1: ${viaV1.join(", ") || "none"})`,
  );
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

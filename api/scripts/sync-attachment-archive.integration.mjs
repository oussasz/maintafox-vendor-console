/**
 * Undoable attachment deletes and the forensic device log (CMMS Advisor decision 2026-10-20,
 * migration 017) against a real Postgres and the real API, through the real sync exchange:
 *
 * - device A uploads a media attachment (row + media manifest; with TEST_S3_* set, the file bytes
 *   too), device B deletes it by sync → accepted as before, and the archive holds the prior row and
 *   the deleting device (licence + fingerprint);
 * - restore needs sync.operate, a reason and a `sync_attachment_restore` step-up; it re-issues the
 *   row to every device (A and B pull it with the identical payload, object key and checksum, at
 *   row_version + 1), is audited, and is refused twice or after the entity changed again;
 * - an attachment deleted before the server ever held it is archived as `unknown` (no crash) and
 *   cannot be restored;
 * - every accepted change of site_settings / site_setting_events / permit_types is kept with its
 *   sending device in sync_forensic_change_log, which retention never compacts.
 *
 * Optional: TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY (an S3-compatible server) add
 * the byte-identical file check (upload → delete → restore → download the same bytes).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
};
const withObjectStore = Boolean(s3.endpoint && s3.accessKey && s3.secretKey);
const api = await startControlApi({
  port: 33251,
  extraEnv: withObjectStore
    ? {
        S3_ENDPOINT: s3.endpoint,
        S3_ACCESS_KEY: s3.accessKey,
        S3_SECRET_KEY: s3.secretKey,
        S3_BUCKET: `mfx-archive-test-${randomBytes(4).toString("hex")}`,
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
      outbox_batch: outbox.map(({ base_row_version: _b, ...rest }) => rest),
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

  const [archived] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE tenant_id = $1 AND entity_sync_id = $2", [tenant.id, mediaId]);
  assert.ok(archived, "the delete is archived");
  assert.equal(archived.entity_type, "media_attachments");
  assert.equal(archived.prior_state, "present");
  assert.equal(archived.prior_payload_raw, mediaPayload, "the prior payload, byte for byte");
  assert.equal(archived.prior_payload_hash, sha256Hex(mediaPayload));
  assert.equal(Number(archived.prior_row_version), 1);
  assert.equal(archived.prior_origin_machine_fingerprint, A.fp);
  assert.equal(archived.deleted_by_machine_fingerprint, B.fp, "the deleting device");
  assert.equal(archived.deleted_by_license_id, licence.id);
  assert.equal(Number(archived.delete_row_version), 2);
  assert.equal(archived.object_refs.payload.object_key, objectKey);
  assert.equal(archived.object_refs.payload.content_sha256, contentSha);
  assert.equal(archived.object_refs.media_manifest.object_key, objectKey);

  // ── Listing (sync.operate), no payload ─────────────────────────────────────────────────────
  const listUrl = `/api/v1/tenants/${tenant.id}/sync/deleted-attachments`;
  const listed = await api.call("GET", listUrl, token);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.items.length, 1);
  const entry = listed.json.items[0];
  assert.equal(entry.entity_sync_id, mediaId);
  assert.equal(entry.deleted_by.machine_fingerprint, B.fp);
  assert.equal(entry.content_sha256, contentSha);
  assert.equal(entry.restored, null);
  assert.equal(entry.restore_blocker, null);
  assert.ok(!listed.text.includes("Seal leak"), "no payload in the listing");
  assert.equal((await api.call("GET", `${listUrl}?status=bogus`, token)).status, 400);
  assert.equal((await api.call("GET", `/api/v1/tenants/no-such-tenant/sync/deleted-attachments`, token)).status, 404);

  // ── Restore guards: permission, reason, step-up kind ──────────────────────────────────────
  const restoreUrl = (id) => `/api/v1/tenants/${tenant.id}/sync/deleted-attachments/${id}/restore`;
  const reasonOnly = { "X-Operator-Reason": "deleted by mistake on the tablet" };
  const noReason = await api.call("POST", restoreUrl(entry.id), token, undefined, { "X-Step-Up-Token": await owner.stepUp("sync_attachment_restore") });
  assert.equal(noReason.status, 403);
  assert.equal(noReason.json.reason, "missing_reason_code");
  const noStepUp = await api.call("POST", restoreUrl(entry.id), token, undefined, reasonOnly);
  assert.equal(noStepUp.status, 403);
  assert.equal(noStepUp.json.reason, "missing_step_up_token");
  const wrongKind = await api.call("POST", restoreUrl(entry.id), token, undefined, {
    ...reasonOnly,
    "X-Step-Up-Token": await owner.stepUp("sync_repair"),
  });
  assert.equal(wrongKind.json.reason, "step_up_action_kind_mismatch");

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
  const auditorRestore = await api.call("POST", restoreUrl(entry.id), auditor.accessToken, undefined, reasonOnly);
  assert.equal(auditorRestore.status, 403);
  assert.equal(auditorRestore.json.error, "permission_denied");

  const stillDeleted = await api.su("SELECT deleted, row_version FROM sync_entity_state WHERE tenant_id = $1 AND entity_sync_id = $2", [tenant.id, mediaId]);
  assert.equal(stillDeleted[0].deleted, true, "refused restores changed nothing");
  assert.equal((await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = 'sync_attachment_restored'"))[0].n, 0);

  // ── Restore ───────────────────────────────────────────────────────────────────────────────
  const privileged = { ...reasonOnly, "X-Step-Up-Token": await owner.stepUp("sync_attachment_restore") };
  const restored = await api.call("POST", restoreUrl(entry.id), token, undefined, privileged);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.row_version, 3, "row_version = delete's + 1");
  assert.equal((await api.call("POST", restoreUrl(entry.id), token, undefined, privileged)).json.error, "already_restored");
  assert.equal((await api.call("POST", restoreUrl("999999"), token, undefined, privileged)).status, 404);
  assert.equal((await api.call("POST", restoreUrl("not-a-number"), token, undefined, privileged)).status, 404);

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

  const [marked] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE id = $1", [archived.id]);
  assert.ok(marked.restored_at);
  assert.equal(marked.restore_reason, "deleted by mistake on the tablet");
  assert.equal(Number(marked.restore_row_version), 3);
  const [ledger] = await api.su("SELECT * FROM audit_records WHERE action_code = 'sync_attachment_restored'");
  assert.ok(ledger, "audited");
  assert.equal(ledger.record_id, marked.restore_audit_record_id);
  assert.equal(ledger.scope_tenant_id, tenant.id);
  assert.ok(!JSON.stringify(ledger).includes("Seal leak"), "no payload in the ledger");
  const [ingress] = await api.su("SELECT machine_fingerprint, row_version, base_row_version FROM sync_mirror_ingress WHERE id = $1", [marked.restore_ingress_id]);
  assert.equal(ingress.machine_fingerprint, "server:attachment-restore");
  assert.equal(Number(ingress.base_row_version), 2);
  // The archived evidence cannot be rewritten (trigger), even by the database owner.
  await assert.rejects(api.su("UPDATE sync_deleted_attachment_archive SET prior_payload_raw = 'x' WHERE id = $1", [archived.id]), /already restored/);
  const listedAfter = (await api.call("GET", `${listUrl}?status=restored`, token)).json.items;
  assert.equal(listedAfter.length, 1);
  assert.equal(listedAfter[0].restored.reason, "deleted by mistake on the tablet");
  assert.equal(listedAfter[0].restore_blocker, "already_restored");

  // A device edits the restored row normally afterwards (base = restored version).
  const edited = await exchange(A, [item("media_attachments", mediaId, 4, 3, mediaPayload.replace("before repair", "after repair"), "upsert")]);
  assert.equal(edited.acknowledged_items.length, 1);

  // ── Refused after the entity changed: delete again, then re-create, then restore → 409 ─────
  const del2 = await exchange(B, [item("media_attachments", mediaId, 5, 4, JSON.stringify({ entity_sync_id: mediaId }), "delete")]);
  assert.equal(del2.acknowledged_items.length, 1);
  const second = (await api.call("GET", `${listUrl}?status=open`, token)).json.items;
  assert.equal(second.length, 1);
  assert.equal(second[0].restore_blocker, null);
  const recreated = await exchange(A, [item("media_attachments", mediaId, 6, 5, mediaPayload, "upsert")]);
  assert.equal(recreated.acknowledged_items.length, 1);
  const afterRecreate = await api.call("POST", restoreUrl(second[0].id), token, undefined, privileged);
  assert.equal(afterRecreate.status, 409);
  assert.equal(afterRecreate.json.error, "entity_changed_since_delete");
  assert.equal((await api.call("GET", `${listUrl}?status=open`, token)).json.items[0].restore_blocker, "entity_changed_since_delete");

  // ── A delete of something the server never held: archived as unknown, not restorable ───────
  const ghost = await exchange(B, [item("asset_photos", "photo-never-seen", 2, 1, JSON.stringify({ id: 9 }), "delete")]);
  assert.equal(ghost.acknowledged_items.length, 1, "acceptance unchanged");
  const [ghostRow] = await api.su("SELECT * FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'photo-never-seen'");
  assert.equal(ghostRow.prior_state, "unknown");
  assert.equal(ghostRow.prior_payload_raw, null);
  const ghostRestore = await api.call("POST", restoreUrl(ghostRow.id), token, undefined, privileged);
  assert.equal(ghostRestore.json.error, "nothing_to_restore");
  // Deleting it again: the prior state is a delete marker.
  await exchange(A, [item("asset_photos", "photo-never-seen", 3, 2, JSON.stringify({ id: 9 }), "delete")]);
  const [again] = await api.su("SELECT prior_state FROM sync_deleted_attachment_archive WHERE entity_sync_id = 'photo-never-seen' ORDER BY id DESC LIMIT 1");
  assert.equal(again.prior_state, "already_deleted");
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

  // ── Tenant delete purges both tables ───────────────────────────────────────────────────────
  const purge = await api.call("DELETE", `/api/v1/tenants/${tenant.id}`, token, { confirm_slug: "archive" }, {
    "X-Operator-Reason": "archive test cleanup",
    "X-Step-Up-Token": await owner.stepUp("tenant_delete"),
  });
  assert.equal(purge.status, 204, purge.text);
  for (const table of ["sync_deleted_attachment_archive", "sync_forensic_change_log"]) {
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

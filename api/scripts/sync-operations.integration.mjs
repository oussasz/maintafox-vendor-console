/**
 * Sync operations per device (master plan Phase 4.5) against a real Postgres and the real API, with
 * the real sync v2 protocol: the device timeline shows what the store recorded (exchanges, retries,
 * refused items, conflicts, operator actions), and the repair — a full resynchronisation (step-up
 * sync_repair, audited) — makes the device's next checkpointed exchange fail with
 * invalid_checkpoint_token (what the desktop answers with a full snapshot), and closes once that
 * snapshot completes.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const api = await startControlApi({ port: 33241 });

function item(entitySyncId, rowVersion, baseRowVersion, payload) {
  const payload_json = JSON.stringify(payload);
  return {
    idempotency_key: randomUUID(),
    entity_type: "equipment",
    entity_sync_id: entitySyncId,
    operation: baseRowVersion === null ? "create" : "update",
    row_version: rowVersion,
    base_row_version: baseRowVersion,
    payload_json,
    payload_hash: sha256Hex(payload_json),
  };
}

try {
  const owner = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const token = owner.accessToken;
  const tenant = (await api.call("POST", "/api/v1/tenants", token, { slug: "sync-ops", display_name: "Sync ops" })).json;
  const licence = (await api.call("POST", "/api/v1/licenses", token, { tenant_id: tenant.id, max_machines: 2 })).json;
  const fp = "fp-sync-ops-device-1";
  const claimed = await api.call("POST", "/api/v1/activation/claim", null, {
    license_key: licence.license_key,
    machine_fingerprint: fp,
    app_version: "1.0.0",
  });
  const dev = { token: claimed.json.activation_token, checkpoint: null };

  const exchange = (outbox = [], idempotencyKey = `ex-${randomUUID()}`) =>
    api.call("POST", "/api/v1/sync/exchange", dev.token, {
      protocol_version: "v2",
      idempotency_key: idempotencyKey,
      checkpoint_token: dev.checkpoint,
      current_user_sync_ids: [],
      device_class: "desktop",
      outbox_batch: outbox,
    });
  const snapshotAll = async () => {
    let pageToken = null;
    for (let i = 0; i < 100; i += 1) {
      const r = await api.call("POST", "/api/v1/sync/snapshot", dev.token, {
        protocol_version: "v2",
        page_token: pageToken,
        page_size: 50,
        scope: "all",
        current_user_sync_ids: [],
      });
      assert.equal(r.status, 200, r.text);
      if (!r.json.has_more) return r.json.checkpoint_token;
      pageToken = r.json.next_page_token;
    }
    throw new Error("snapshot did not converge");
  };

  // ── Activity: applied, refused (unknown type), stale (conflict), retried ─────────────────
  dev.checkpoint = await snapshotAll();
  const first = await exchange([item("eq-1", 1, null, { name: "Pump" })]);
  assert.equal(first.status, 200, first.text);
  dev.checkpoint = first.json.checkpoint_token;
  const refusedItem = { ...item("eq-x", 1, null, { name: "Bad" }), entity_type: "not_a_registered_type" };
  const refused = await exchange([refusedItem]);
  assert.equal(refused.status, 200, refused.text);
  dev.checkpoint = refused.json.checkpoint_token;
  // Two edits from the same base version: the second one is stale (conflict).
  const update = await exchange([item("eq-1", 2, 1, { name: "Pump v2" })]);
  assert.equal(update.status, 200, update.text);
  dev.checkpoint = update.json.checkpoint_token;
  const stale = await exchange([item("eq-1", 2, 1, { name: "Pump v2 from a stale base" })]);
  assert.equal(stale.status, 200, stale.text);
  dev.checkpoint = stale.json.checkpoint_token;
  // A lost response: the device sends the same request again (same key, same body).
  const retryKey = `ex-${randomUUID()}`;
  const sent = await exchange([], retryKey);
  assert.equal(sent.status, 200);
  const retried = await exchange([], retryKey);
  assert.equal(retried.status, 200);
  dev.checkpoint = sent.json.checkpoint_token;

  // ── Timeline ───────────────────────────────────────────────────────────────────────────
  const timelineUrl = `/api/v1/ops/devices/${tenant.id}/${fp}/timeline`;
  assert.equal((await api.call("GET", `${timelineUrl}?hours=0`, token)).status, 400);
  assert.equal((await api.call("GET", `/api/v1/ops/devices/${tenant.id}/fp-unknown-000/timeline`, token)).status, 404);
  const timeline = await api.call("GET", timelineUrl, token);
  assert.equal(timeline.status, 200, timeline.text);
  const kinds = timeline.json.events.map((e) => e.kind);
  assert.ok(kinds.filter((k) => k === "exchange").length >= 4, `exchanges recorded: ${kinds}`);
  assert.ok(kinds.includes("rejection"), "refused item shown");
  assert.ok(kinds.includes("conflict"), "conflict shown");
  assert.equal(timeline.json.events.find((e) => e.kind === "rejection").detail.entity_sync_id, "eq-x");
  assert.ok(timeline.json.events.some((e) => e.kind === "exchange" && e.detail.retries === 1), "the retry is counted");
  assert.ok(timeline.json.measured, "measured lag / checkpoint age from the ops metrics");
  assert.equal(timeline.json.measured.protocol, "v2");
  const times = timeline.json.events.map((e) => e.at);
  assert.deepEqual(times, [...times].sort().reverse(), "newest first");

  // ── Repair: full resynchronisation ─────────────────────────────────────────────────────
  const resyncUrl = `/api/v1/ops/devices/${tenant.id}/${fp}/resync`;
  assert.equal((await api.call("POST", resyncUrl, token)).status, 403, "a reason is required");
  const wrongKind = await api.call("POST", resyncUrl, token, undefined, {
    "X-Operator-Reason": "diverged copy",
    "X-Step-Up-Token": await owner.stepUp("rollout_publish"),
  });
  assert.equal(wrongKind.json.reason, "step_up_action_kind_mismatch");
  const repair = { "X-Operator-Reason": "diverged copy", "X-Step-Up-Token": await owner.stepUp("sync_repair") };
  const requested = await api.call("POST", resyncUrl, token, undefined, repair);
  assert.equal(requested.status, 200, requested.text);
  assert.equal((await api.call("POST", resyncUrl, token, undefined, repair)).status, 409, "one open request per device");

  const refusedCheckpoint = await exchange([item("eq-2", 1, null, { name: "Valve" })]);
  assert.equal(refusedCheckpoint.status, 400);
  assert.equal(refusedCheckpoint.json.error, "invalid_checkpoint_token", "the desktop answers this with a full snapshot");
  dev.checkpoint = await snapshotAll();
  const resumed = await exchange([item("eq-2", 1, null, { name: "Valve" })]);
  assert.equal(resumed.status, 200, `after the snapshot the device syncs again: ${resumed.text}`);
  const after = (await api.call("GET", timelineUrl, token)).json;
  assert.equal(after.open_resync, null, "the snapshot closed the request");
  assert.ok(after.events.some((e) => e.kind === "resync_requested"));
  assert.ok(after.events.some((e) => e.kind === "resync_completed"));
  assert.ok(after.events.some((e) => e.kind === "operator_action" && e.detail.action === "sync_device_resync"));
  const audited = await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = 'sync_device_resync'");
  assert.equal(audited[0].n, 1);

  console.log("sync operations (4.5): all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

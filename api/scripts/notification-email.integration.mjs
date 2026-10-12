/**
 * POST /api/v1/notifications/email against the real API and a real SMTP server (smtp-server, the
 * nodemailer project's server library) on 127.0.0.1: capability gate, recipient resolution from the
 * tenant's encrypted user accounts, one email per request_id, conflicts, refusals, SMTP failure and
 * retry. Addresses are synthetic.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { SMTPServer } from "smtp-server";

import { startControlApi } from "./lib/control-api.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const received = [];
const smtpPort = await freePort();
let smtp = null;
async function startSmtp() {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (c) => (raw += String(c)));
      stream.on("end", () => {
        // Quoted-printable soft line breaks ("=" + CRLF) removed: the text as the reader sees it.
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: raw.replace(/=\r\n/g, "") });
        callback();
      });
    },
  });
  await new Promise((r) => smtp.listen(smtpPort, "127.0.0.1", r));
}
const stopSmtp = () => new Promise((r) => smtp.close(r));
await startSmtp();

const api = await startControlApi({
  port: 33195,
  extraEnv: {
    EMAIL_DELIVERY_MODE: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: "false",
    EMAIL_FROM: "Maintafox <notifications@example.test>",
  },
});
try {
  const admin = await api.adminToken();
  const t = await api.call("POST", "/api/v1/tenants", admin, { slug: "mail-a", display_name: "Plant A" });
  const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: t.json.id, max_machines: 1 });
  const device = await api.claimDevice(l.json.license_key, "mail-device");
  const other = await api.call("POST", "/api/v1/tenants", admin, { slug: "mail-b", display_name: "Plant B" });
  const lb = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: other.json.id, max_machines: 1 });
  const deviceB = await api.claimDevice(lb.json.license_key, "mail-device-b");

  // User accounts arrive through sync (stored encrypted at rest).
  const user = (id, payload) => {
    const payload_json = JSON.stringify(payload);
    return {
      idempotency_key: randomUUID(),
      entity_type: "user_accounts",
      entity_sync_id: id,
      operation: "create",
      row_version: 1,
      base_row_version: null,
      payload_json,
      payload_hash: sha(payload_json),
    };
  };
  const push = async (token, items) => {
    const r = await api.call("POST", "/api/v1/sync/exchange", token, {
      protocol_version: "v2",
      idempotency_key: `ex-${randomUUID()}`,
      checkpoint_token: null,
      current_user_sync_ids: [],
      device_class: "desktop",
      outbox_batch: items,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.acknowledged_items.length, items.length);
  };
  await push(device, [
    user("u-tech", { username: "tech1", email: "tech1@example.test", is_active: 1 }),
    user("u-nomail", { username: "tech2", email: null, is_active: 1 }),
    user("u-off", { username: "tech3", email: "tech3@example.test", is_active: 0 }),
  ]);
  await push(deviceB, [user("u-b", { username: "b1", email: "b1@example.test", is_active: 1 })]);

  const request = (overrides = {}) => ({
    request_id: "notif-1:u-tech",
    notification_sync_id: "notif-1",
    recipient_user_sync_id: "u-tech",
    category_code: "wo_overdue",
    severity: "warning",
    title: "Work order OT-7KQ2-0001 is overdue",
    body: "Pump P-101 bearing replacement is 2 days late.",
    action_url: "/work-orders/OT-7KQ2-0001",
    occurred_at: "2026-10-12T08:30:00Z",
    source_module: "work_orders",
    source_record_id: "wo-1",
    ...overrides,
  });
  const send = (body, token = device) => api.call("POST", "/api/v1/notifications/email", token, body);

  // The edition must enable the capability explicitly.
  let r = await send(request());
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "email_not_enabled");
  const editions = (await api.call("GET", "/api/v1/editions", admin)).json.items;
  const core = editions.find((e) => e.id === "core");
  assert.equal(core.capabilities["notifications.email"], false, "off in factory editions");
  const ed = await api.call("POST", "/api/v1/editions", admin, {
    id: "core-email",
    label: "Core + email",
    capabilities: { ...core.capabilities, "notifications.email": true },
  });
  assert.equal(ed.status, 201, ed.text);
  assert.equal((await api.call("PATCH", `/api/v1/tenants/${t.json.id}`, admin, { edition: "core-email" })).status, 200);

  // Sent once.
  r = await send(request());
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.json, { request_id: "notif-1:u-tech", status: "accepted" });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].to, ["tech1@example.test"]);
  assert.match(received[0].raw, /Subject: \[Maintafox\] Work order OT-7KQ2-0001 is overdue/);
  assert.match(received[0].raw, /Pump P-101 bearing replacement is 2 days late\./);
  assert.match(received[0].raw, /Site: Plant A/);
  r = await send(request());
  assert.deepEqual(r.json, { request_id: "notif-1:u-tech", status: "duplicate" });
  assert.equal(received.length, 1, "a duplicate is not sent again");
  r = await send(request({ title: "Something else" }));
  assert.equal(r.status, 409);

  // Refusals.
  assert.equal((await send({ ...request({ request_id: "x" }), extra: 1 })).status, 400);
  assert.equal((await send(request({ request_id: "x2", severity: "loud" }))).status, 400);
  assert.equal((await send(request({ request_id: "n1", recipient_user_sync_id: "u-none" }))).json.error, "recipient_not_found");
  assert.equal((await send(request({ request_id: "n2", recipient_user_sync_id: "u-nomail" }))).json.error, "recipient_has_no_email");
  assert.equal((await send(request({ request_id: "n3", recipient_user_sync_id: "u-off" }))).json.error, "recipient_inactive");
  assert.equal((await send(request({ request_id: "n4", recipient_user_sync_id: "u-b" }))).json.error, "recipient_not_found", "another tenant's user");
  assert.equal((await send(request(), null)).status, 401);
  assert.equal(received.length, 1);

  // SMTP down: 502 (the desktop retries); back up: the same request_id is sent.
  await stopSmtp();
  r = await send(request({ request_id: "notif-2:u-tech", notification_sync_id: "notif-2" }));
  assert.equal(r.status, 502, r.text);
  assert.equal(r.json.error, "email_send_failed");
  await startSmtp();
  r = await send(request({ request_id: "notif-2:u-tech", notification_sync_id: "notif-2" }));
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.status, "accepted");
  assert.equal(received.length, 2);

  // Stored: status and attempts only, never the address or the text.
  const rows = await api.su("SELECT * FROM notification_email_requests ORDER BY request_id");
  assert.deepEqual(rows.map((x) => [x.request_id, x.status, x.attempts]), [["notif-1:u-tech", "sent", 1], ["notif-2:u-tech", "sent", 2]]);
  assert.ok(!JSON.stringify(rows).includes("tech1@example.test"));
  assert.ok(!JSON.stringify(rows).includes("Pump P-101"));
  console.log("notification-email: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
  await stopSmtp().catch(() => undefined);
}

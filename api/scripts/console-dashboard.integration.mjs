/**
 * Console dashboards (routes/console.ts) against a real Postgres and the real API: every figure
 * and every "needs your attention" item comes from data the test put there (customers, licences
 * ending soon or ended, a device that stopped syncing, a new ticket, backup runs), and the health
 * answer reflects the backup runs and the probes.
 */
import assert from "node:assert/strict";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { loginOperator } from "./lib/vendor-session.mjs";

const api = await startControlApi({ port: 33251, extraEnv: { BACKUP_LOCAL_RETENTION_DAYS: "14" } });
const DAY = 86_400_000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString();

try {
  const session = await loginOperator(api.baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  const token = session.accessToken;
  const privileged = async (kind, reason) => ({ "X-Operator-Reason": reason, "X-Step-Up-Token": await session.stepUp(kind) });
  const get = async (path) => {
    const r = await api.call("GET", path, token);
    assert.equal(r.status, 200, `${path}: ${r.text}`);
    return r.json;
  };

  // Empty platform: nothing invented.
  let overview = await get("/api/v1/console/overview");
  assert.deepEqual(overview.figures, {
    customers_total: 0,
    customers_active: 0,
    devices_in_use: 0,
    seats_total: 0,
    seats_free: 0,
    mobile_devices_in_use: 0,
    mobile_seats_total: 0,
    mobile_seats_free: 0,
    licences_expiring: 0,
    open_tickets: 0,
  });
  assert.deepEqual(overview.customers, []);
  // No backup has ever run: that is the first thing to look at.
  assert.deepEqual(overview.attention.map((a) => a.kind), ["backup_late", "restore_test_overdue"]);
  assert.equal(overview.health.status, "attention");

  // Customers: one renewing soon with devices, one whose licence ended, one never activated.
  const mk = async (slug, name) => (await api.call("POST", "/api/v1/tenants", token, { slug, display_name: name })).json;
  const acme = await mk("acme", "Acme");
  const beta = await mk("beta", "Beta");
  const gamma = await mk("gamma", "Gamma");
  const lic = async (tenant, max, expires) =>
    (await api.call("POST", "/api/v1/licenses", token, { tenant_id: tenant.id, max_machines: max, expires_at: expires })).json;
  const acmeLicence = await lic(acme, 5, inDays(12));
  const betaLicence = await lic(beta, 2, inDays(200));
  await api.su("UPDATE license_keys SET expires_at = $1 WHERE id = $2", [inDays(-5), betaLicence.id]);
  await lic(gamma, 10, null);
  await api.claimDevice(acmeLicence.license_key, "fp-acme-office");
  await api.claimDevice(acmeLicence.license_key, "fp-acme-workshop");
  // The workshop machine (activated, never synced) has not been seen for 3 days.
  await api.su("UPDATE machine_activations SET last_seen_at = $1, machine_label = 'Atelier-02' WHERE machine_fingerprint = 'fp-acme-workshop'", [
    inDays(-3),
  ]);
  const ticket = await api.call("POST", "/api/v1/support/tickets", token, {
    tenant_id: acme.id,
    severity: "warn",
    affected_module: "reports",
    summary: "Le PDF ne s'imprime pas",
  });
  assert.equal(ticket.status, 201, ticket.text);
  await api.su(
    `INSERT INTO backup_runs (kind, status, offsite_status, started_at, finished_at, dump_file, detail)
     VALUES ('nightly', 'succeeded', 'disabled', now() - interval '2 hours', now() - interval '2 hours', 'maintafox-20261013.dump.age', 'test'),
            ('restore_drill', 'succeeded', 'not_applicable', now() - interval '3 days', now() - interval '3 days', NULL, 'test')`,
  );

  overview = await get("/api/v1/console/overview");
  assert.deepEqual(overview.figures, {
    customers_total: 3,
    customers_active: 3,
    devices_in_use: 2,
    seats_total: 15, // Acme 5 + Gamma 10; Beta's licence has ended
    seats_free: 13,
    // No licence includes phones (max_mobile_devices defaults to 0, migration 019).
    mobile_devices_in_use: 0,
    mobile_seats_total: 0,
    mobile_seats_free: 0,
    licences_expiring: 1,
    open_tickets: 1,
  });
  const byName = Object.fromEntries(overview.customers.map((c) => [c.name, c]));
  assert.equal(byName.Acme.status, "expires_soon");
  assert.equal(byName.Acme.devices_used, 2);
  assert.equal(byName.Acme.seats, 5);
  assert.equal(byName.Acme.mobile_devices_used, 0);
  assert.equal(byName.Acme.mobile_seats, 0);
  assert.equal(byName.Beta.status, "expired");
  assert.equal(byName.Gamma.status, "not_activated");
  assert.equal(byName.Gamma.licence_never_ends, true);
  assert.equal(byName.Gamma.licence_until, null);

  const kinds = overview.attention.map((a) => a.kind);
  assert.deepEqual(kinds, ["licence_expired", "licence_expiring", "device_never_synced", "ticket_new"], JSON.stringify(overview.attention));
  const [expired, expiring, device, newTicket] = overview.attention;
  assert.equal(expired.tenant_name, "Beta");
  assert.equal(expired.facts.days_ago, 5);
  assert.equal(expiring.tenant_name, "Acme");
  assert.ok(expiring.facts.days_left === 12 || expiring.facts.days_left === 11, String(expiring.facts.days_left));
  assert.equal(expiring.facts.devices, 2);
  assert.equal(device.facts.device_label, "Atelier-02");
  assert.equal(device.facts.days, 3);
  assert.equal(newTicket.facts.summary, "Le PDF ne s'imprime pas");
  assert.equal(overview.health.backup_encrypted, true);
  assert.equal(overview.health.devices_total, 2);
  assert.equal(overview.health.devices_syncing, 1);
  assert.equal(overview.health.status, "attention");

  // A suspended customer stays in the list (so it can be found and resumed), marked suspended; it counts
  // in the total but not as active, and its licences / devices stop being work items.
  const suspend = (tenant, reason) =>
    privileged("entitlement_suspension", reason).then((h) => api.call("POST", `/api/v1/tenants/${tenant.id}/suspend`, token, { reason }, h));
  const resume = (tenant, reason) =>
    privileged("tenant_restore", reason).then((h) => api.call("POST", `/api/v1/tenants/${tenant.id}/resume`, token, { reason }, h));
  const before = overview.figures;
  assert.equal((await suspend(gamma, "unpaid invoice")).status, 200);
  overview = await get("/api/v1/console/overview");
  assert.equal(overview.figures.customers_total, 3, "a suspended customer is still a customer");
  assert.equal(overview.figures.customers_active, 2);
  assert.equal(overview.customers.length, 3);
  assert.equal(overview.customers.find((c) => c.name === "Gamma").status, "suspended");
  assert.equal(overview.figures.seats_total, before.seats_total - 10, "suspended seats are not counted");

  // Older rows can be inactive without a suspended_at: they are suspended too, and their licence
  // (expiring soon) and device (not syncing) are no longer "needs action".
  await api.su("UPDATE tenants SET is_active = 0, suspended_at = NULL WHERE id = $1", [acme.id]);
  overview = await get("/api/v1/console/overview");
  assert.equal(overview.customers.find((c) => c.name === "Acme").status, "suspended");
  assert.equal(overview.figures.customers_total, 3);
  assert.equal(overview.figures.customers_active, 1);
  assert.equal(overview.figures.licences_expiring, 0);
  assert.equal(overview.figures.devices_in_use, 0);
  assert.ok(!overview.attention.some((x) => x.tenant_name === "Acme" && x.kind !== "ticket_new"), JSON.stringify(overview.attention)); // its open ticket still shows

  // Lifting the suspension makes both active again.
  assert.equal((await resume(gamma, "paid")).status, 200);
  assert.equal((await resume(acme, "paid")).status, 200);
  overview = await get("/api/v1/console/overview");
  assert.deepEqual(overview.figures, before);
  assert.equal(overview.customers.find((c) => c.name === "Gamma").status, "not_activated");
  assert.equal(overview.customers.find((c) => c.name === "Acme").status, "expires_soon");

  // Health page.
  const health = await get("/api/v1/console/health");
  assert.equal(health.server.online, true);
  assert.ok(["ok", "slow"].includes(health.server.database.state));
  assert.equal(health.server.file_storage, "not_configured");
  assert.equal(health.backups.encrypted, true);
  assert.equal(health.backups.offsite, "disabled");
  assert.equal(health.backups.retention_days, 14);
  assert.equal(health.backups.backup_late, false);
  assert.equal(health.backups.restore_test_overdue, false);
  assert.equal(health.sync.devices_total, 2);
  assert.equal(health.sync.devices_up_to_date, 1);
  assert.deepEqual(health.sync.first_device_behind, { tenant_id: acme.id, machine_id: "fp-acme-workshop" });
  assert.equal(health.updates.devices_total, 2);
  assert.deepEqual(health.updates.versions, [{ version: "1.2.3", devices: 2 }]);
  assert.equal(health.status, "attention");

  console.log("console dashboards: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

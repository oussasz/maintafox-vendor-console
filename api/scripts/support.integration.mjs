/**
 * Support entities (master plan Phase 3.4) against a real Postgres and the real API:
 * operator-opened tickets (audited), interventions, runbooks (real content from migration 009,
 * create / update / delete audited), readiness computed from the data, seed fixtures gone.
 * Device bundle upload needs object storage: scripts/support-bundles.integration.mjs.
 */
import assert from "node:assert/strict";

import { startControlApi } from "./lib/control-api.mjs";

const api = await startControlApi({ port: 33191 });
try {
  const admin = await api.adminToken();
  const t = await api.call("POST", "/api/v1/tenants", admin, { slug: "support-a", display_name: "Support A" });
  assert.equal(t.status, 201);
  const tenantId = t.json.id;

  // No seed fixtures.
  assert.deepEqual((await api.call("GET", "/api/v1/support/tickets", admin)).json, []);
  assert.equal((await api.call("GET", "/api/v1/support/diagnostic-bundles/latest", admin)).status, 404);
  assert.deepEqual((await api.call("GET", "/api/v1/support/diagnostic-bundles", admin)).json, []);

  // Operator opens a ticket.
  const bad = await api.call("POST", "/api/v1/support/tickets", admin, { tenant_id: tenantId, severity: "warn" });
  assert.equal(bad.status, 400);
  const missing = await api.call("POST", "/api/v1/support/tickets", admin, {
    tenant_id: "tenant_nope",
    severity: "warn",
    affected_module: "sync",
    summary: "Sync stalls",
  });
  assert.equal(missing.status, 404);
  const created = await api.call("POST", "/api/v1/support/tickets", admin, {
    tenant_id: tenantId,
    severity: "critical",
    affected_module: "sync",
    summary: "Two devices stopped syncing after the update",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const ticket = created.json;
  assert.equal(ticket.state, "new");
  assert.equal(ticket.origin, "operator");
  assert.match(ticket.created_by, /^user_\d+$/);
  assert.equal(ticket.app_version_reported, null);
  assert.equal(ticket.sync_status_hint, null);
  const ledger = (await api.call("GET", "/api/v1/audit/ledger?q=support_ticket_create", admin)).json;
  assert.ok(ledger.some((r) => r.entity_refs.support_ticket_id === ticket.ticket_id), "ticket creation is audited");

  // Intervention (step-up + reason), then the ticket lists its audit link.
  const stepUp = await api.stepUpToken(admin);
  const intv = await api.call(
    "POST",
    `/api/v1/support/tickets/${ticket.ticket_id}/interventions`,
    admin,
    { action_code: "ticket_triage", note: "Asked for a diagnostic bundle", next_state: "waiting_for_customer" },
    { "X-Operator-Reason": "support-triage", "X-Step-Up-Token": stepUp },
  );
  assert.equal(intv.status, 201, JSON.stringify(intv.json));
  const listed = (await api.call("GET", "/api/v1/support/tickets", admin)).json;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "waiting_for_customer");
  assert.deepEqual(listed[0].linked_audit_record_ids, [intv.json.audit_record_id]);
  const csv = await api.call("GET", "/api/v1/support/tickets/export", admin);
  assert.match(csv.text, /Two devices stopped syncing after the update/);

  // Runbooks: real content from migration 009, operator CRUD audited.
  const runbooks = (await api.call("GET", "/api/v1/audit/hardening/runbooks", admin)).json;
  assert.deepEqual(
    runbooks.map((r) => r.runbook_id),
    ["database_restore", "failed_rollout", "heartbeat_outage", "key_rotation", "storage_pressure", "sync_backlog_surge"],
  );
  assert.ok(runbooks.find((r) => r.runbook_id === "database_restore").first_steps.some((s) => s.includes("BACKUP_AND_RESTORE.md")));
  const rb = await api.call("POST", "/api/v1/audit/hardening/runbooks", admin, {
    runbook_id: "vpn_down",
    title: "Site VPN down",
    summary: "The customer site lost its VPN to the server.",
    first_steps: ["Check the site router", "Ask the customer for a traceroute"],
  });
  assert.equal(rb.status, 201, JSON.stringify(rb.json));
  const dup = await api.call("POST", "/api/v1/audit/hardening/runbooks", admin, {
    runbook_id: "vpn_down",
    title: "Again",
    summary: "Same id twice.",
    first_steps: ["x y z"],
  });
  assert.equal(dup.status, 409);
  const upd = await api.call("PUT", "/api/v1/audit/hardening/runbooks/heartbeat_outage", admin, {
    title: "Devices stop reporting (edited)",
    summary: "Edited by the test.",
    first_steps: ["Step one"],
  });
  assert.equal(upd.status, 200);
  assert.match(upd.json.updated_by, /^user_\d+$/);
  assert.equal((await api.call("DELETE", "/api/v1/audit/hardening/runbooks/vpn_down", admin)).status, 200);
  assert.equal((await api.call("DELETE", "/api/v1/audit/hardening/runbooks/vpn_down", admin)).status, 404);
  const rbLedger = (await api.call("GET", "/api/v1/audit/ledger?q=runbook_", admin)).json;
  assert.deepEqual(rbLedger.map((r) => r.action_code).sort(), ["runbook_create", "runbook_delete", "runbook_update"]);

  // Readiness is computed: chain ok, interventions linked, no uploaded bundle yet.
  const readiness = Object.fromEntries((await api.call("GET", "/api/v1/audit/hardening/readiness", admin)).json.map((c) => [c.code, c]));
  assert.equal(readiness.audit_chain_verified.passed, true);
  assert.equal(readiness.support_ticket_linked.passed, true);
  assert.equal(readiness.export_redaction.passed, false, "no uploaded bundle yet");
  // A tampered ledger fails the readiness check.
  await api.su("UPDATE audit_records SET actor_id = 'forged' WHERE sequence = 1");
  const after = Object.fromEntries((await api.call("GET", "/api/v1/audit/hardening/readiness", admin)).json.map((c) => [c.code, c]));
  assert.equal(after.audit_chain_verified.passed, false);

  // Console routes need an operator token.
  assert.equal((await api.call("GET", "/api/v1/support/diagnostic-bundles", null)).status, 401);
  console.log("support: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

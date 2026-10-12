/** First-boot seeds (SEED_BEHAVIOR): the first vendor admin and, in "full" mode, demo domain rows. */
import bcrypt from "bcryptjs";

import type { Database } from "../db/database.js";
import type { AuditAppender } from "./audit.js";
import { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_BEHAVIOR } from "./config.js";
import { newId, sha256Hex } from "./runtime.js";

export function createSeeder(db: Database, { appendAuditRecord }: AuditAppender) {
  async function seedAdminIfEmpty(): Promise<void> {
    if (SEED_BEHAVIOR === "disabled") return;
    const row = await db.get("SELECT id FROM users LIMIT 1");
    if (row) return;
    if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 8) {
      console.warn(
        "No users and SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD missing (or password < 8 chars) — " +
          "set both to seed the first vendor admin, or create the user via SQL.",
      );
      return;
    }
    const hash = bcrypt.hashSync(SEED_ADMIN_PASSWORD, 12);
    await db.run("INSERT INTO users (email, password_hash) VALUES (?, ?)", SEED_ADMIN_EMAIL, hash);
    console.info(`Seeded admin user: ${SEED_ADMIN_EMAIL}`);
  }

  function shouldSeedDomainData(): boolean {
    return SEED_BEHAVIOR === "full";
  }

  async function seedTenantIfEmpty(): Promise<void> {
    const row = await db.get("SELECT id FROM tenants LIMIT 1");
    if (row) return;
    await db.run("INSERT INTO tenants (id, slug, display_name) VALUES (?, ?, ?)", newId("tenant"), "default", "Default tenant");
    console.info("Seeded default tenant");
  }

  async function seedAuditSupportIfEmpty(): Promise<void> {
    const ticketRow = await db.get("SELECT ticket_id FROM support_tickets LIMIT 1");
    if (!ticketRow) {
      const tenant = await db.get("SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1") as
        | { id: string }
        | undefined;
      if (tenant) {
        await db.run(`INSERT INTO support_tickets
            (ticket_id, tenant_id, state, severity, affected_module, sync_status_hint,
             app_version_reported, linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, "sup_seed_001",
          tenant.id,
          "triaged",
          "warn",
          "sync",
          "retry pressure elevated",
          "0.1.0-dev",
          JSON.stringify(["inc_seed_sync_01"]),
          new Date(Date.now() + 24 * 3600_000).toISOString(),
          new Date().toISOString());
      }
    }

    const auditRow = await db.get("SELECT record_id FROM audit_records LIMIT 1");
    if (!auditRow) {
      const tenant = await db.get("SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1") as
        | { id: string }
        | undefined;
      await appendAuditRecord({
        actor_id: "system_seed",
        action_code: "support_ticket_seed",
        action_category: "support_intervention",
        correlation_id: "seed-corr-1",
        scope_tenant_id: tenant?.id ?? null,
        reason_code: "initial_seed",
        entity_refs: { tenant_id: tenant?.id, support_ticket_id: "sup_seed_001" },
        payload: { source: "bootstrap" },
      });
    }

    const bundleRow = await db.get("SELECT bundle_id FROM diagnostic_bundles LIMIT 1");
    if (!bundleRow) {
      const bundleId = "bundle_seed_001";
      await db.run("INSERT INTO diagnostic_bundles (bundle_id, created_at_rfc3339, redaction_profile) VALUES (?, ?, ?)", bundleId, new Date().toISOString(), "pii_strict_v2");
      await db.run(`INSERT INTO diagnostic_bundle_artifacts (bundle_id, logical_path, sha256, kind)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`, bundleId,
        "logs/desktop.log",
        sha256Hex("seed-log"),
        "text_log",
        bundleId,
        "sync/trace.jsonl",
        sha256Hex("seed-trace"),
        "sync_trace",
        bundleId,
        "release/metadata.json",
        sha256Hex("seed-release"),
        "release_meta");
    }

    const offlineRow = await db.get("SELECT desktop_queue_id FROM offline_ticket_reconciliation LIMIT 1");
    if (!offlineRow) {
      await db.run(`INSERT INTO offline_ticket_reconciliation (desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of)
         VALUES (?, ?, ?, ?), (?, ?, ?, ?)`, "dq_seed_01",
        "sup_seed_001",
        "merged",
        null,
        "dq_seed_02",
        null,
        "pending_upload",
        "sup_seed_001");
    }

    const runbookRow = await db.get("SELECT runbook_id FROM incident_runbooks LIMIT 1");
    if (!runbookRow) {
      const runbooks = [
        {
          runbook_id: "heartbeat_outage",
          title: "Heartbeat outage",
          summary: "Isolate policy freshness versus transport failure.",
          first_steps: ["Check platform health", "Open machines panel", "Correlate recent audit rows"],
        },
        {
          runbook_id: "sync_backlog_surge",
          title: "Sync backlog surge",
          summary: "Drain repair queue and rebalance worker pressure.",
          first_steps: ["Open sync health", "Review repair queue", "Escalate critical lanes"],
        },
        {
          runbook_id: "failed_rollout",
          title: "Failed rollout",
          summary: "Pause/recall with full ticket and audit linkage.",
          first_steps: ["Open rollout diagnostics", "Inspect blockers", "Initiate recall with step-up"],
        },
        {
          runbook_id: "storage_pressure",
          title: "Storage pressure",
          summary: "Control export artifact growth and investigate anomalies.",
          first_steps: ["Check infra pressure", "Inspect export volume", "Apply retention actions"],
        },
        {
          runbook_id: "key_rotation",
          title: "Signing key rotation",
          summary: "Coordinate key lifecycle with immutable evidence.",
          first_steps: ["Validate readiness", "Create intervention ticket", "Append audit evidence"],
        },
      ];
      for (const rb of runbooks) {
        await db.run(
          `INSERT INTO incident_runbooks (runbook_id, title, summary, first_steps_json) VALUES (?, ?, ?, ?)`,
          rb.runbook_id,
          rb.title,
          rb.summary,
          JSON.stringify(rb.first_steps),
        );
      }
    }
  }

  return { seedAdminIfEmpty, shouldSeedDomainData, seedTenantIfEmpty, seedAuditSupportIfEmpty };
}

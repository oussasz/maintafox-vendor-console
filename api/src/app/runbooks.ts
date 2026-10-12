/**
 * Standard incident runbooks (Phase 3.4): real procedures pointing at the actual documents and
 * commands. Ensured at startup like the edition catalog: a missing one is inserted, and one no
 * operator has edited (updated_by IS NULL, e.g. an old seed placeholder) gets the current text.
 * Operators can edit or add runbooks through the API.
 */
import type { Database } from "../db/database.js";

export const STANDARD_RUNBOOKS: ReadonlyArray<{ runbook_id: string; title: string; summary: string; first_steps: string[] }> = [
  {
    "runbook_id": "heartbeat_outage",
    "title": "Devices stop reporting",
    "summary": "Desktops no longer exchange with the server: tell a network or server outage from a device-side problem.",
    "first_steps": [
      "Open Sync health: heartbeat anomalies list each device that is stale, never synced or past its offline grace.",
      "If every tenant is affected, check https://api.maintafox.systems/health and docker compose logs api --since 30m on the server.",
      "If only one device is affected, check its machine in Machines (revoked? licence expired?) and ask the user to open Sync status on the desktop.",
      "Record what you found as an intervention on the support ticket."
    ]
  },
  {
    "runbook_id": "sync_backlog_surge",
    "title": "Refused sync items (dead letters)",
    "summary": "Items refused by the server pile up: find the rejection code and fix its cause.",
    "first_steps": [
      "Open Sync health, then the tenant drill-down: each row shows the refused item, the rejection code and the exchange (batch id).",
      "unknown_entity_type: the desktop sends a type missing from shared/sync-entity-registry.v2.json; add it with the desktop change and deploy.",
      "payload_hash_mismatch or invalid_payload_json: a desktop defect; collect a diagnostic bundle from that device and escalate.",
      "Conflicts are not dead letters: the user resolves them in the desktop conflict screen."
    ]
  },
  {
    "runbook_id": "failed_rollout",
    "title": "Forced update went wrong",
    "summary": "A minimum-version or forced update policy blocks devices it should not: roll the policy back.",
    "first_steps": [
      "Open the tenant or cohort update policy in the console and compare it with the previous one.",
      "Use Roll back (step-up and a reason are required); the rollback is recorded in the audit ledger.",
      "Check Sync health afterwards: the affected devices exchange again within one heartbeat."
    ]
  },
  {
    "runbook_id": "storage_pressure",
    "title": "Server disk or backup pressure",
    "summary": "Disk space, database size or backups are drifting: keep the server healthy and the backups current.",
    "first_steps": [
      "Platform health shows the database size, sync log rows and the backup status from backup_runs.",
      "On the server: df -h, docker system df, and du -sh of the backup_data and pg_wal_archive volumes.",
      "Shorten BACKUP_LOCAL_RETENTION_DAYS or SYNC_INGRESS_RETENTION_DAYS only once the on-premise copy is pulled every night (deploy/backup-pull/README.md).",
      "Never run docker image prune -a: the MinIO images cannot be pulled again (deploy/CI.md)."
    ]
  },
  {
    "runbook_id": "key_rotation",
    "title": "Licence signing key rotation",
    "summary": "Rotate the Ed25519 key that signs licence envelopes without locking out installed desktops.",
    "first_steps": [
      "Generate the new key with node api/scripts/generate-entitlement-signing-key.mjs --key-id mfx-ed25519-YYYY-MM (the private key never leaves the server).",
      "Ship a desktop release that trusts the new public key (src-tauri/src/entitlements/trusted_keys.rs) next to the old one, and wait until devices have it.",
      "Then switch ENTITLEMENT_SIGNING_KEY_ID / ENTITLEMENT_SIGNING_PRIVATE_KEY in .env and restart the API.",
      "Keep the old public key trusted until every envelope signed with it has expired."
    ]
  },
  {
    "runbook_id": "database_restore",
    "title": "Restore the database",
    "summary": "Recover lost or damaged data from the nightly dump or by point-in-time recovery.",
    "first_steps": [
      "The backups are encrypted: ask the owner for the backup private key (password manager) and put it on the server in memory only, as deploy/BACKUP_AND_RESTORE.md section 4 shows; shred it afterwards.",
      "Follow deploy/BACKUP_AND_RESTORE.md section 4: restore.sh restores a dump into a new database and verifies row counts, migrations and the audit chain.",
      "For a lost volume, use restore-physical.sh with the base backup and the WAL archive (point-in-time recovery; the server needs the key while it replays the WAL).",
      "After any restore, run restore-drill.sh and a fresh backup.sh, then note the incident on a support ticket."
    ]
  }
];

export async function ensureStandardRunbooks(db: Database): Promise<void> {
  for (const rb of STANDARD_RUNBOOKS) {
    await db.run(
      `INSERT INTO incident_runbooks (runbook_id, title, summary, first_steps_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (runbook_id) DO UPDATE SET
         title = EXCLUDED.title, summary = EXCLUDED.summary, first_steps_json = EXCLUDED.first_steps_json
       WHERE incident_runbooks.updated_by IS NULL`,
      rb.runbook_id,
      rb.title,
      rb.summary,
      JSON.stringify(rb.first_steps),
    );
  }
}

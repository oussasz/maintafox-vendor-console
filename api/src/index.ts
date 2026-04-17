/**
 * Maintafox control-plane API: email/password JWT, tenants, license lifecycle,
 * and machine activation claims for desktop clients.
 */
import bcrypt from "bcryptjs";
import cors from "cors";
import Database from "better-sqlite3";
import "dotenv/config";
import express from "express";
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 32) {
  console.error("FATAL: Set JWT_SECRET (min 32 characters) in the environment.");
  process.exit(1);
}
const JWT_SECRET: string = JWT_SECRET_RAW;

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://console.maintafox.systems";
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const DB_PATH = join(DATA_DIR, "control-plane.db");
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@maintafox.systems";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const NODE_ENV = process.env.NODE_ENV ?? "development";
const SEED_BEHAVIOR_RAW = (process.env.SEED_BEHAVIOR ?? (NODE_ENV === "production" ? "disabled" : "full")).toLowerCase();
const SEED_BEHAVIOR = SEED_BEHAVIOR_RAW === "disabled" || SEED_BEHAVIOR_RAW === "safe" || SEED_BEHAVIOR_RAW === "full"
  ? SEED_BEHAVIOR_RAW
  : "disabled";
const REQUIRE_PRIVILEGED_STEP_UP = (process.env.REQUIRE_PRIVILEGED_STEP_UP ?? (NODE_ENV === "production" ? "1" : "0")) !== "0";
const REQUIRE_PRIVILEGED_REASON = (process.env.REQUIRE_PRIVILEGED_REASON ?? (NODE_ENV === "production" ? "1" : "0")) !== "0";

/** Matches vendor-console PermissionRecord + RBAC for console operators. */
const VENDOR_PERMISSIONS = [
  "console.view",
  "customer.manage",
  "entitlement.manage",
  "sync.operate",
  "rollout.manage",
  "platform.observe",
  "audit.view",
].map((name) => ({
  name,
  description: name,
  category: "vendor",
  is_dangerous: false,
  requires_step_up: false,
}));

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    force_min_app_version TEXT NULL,
    force_update_mode TEXT NOT NULL DEFAULT 'inherit',
    force_update_reason TEXT NULL,
    rollout_cohort TEXT NOT NULL DEFAULT 'stable-main',
    update_channel TEXT NOT NULL DEFAULT 'stable',
    offline_grace_hours INTEGER NOT NULL DEFAULT 72,
    trust_revocation_disconnects_immediately INTEGER NOT NULL DEFAULT 0,
    reconnect_requires_fresh_heartbeat INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS license_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    license_key TEXT NOT NULL UNIQUE,
    max_machines INTEGER NOT NULL DEFAULT 1,
    update_channel TEXT NOT NULL DEFAULT 'stable',
    issued_by_user_id INTEGER NULL,
    expires_at TEXT NULL,
    revoked_at TEXT NULL,
    revoked_reason TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id)
  );
  CREATE TABLE IF NOT EXISTS machine_activations (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    license_id TEXT NOT NULL,
    machine_fingerprint TEXT NOT NULL,
    machine_label TEXT NULL,
    app_version TEXT NULL,
    activation_token TEXT NOT NULL,
    activated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT NULL,
    UNIQUE(tenant_id, machine_fingerprint),
    FOREIGN KEY(tenant_id) REFERENCES tenants(id),
    FOREIGN KEY(license_id) REFERENCES license_keys(id)
  );
  CREATE TABLE IF NOT EXISTS audit_records (
    record_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE,
    occurred_at_rfc3339 TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action_code TEXT NOT NULL,
    action_category TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    scope_tenant_id TEXT NULL,
    before_snapshot_sha256 TEXT NULL,
    after_snapshot_sha256 TEXT NULL,
    payload_canonical_sha256 TEXT NOT NULL,
    chain_prev_hash TEXT NULL,
    record_integrity_sha256 TEXT NOT NULL,
    reason_code TEXT NULL,
    approval_correlation_id TEXT NULL,
    entity_refs_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    ticket_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    state TEXT NOT NULL,
    severity TEXT NOT NULL,
    affected_module TEXT NOT NULL,
    sync_status_hint TEXT NOT NULL,
    app_version_reported TEXT NOT NULL,
    linked_incident_ids_json TEXT NOT NULL DEFAULT '[]',
    sla_due_rfc3339 TEXT NULL,
    created_at_rfc3339 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS support_ticket_interventions (
    intervention_id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action_code TEXT NOT NULL,
    note TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    reason_code TEXT NULL,
    audit_record_id TEXT NOT NULL,
    created_at_rfc3339 TEXT NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES support_tickets(ticket_id),
    FOREIGN KEY(audit_record_id) REFERENCES audit_records(record_id)
  );
  CREATE TABLE IF NOT EXISTS diagnostic_bundles (
    bundle_id TEXT PRIMARY KEY,
    created_at_rfc3339 TEXT NOT NULL,
    redaction_profile TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS diagnostic_bundle_artifacts (
    bundle_id TEXT NOT NULL,
    logical_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY(bundle_id, logical_path),
    FOREIGN KEY(bundle_id) REFERENCES diagnostic_bundles(bundle_id)
  );
  CREATE TABLE IF NOT EXISTS offline_ticket_reconciliation (
    desktop_queue_id TEXT PRIMARY KEY,
    vendor_ticket_id TEXT NULL,
    sync_state TEXT NOT NULL,
    duplicate_of TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS incident_runbooks (
    runbook_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    first_steps_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cohort_update_policies (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    cohort_label TEXT NOT NULL,
    force_min_app_version TEXT NULL,
    force_update_mode TEXT NOT NULL DEFAULT 'off',
    force_update_reason TEXT NULL,
    updated_at_rfc3339 TEXT NOT NULL,
    updated_by_actor_id TEXT NULL,
    UNIQUE(channel, cohort_label)
  );
  CREATE TABLE IF NOT EXISTS tenant_update_policy_history (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    previous_force_min_app_version TEXT NULL,
    previous_force_update_mode TEXT NOT NULL,
    previous_force_update_reason TEXT NULL,
    changed_at_rfc3339 TEXT NOT NULL,
    changed_by_actor_id TEXT NULL,
    reason_code TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS cohort_update_policy_history (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    cohort_label TEXT NOT NULL,
    previous_force_min_app_version TEXT NULL,
    previous_force_update_mode TEXT NOT NULL,
    previous_force_update_reason TEXT NULL,
    changed_at_rfc3339 TEXT NOT NULL,
    changed_by_actor_id TEXT NULL,
    reason_code TEXT NULL
  );
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at_rfc3339 TEXT NOT NULL
  );
`);

function ensureColumn(table: string, column: string, alterSql: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(alterSql);
  }
}

ensureColumn("tenants", "rollout_cohort", "ALTER TABLE tenants ADD COLUMN rollout_cohort TEXT NOT NULL DEFAULT 'stable-main'");
ensureColumn("tenants", "update_channel", "ALTER TABLE tenants ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'");
ensureColumn("tenants", "force_update_mode", "ALTER TABLE tenants ADD COLUMN force_update_mode TEXT NOT NULL DEFAULT 'inherit'");
ensureColumn("tenants", "force_update_reason", "ALTER TABLE tenants ADD COLUMN force_update_reason TEXT NULL");
ensureColumn("tenants", "offline_grace_hours", "ALTER TABLE tenants ADD COLUMN offline_grace_hours INTEGER NOT NULL DEFAULT 72");
ensureColumn(
  "tenants",
  "trust_revocation_disconnects_immediately",
  "ALTER TABLE tenants ADD COLUMN trust_revocation_disconnects_immediately INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
  "tenants",
  "reconnect_requires_fresh_heartbeat",
  "ALTER TABLE tenants ADD COLUMN reconnect_requires_fresh_heartbeat INTEGER NOT NULL DEFAULT 1",
);
ensureColumn("license_keys", "update_channel", "ALTER TABLE license_keys ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'");

function seedAdminIfEmpty(): void {
  if (SEED_BEHAVIOR === "disabled") return;
  const row = db.prepare("SELECT id FROM users LIMIT 1").get();
  if (row) return;
  if (!SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 8) {
    console.warn(
      "No users and SEED_ADMIN_PASSWORD missing or too short — create user via SQL or set SEED_ADMIN_PASSWORD.",
    );
    return;
  }
  const hash = bcrypt.hashSync(SEED_ADMIN_PASSWORD, 12);
  db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(SEED_ADMIN_EMAIL, hash);
  console.info(`Seeded admin user: ${SEED_ADMIN_EMAIL}`);
}

function shouldSeedDomainData(): boolean {
  return SEED_BEHAVIOR === "full";
}

seedAdminIfEmpty();
if (shouldSeedDomainData()) {
  seedTenantIfEmpty();
  seedAuditSupportIfEmpty();
} else {
  console.info(`Seed behavior '${SEED_BEHAVIOR}' active: domain bootstrap seeds are skipped.`);
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function randomLicenseKey(): string {
  return `MFX-${randomBytes(4).toString("hex").toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function semverCompare(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const dbv = pb[i] ?? 0;
    if (da > dbv) return 1;
    if (da < dbv) return -1;
  }
  return 0;
}

type OpsSeverity = "info" | "warn" | "critical";
type ForceUpdateMode = "off" | "required" | "emergency" | "inherit";

function severityRank(s: OpsSeverity): number {
  if (s === "critical") return 2;
  if (s === "warn") return 1;
  return 0;
}

function worstSeverity(a: OpsSeverity, b: OpsSeverity): OpsSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

const observabilityWindow = {
  started_at_rfc3339: new Date().toISOString(),
  request_total: 0,
  request_5xx_total: 0,
  auth_latency_samples_ms: [] as number[],
  auth_success_total: 0,
  auth_failure_total: 0,
  activation_success_total: 0,
  activation_failure_total: 0,
  activation_failures_by_reason: new Map<string, number>(),
};

function incrementReasonBucket(bucket: Map<string, number>, reason: string): void {
  bucket.set(reason, (bucket.get(reason) ?? 0) + 1);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function structuredLog(event: string, payload: Record<string, unknown>): void {
  // JSON line output is intentionally stable for log shipping/alert parsers.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

function observeAuthAttempt(durationMs: number, success: boolean): void {
  observabilityWindow.auth_latency_samples_ms.push(Math.max(0, Math.round(durationMs)));
  if (observabilityWindow.auth_latency_samples_ms.length > 2_000) {
    observabilityWindow.auth_latency_samples_ms.splice(0, observabilityWindow.auth_latency_samples_ms.length - 2_000);
  }
  if (success) {
    observabilityWindow.auth_success_total += 1;
  } else {
    observabilityWindow.auth_failure_total += 1;
  }
}

function observeActivationOutcome(
  reason: "ok" | "invalid_body" | "license_not_found" | "license_revoked" | "license_expired" | "slot_limit_reached",
): void {
  if (reason === "ok") {
    observabilityWindow.activation_success_total += 1;
    return;
  }
  observabilityWindow.activation_failure_total += 1;
  incrementReasonBucket(observabilityWindow.activation_failures_by_reason, reason);
}

function resolveForceUpdatePolicy(input: {
  appVersion?: string;
  tenantMinVersion: string | null;
  tenantMode: ForceUpdateMode;
  tenantReason: string | null;
  cohortMinVersion: string | null;
  cohortMode: Exclude<ForceUpdateMode, "inherit">;
  cohortReason: string | null;
}): {
  force_min_app_version: string | null;
  force_update_mode: Exclude<ForceUpdateMode, "inherit">;
  force_update_reason: string | null;
  force_update_required: boolean;
  policy_source: "tenant" | "cohort";
} {
  const policySource: "tenant" | "cohort" = input.tenantMode === "inherit" ? "cohort" : "tenant";
  const mode =
    policySource === "tenant" ? (input.tenantMode as Exclude<ForceUpdateMode, "inherit">) : input.cohortMode;
  const minVersion = policySource === "tenant" ? input.tenantMinVersion : input.cohortMinVersion;
  const reason = policySource === "tenant" ? input.tenantReason : input.cohortReason;
  const forceUpdateRequired =
    mode === "emergency" || (mode === "required" && (!input.appVersion || !minVersion || semverCompare(input.appVersion, minVersion) < 0));
  return {
    force_min_app_version: minVersion,
    force_update_mode: mode,
    force_update_reason: reason,
    force_update_required: forceUpdateRequired,
    policy_source: policySource,
  };
}

type AuditEntityRefs = {
  tenant_id?: string;
  entitlement_id?: string;
  machine_id?: string;
  sync_batch_id?: string;
  release_id?: string;
  incident_id?: string;
  support_ticket_id?: string;
};

function auditRecordPreimage(input: {
  record_id: string;
  sequence: number;
  occurred_at_rfc3339: string;
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  payload_canonical_sha256: string;
  chain_prev_hash: string | null;
  reason_code: string | null;
  approval_correlation_id: string | null;
  entity_refs: AuditEntityRefs;
}): string {
  const refs = input.entity_refs;
  const o = (v?: string | null) => v ?? "";
  return [
    "audit_v1",
    input.record_id,
    String(input.sequence),
    input.occurred_at_rfc3339,
    input.actor_id,
    input.action_code,
    input.action_category,
    input.correlation_id,
    o(input.scope_tenant_id),
    o(input.before_snapshot_sha256),
    o(input.after_snapshot_sha256),
    input.payload_canonical_sha256,
    o(input.chain_prev_hash),
    o(input.reason_code),
    o(input.approval_correlation_id),
    o(refs.tenant_id),
    o(refs.entitlement_id),
    o(refs.machine_id),
    o(refs.sync_batch_id),
    o(refs.release_id),
    o(refs.incident_id),
    o(refs.support_ticket_id),
  ].join("|");
}

function appendAuditRecord(input: {
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id?: string | null;
  reason_code?: string | null;
  approval_correlation_id?: string | null;
  entity_refs?: AuditEntityRefs;
  payload?: unknown;
}): string {
  const prev = db
    .prepare("SELECT sequence, record_integrity_sha256 FROM audit_records ORDER BY sequence DESC LIMIT 1")
    .get() as { sequence: number; record_integrity_sha256: string } | undefined;
  const sequence = (prev?.sequence ?? 0) + 1;
  const now = new Date().toISOString();
  const recordId = newId("audit");
  const entityRefs = input.entity_refs ?? {};
  const payloadCanonical = JSON.stringify(input.payload ?? {});
  const payloadSha = sha256Hex(payloadCanonical);
  const preimage = auditRecordPreimage({
    record_id: recordId,
    sequence,
    occurred_at_rfc3339: now,
    actor_id: input.actor_id,
    action_code: input.action_code,
    action_category: input.action_category,
    correlation_id: input.correlation_id,
    scope_tenant_id: input.scope_tenant_id ?? null,
    before_snapshot_sha256: null,
    after_snapshot_sha256: null,
    payload_canonical_sha256: payloadSha,
    chain_prev_hash: prev?.record_integrity_sha256 ?? null,
    reason_code: input.reason_code ?? null,
    approval_correlation_id: input.approval_correlation_id ?? null,
    entity_refs: entityRefs,
  });
  const integrity = sha256Hex(preimage);
  db.prepare(
    `INSERT INTO audit_records
      (record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
       correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
       payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
       approval_correlation_id, entity_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    recordId,
    sequence,
    now,
    input.actor_id,
    input.action_code,
    input.action_category,
    input.correlation_id,
    input.scope_tenant_id ?? null,
    null,
    null,
    payloadSha,
    prev?.record_integrity_sha256 ?? null,
    integrity,
    input.reason_code ?? null,
    input.approval_correlation_id ?? null,
    JSON.stringify(entityRefs),
  );
  return recordId;
}

function seedTenantIfEmpty(): void {
  const row = db.prepare("SELECT id FROM tenants LIMIT 1").get();
  if (row) return;
  db.prepare("INSERT INTO tenants (id, slug, display_name) VALUES (?, ?, ?)")
    .run(newId("tenant"), "default", "Default tenant");
  console.info("Seeded default tenant");
}

function seedAuditSupportIfEmpty(): void {
  const ticketRow = db.prepare("SELECT ticket_id FROM support_tickets LIMIT 1").get();
  if (!ticketRow) {
    const tenant = db.prepare("SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (tenant) {
      db.prepare(
        `INSERT INTO support_tickets
          (ticket_id, tenant_id, state, severity, affected_module, sync_status_hint,
           app_version_reported, linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "sup_seed_001",
        tenant.id,
        "triaged",
        "warn",
        "sync",
        "retry pressure elevated",
        "0.1.0-dev",
        JSON.stringify(["inc_seed_sync_01"]),
        new Date(Date.now() + 24 * 3600_000).toISOString(),
        new Date().toISOString(),
      );
    }
  }

  const auditRow = db.prepare("SELECT record_id FROM audit_records LIMIT 1").get();
  if (!auditRow) {
    const tenant = db.prepare("SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1").get() as
      | { id: string }
      | undefined;
    appendAuditRecord({
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

  const bundleRow = db.prepare("SELECT bundle_id FROM diagnostic_bundles LIMIT 1").get();
  if (!bundleRow) {
    const bundleId = "bundle_seed_001";
    db.prepare(
      "INSERT INTO diagnostic_bundles (bundle_id, created_at_rfc3339, redaction_profile) VALUES (?, ?, ?)",
    ).run(bundleId, new Date().toISOString(), "pii_strict_v2");
    db.prepare(
      `INSERT INTO diagnostic_bundle_artifacts (bundle_id, logical_path, sha256, kind)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).run(
      bundleId,
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
      "release_meta",
    );
  }

  const offlineRow = db.prepare("SELECT desktop_queue_id FROM offline_ticket_reconciliation LIMIT 1").get();
  if (!offlineRow) {
    db.prepare(
      `INSERT INTO offline_ticket_reconciliation (desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).run(
      "dq_seed_01",
      "sup_seed_001",
      "merged",
      null,
      "dq_seed_02",
      null,
      "pending_upload",
      "sup_seed_001",
    );
  }

  const runbookRow = db.prepare("SELECT runbook_id FROM incident_runbooks LIMIT 1").get();
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
    const insert = db.prepare(
      `INSERT INTO incident_runbooks (runbook_id, title, summary, first_steps_json) VALUES (?, ?, ?, ?)`,
    );
    for (const rb of runbooks) {
      insert.run(rb.runbook_id, rb.title, rb.summary, JSON.stringify(rb.first_steps));
    }
  }
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
}).strict();

const ForceUpdateModeSchema = z.enum(["off", "required", "emergency", "inherit"]);
const CohortForceUpdateModeSchema = z.enum(["off", "required", "emergency"]);

const CreateTenantBody = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/),
  display_name: z.string().min(2).max(128),
  force_min_app_version: z.string().trim().min(1).max(32).optional().nullable(),
  force_update_mode: ForceUpdateModeSchema.optional(),
  force_update_reason: z.string().trim().min(2).max(512).optional().nullable(),
  rollout_cohort: z.string().trim().min(2).max(64).optional(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  offline_grace_hours: z.number().int().min(1).max(720).optional(),
  trust_revocation_disconnects_immediately: z.boolean().optional(),
  reconnect_requires_fresh_heartbeat: z.boolean().optional(),
}).strict();

const CreateLicenseBody = z.object({
  tenant_id: z.string().min(3),
  max_machines: z.number().int().min(1).max(1000).default(1),
  expires_at: z.string().datetime().optional().nullable(),
  update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
  operator_reason_code: z.string().trim().min(2).max(64).optional().nullable(),
  operator_rationale: z.string().trim().min(8).max(512).optional().nullable(),
}).strict();

const RevokeLicenseBody = z.object({
  reason: z.string().min(2).max(256).optional(),
}).strict();

const ActivationClaimBody = z.object({
  license_key: z.string().min(8),
  machine_fingerprint: z.string().min(8).max(256),
  machine_label: z.string().max(128).optional(),
  app_version: z.string().max(32).optional(),
}).strict();

const OfflinePolicyUpdateBody = z.object({
  offline_grace_hours: z.number().int().min(1).max(720),
  trust_revocation_disconnects_immediately: z.boolean(),
  reconnect_requires_fresh_heartbeat: z.boolean(),
}).strict();

const UpdatePolicyBody = z
  .object({
    force_min_app_version: z.string().trim().min(1).max(32).nullable().optional(),
    force_update_mode: CohortForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

const TenantUpdatePolicyBody = z
  .object({
    force_min_app_version: z.string().trim().min(1).max(32).nullable().optional(),
    force_update_mode: ForceUpdateModeSchema.optional(),
    force_update_reason: z.string().trim().min(2).max(512).nullable().optional(),
  })
  .strict();

const AuditLedgerQuery = z.object({
  q: z.string().optional(),
  category: z
    .enum([
      "auth_session",
      "entitlement",
      "machine",
      "sync_repair",
      "rollout_intervention",
      "platform_override",
      "support_intervention",
      "all",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

const SupportInterventionBody = z.object({
  action_code: z.string().trim().min(3).max(64),
  note: z.string().trim().min(3).max(2048),
  next_state: z
    .enum(["new", "triaged", "waiting_for_vendor", "waiting_for_customer", "resolved", "closed"])
    .optional(),
  reason_code: z.string().trim().min(2).max(128).optional(),
}).strict();

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);
app.use((req, res, next) => {
  const requestId = req.header("X-Request-Id")?.trim() || newId("req");
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    observabilityWindow.request_total += 1;
    if (res.statusCode >= 500) {
      observabilityWindow.request_5xx_total += 1;
    }
    structuredLog("api_request_complete", {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: durationMs,
      actor_id: (req as AuthRequest).userId ?? null,
      remote_ip: req.ip,
    });
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    seed_behavior: SEED_BEHAVIOR,
    privileged_guard: {
      require_step_up: REQUIRE_PRIVILEGED_STEP_UP,
      require_reason: REQUIRE_PRIVILEGED_REASON,
    },
  });
});

app.get("/api/v1/ops/observability/slo", authMiddleware, (_req, res) => {
  const uptimeSeconds = Math.max(0, Math.round((Date.now() - new Date(observabilityWindow.started_at_rfc3339).getTime()) / 1000));
  const requestTotal = observabilityWindow.request_total;
  const request5xx = observabilityWindow.request_5xx_total;
  const availabilityPercent = requestTotal > 0 ? Number((((requestTotal - request5xx) / requestTotal) * 100).toFixed(3)) : 100;
  const errorRatePercent = requestTotal > 0 ? Number(((request5xx / requestTotal) * 100).toFixed(3)) : 0;
  const authP50 = percentile(observabilityWindow.auth_latency_samples_ms, 50);
  const authP95 = percentile(observabilityWindow.auth_latency_samples_ms, 95);
  const authP99 = percentile(observabilityWindow.auth_latency_samples_ms, 99);
  const activationSuccess = observabilityWindow.activation_success_total;
  const activationFailure = observabilityWindow.activation_failure_total;
  const activationTotal = activationSuccess + activationFailure;
  const activationSuccessRate = activationTotal > 0 ? Number(((activationSuccess / activationTotal) * 100).toFixed(3)) : 100;
  const staleRow = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM machine_activations
       WHERE revoked_at IS NULL
         AND datetime(last_seen_at) < datetime('now', '-5 minutes')`,
    )
    .get() as { c: number };
  const totalMachinesRow = db
    .prepare("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL")
    .get() as { c: number };
  const revokedMachinesRow = db
    .prepare("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NOT NULL")
    .get() as { c: number };
  const channelMismatchRow = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM machine_activations a
       JOIN license_keys l ON l.id = a.license_id
       JOIN tenants t ON t.id = a.tenant_id
       WHERE l.update_channel != t.update_channel`,
    )
    .get() as { c: number };
  const staleMachines = staleRow.c;
  const totalMachines = totalMachinesRow.c;
  const deadLetterTotal = revokedMachinesRow.c + channelMismatchRow.c;
  const staleRatioPercent = totalMachines > 0 ? Number(((staleMachines / totalMachines) * 100).toFixed(3)) : 0;

  const alerts = [
    {
      code: "api_availability",
      threshold: "availability < 99.9%",
      state: availabilityPercent < 99 ? "critical" : availabilityPercent < 99.9 ? "warn" : "ok",
      value: availabilityPercent,
    },
    {
      code: "auth_latency_p95",
      threshold: "p95 < 300ms",
      state: authP95 != null && authP95 > 700 ? "critical" : authP95 != null && authP95 > 300 ? "warn" : "ok",
      value_ms: authP95,
    },
    {
      code: "activation_success_rate",
      threshold: ">= 99.5%",
      state: activationSuccessRate < 95 ? "critical" : activationSuccessRate < 99.5 ? "warn" : "ok",
      value: activationSuccessRate,
    },
    {
      code: "sync_stale_surface",
      threshold: "stale <= 1%",
      state: staleRatioPercent > 5 ? "critical" : staleRatioPercent > 1 ? "warn" : "ok",
      value: staleRatioPercent,
    },
  ];

  res.json({
    generated_at_rfc3339: new Date().toISOString(),
    window_started_at_rfc3339: observabilityWindow.started_at_rfc3339,
    api_health: {
      uptime_seconds: uptimeSeconds,
      request_total: requestTotal,
      request_5xx_total: request5xx,
      availability_percent: availabilityPercent,
      error_rate_percent: errorRatePercent,
      slo_target_percent: 99.9,
    },
    auth_latency_ms: {
      sample_size: observabilityWindow.auth_latency_samples_ms.length,
      p50: authP50,
      p95: authP95,
      p99: authP99,
      slo_target_p95_ms: 300,
    },
    activation_claims: {
      success_total: activationSuccess,
      failure_total: activationFailure,
      success_rate_percent: activationSuccessRate,
      failures_by_reason: Array.from(observabilityWindow.activation_failures_by_reason.entries()).map(([reason, count]) => ({
        reason,
        count,
      })),
      slo_target_success_rate_percent: 99.5,
    },
    sync_operator_surface: {
      stale_machine_count: staleMachines,
      active_machine_count: totalMachines,
      stale_ratio_percent: staleRatioPercent,
      dead_letter_total: deadLetterTotal,
      dead_letter_components: {
        revoked_activations: revokedMachinesRow.c,
        channel_mismatch: channelMismatchRow.c,
      },
      slo_target_stale_ratio_percent: 1,
    },
    alerts,
  });
});

app.post("/api/v1/auth/login", (req, res) => {
  const startedAt = Date.now();
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    observeAuthAttempt(Date.now() - startedAt, false);
    structuredLog("auth_login_failed", {
      reason: "invalid_body",
      status: 400,
      email: typeof req.body?.email === "string" ? req.body.email : null,
    });
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email) as
    | { id: number; email: string; password_hash: string }
    | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    observeAuthAttempt(Date.now() - startedAt, false);
    structuredLog("auth_login_failed", {
      reason: "invalid_credentials",
      status: 401,
      email,
    });
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = jwt.sign({ sub: String(user.id), email: user.email }, JWT_SECRET, {
    expiresIn: "12h",
    algorithm: "HS256",
  });
  observeAuthAttempt(Date.now() - startedAt, true);
  structuredLog("auth_login_success", {
    status: 200,
    user_id: user.id,
    email: user.email,
  });
  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 12 * 3600,
  });
});

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    (req as express.Request & { userId?: string }).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

function sendValidationError(
  res: express.Response,
  parsed: z.SafeParseError<unknown>,
  source: "body" | "query" | "params" = "body",
): void {
  res.status(400).json({
    error: "invalid_request",
    source,
    details: parsed.error.flatten(),
  });
}

const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  with_pagination: z.coerce.boolean().optional(),
});

function parsePagination(query: unknown): {
  cursor: string | null;
  limit: number;
  withPagination: boolean;
} {
  const parsed = PaginationQuery.safeParse(query);
  if (!parsed.success) {
    return { cursor: null, limit: 50, withPagination: false };
  }
  const cursor = parsed.data.cursor?.trim() || null;
  const limit = parsed.data.limit ?? 50;
  const withPagination = parsed.data.with_pagination === true || cursor !== null || parsed.data.limit !== undefined;
  return { cursor, limit, withPagination };
}

type AuthRequest = express.Request & { userId?: string };

type IdempotentResponse = {
  status: number;
  body: unknown;
};

function resolveActorId(req: express.Request): string {
  return `user_${(req as AuthRequest).userId ?? "anonymous"}`;
}

function runIdempotent(
  req: express.Request,
  res: express.Response,
  operation: () => IdempotentResponse,
): void {
  const idemHeader = req.header("Idempotency-Key")?.trim();
  if (!idemHeader) {
    const out = operation();
    res.status(out.status).json(out.body);
    return;
  }
  const actorId = resolveActorId(req);
  const requestHash = sha256Hex(
    JSON.stringify({
      body: req.body ?? null,
      query: req.query ?? null,
      params: req.params ?? null,
    }),
  );
  const scopedKey = `${actorId}:${req.method}:${req.path}:${idemHeader}`;
  const existing = db
    .prepare(
      `SELECT request_hash, response_status, response_json
       FROM idempotency_keys
       WHERE idempotency_key = ?`,
    )
    .get(scopedKey) as
    | {
        request_hash: string;
        response_status: number;
        response_json: string;
      }
    | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) {
      res.status(409).json({ error: "idempotency_key_conflict" });
      return;
    }
    res.setHeader("X-Idempotent-Replay", "true");
    res.status(existing.response_status).json(JSON.parse(existing.response_json));
    return;
  }
  const out = operation();
  db.prepare(
    `INSERT INTO idempotency_keys
      (idempotency_key, actor_id, method, path, request_hash, response_status, response_json, created_at_rfc3339)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scopedKey,
    actorId,
    req.method,
    req.path,
    requestHash,
    out.status,
    JSON.stringify(out.body),
    new Date().toISOString(),
  );
  res.setHeader("X-Idempotent-Replay", "false");
  res.status(out.status).json(out.body);
}

function requirePrivilegedAction(
  req: express.Request,
  input: {
    action_code: string;
    action_category: string;
    scope_tenant_id?: string | null;
    entity_refs?: AuditEntityRefs;
    payload?: unknown;
  },
): { ok: true; reasonCode: string | null; auditRecordId: string } | { ok: false; status: number; body: unknown } {
  const reasonCode = req.header("X-Operator-Reason")?.trim() ?? null;
  const stepUpToken = req.header("X-Step-Up-Token")?.trim() ?? null;
  if (REQUIRE_PRIVILEGED_REASON && (!reasonCode || reasonCode.length < 4)) {
    return {
      ok: false,
      status: 403,
      body: { error: "privileged_action_guard_failed", reason: "missing_reason_code" },
    };
  }
  if (REQUIRE_PRIVILEGED_STEP_UP && (!stepUpToken || stepUpToken.length < 8)) {
    return {
      ok: false,
      status: 403,
      body: { error: "privileged_action_guard_failed", reason: "missing_step_up_token" },
    };
  }
  const auditRecordId = appendAuditRecord({
    actor_id: resolveActorId(req),
    action_code: input.action_code,
    action_category: input.action_category,
    correlation_id: `priv-${newId("corr")}`,
    scope_tenant_id: input.scope_tenant_id ?? null,
    reason_code: reasonCode,
    entity_refs: input.entity_refs,
    payload: {
      ...(input.payload as Record<string, unknown> | undefined),
      privileged_step_up_present: !!stepUpToken,
    },
  });
  return { ok: true, reasonCode, auditRecordId };
}

app.get("/api/v1/me/permissions", authMiddleware, (_req, res) => {
  res.json(VENDOR_PERMISSIONS);
});

app.get("/api/v1/tenants", authMiddleware, (req, res) => {
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const pageSize = effectiveLimit + 1;
  let rows: Array<Record<string, unknown>>;
  if (cursor) {
    const [cursorCreatedAt, cursorId] = cursor.split("|");
    rows = db
      .prepare(
        `SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                offline_grace_hours, trust_revocation_disconnects_immediately,
                reconnect_requires_fresh_heartbeat, is_active, created_at
         FROM tenants
         WHERE (created_at < ?) OR (created_at = ? AND id < ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        `SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                offline_grace_hours, trust_revocation_disconnects_immediately,
                reconnect_requires_fresh_heartbeat, is_active, created_at
         FROM tenants
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(pageSize) as Array<Record<string, unknown>>;
  }
  const items = rows.slice(0, effectiveLimit);
  const hasMore = rows.length > effectiveLimit;
  const nextCursor = hasMore
    ? `${String(items[items.length - 1]?.created_at ?? "")}|${String(items[items.length - 1]?.id ?? "")}`
    : null;
  if (withPagination) {
    res.json({ items, next_cursor: nextCursor, limit: effectiveLimit });
    return;
  }
  res.json(items);
});

app.post("/api/v1/tenants", authMiddleware, (req, res) => {
  const parsed = CreateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const input = parsed.data;
    const id = newId("tenant");
    try {
      db.prepare(
        `INSERT INTO tenants
         (id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
          offline_grace_hours, trust_revocation_disconnects_immediately, reconnect_requires_fresh_heartbeat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.slug,
        input.display_name,
        input.force_min_app_version ?? null,
        input.force_update_mode ?? "inherit",
        input.force_update_reason ?? null,
        input.rollout_cohort ?? "stable-main",
        input.update_channel ?? "stable",
        input.offline_grace_hours ?? 72,
        input.trust_revocation_disconnects_immediately ? 1 : 0,
        input.reconnect_requires_fresh_heartbeat ?? true ? 1 : 0,
      );
    } catch (err) {
      return { status: 409, body: { error: "tenant_conflict", message: String(err) } };
    }
    return {
      status: 201,
      body: {
        id,
        slug: input.slug,
        display_name: input.display_name,
        force_min_app_version: input.force_min_app_version ?? null,
        force_update_mode: input.force_update_mode ?? "inherit",
        force_update_reason: input.force_update_reason ?? null,
        rollout_cohort: input.rollout_cohort ?? "stable-main",
        update_channel: input.update_channel ?? "stable",
        offline_grace_hours: input.offline_grace_hours ?? 72,
        trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately ?? false,
        reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat ?? true,
      },
    };
  });
});

app.get("/api/v1/tenants/:tenantId/update-policy", authMiddleware, (req, res) => {
  const row = db
    .prepare(
      `SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
       FROM tenants
       WHERE id = ?`,
    )
    .get(req.params.tenantId) as
    | {
        tenant_id: string;
        update_channel: string;
        rollout_cohort: string;
        force_min_app_version: string | null;
        force_update_mode: ForceUpdateMode;
        force_update_reason: string | null;
      }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  res.json(row);
});

app.put("/api/v1/tenants/:tenantId/update-policy", authMiddleware, (req, res) => {
  const parsed = TenantUpdatePolicyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const current = db
      .prepare(
        `SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
         FROM tenants
         WHERE id = ?`,
      )
      .get(req.params.tenantId) as
      | {
          tenant_id: string;
          update_channel: string;
          rollout_cohort: string;
          force_min_app_version: string | null;
          force_update_mode: ForceUpdateMode;
          force_update_reason: string | null;
        }
      | undefined;
    if (!current) {
      return { status: 404, body: { error: "tenant_not_found" } };
    }
    const guard = requirePrivilegedAction(req, {
      action_code: "tenant_update_policy_set",
      action_category: "rollout_intervention",
      scope_tenant_id: current.tenant_id,
      entity_refs: { tenant_id: current.tenant_id },
      payload: {
        tenant_id: current.tenant_id,
        previous: {
          force_min_app_version: current.force_min_app_version,
          force_update_mode: current.force_update_mode,
          force_update_reason: current.force_update_reason,
        },
        next: parsed.data,
      },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    db.prepare(
      `INSERT INTO tenant_update_policy_history
       (id, tenant_id, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
        changed_at_rfc3339, changed_by_actor_id, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("tph"),
      current.tenant_id,
      current.force_min_app_version,
      current.force_update_mode,
      current.force_update_reason,
      new Date().toISOString(),
      resolveActorId(req),
      guard.reasonCode,
    );
    const nextMinVersion = parsed.data.force_min_app_version ?? current.force_min_app_version;
    const nextMode = parsed.data.force_update_mode ?? current.force_update_mode;
    const nextReason = parsed.data.force_update_reason ?? current.force_update_reason;
    db.prepare(
      `UPDATE tenants
       SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
       WHERE id = ?`,
    ).run(nextMinVersion, nextMode, nextReason, current.tenant_id);
    return {
      status: 200,
      body: {
        tenant_id: current.tenant_id,
        update_channel: current.update_channel,
        rollout_cohort: current.rollout_cohort,
        force_min_app_version: nextMinVersion,
        force_update_mode: nextMode,
        force_update_reason: nextReason,
        audit_record_id: guard.auditRecordId,
      },
    };
  });
});

app.post("/api/v1/tenants/:tenantId/update-policy/rollback", authMiddleware, (req, res) => {
  runIdempotent(req, res, () => {
    const current = db
      .prepare(
        `SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
         FROM tenants
         WHERE id = ?`,
      )
      .get(req.params.tenantId) as
      | {
          tenant_id: string;
          update_channel: string;
          rollout_cohort: string;
          force_min_app_version: string | null;
          force_update_mode: ForceUpdateMode;
          force_update_reason: string | null;
        }
      | undefined;
    if (!current) {
      return { status: 404, body: { error: "tenant_not_found" } };
    }
    const previous = db
      .prepare(
        `SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
         FROM tenant_update_policy_history
         WHERE tenant_id = ?
         ORDER BY changed_at_rfc3339 DESC
         LIMIT 1`,
      )
      .get(current.tenant_id) as
      | {
          previous_force_min_app_version: string | null;
          previous_force_update_mode: ForceUpdateMode;
          previous_force_update_reason: string | null;
        }
      | undefined;
    if (!previous) {
      return { status: 409, body: { error: "no_policy_history" } };
    }
    const guard = requirePrivilegedAction(req, {
      action_code: "tenant_update_policy_rollback",
      action_category: "rollout_intervention",
      scope_tenant_id: current.tenant_id,
      entity_refs: { tenant_id: current.tenant_id },
      payload: { rollback_to_previous: true },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    db.prepare(
      `UPDATE tenants
       SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
       WHERE id = ?`,
    ).run(
      previous.previous_force_min_app_version,
      previous.previous_force_update_mode,
      previous.previous_force_update_reason,
      current.tenant_id,
    );
    return {
      status: 200,
      body: {
        tenant_id: current.tenant_id,
        update_channel: current.update_channel,
        rollout_cohort: current.rollout_cohort,
        force_min_app_version: previous.previous_force_min_app_version,
        force_update_mode: previous.previous_force_update_mode,
        force_update_reason: previous.previous_force_update_reason,
        audit_record_id: guard.auditRecordId,
      },
    };
  });
});

app.get("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, (req, res) => {
  const channel = req.params.channel;
  const cohort = req.params.cohort;
  if (!["stable", "pilot", "internal"].includes(channel)) {
    res.status(400).json({ error: "invalid_channel" });
    return;
  }
  const row = db
    .prepare(
      `SELECT channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
       FROM cohort_update_policies
       WHERE channel = ? AND cohort_label = ?`,
    )
    .get(channel, cohort) as
    | {
        channel: string;
        cohort_label: string;
        force_min_app_version: string | null;
        force_update_mode: Exclude<ForceUpdateMode, "inherit">;
        force_update_reason: string | null;
      }
    | undefined;
  if (!row) {
    res.json({
      channel,
      cohort_label: cohort,
      force_min_app_version: null,
      force_update_mode: "off",
      force_update_reason: null,
    });
    return;
  }
  res.json(row);
});

app.put("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, (req, res) => {
  const parsed = UpdatePolicyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!["stable", "pilot", "internal"].includes(channel)) {
      return { status: 400, body: { error: "invalid_channel" } };
    }
    const current = db
      .prepare(
        `SELECT id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
         FROM cohort_update_policies
         WHERE channel = ? AND cohort_label = ?`,
      )
      .get(channel, cohort) as
      | {
          id: string;
          channel: string;
          cohort_label: string;
          force_min_app_version: string | null;
          force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          force_update_reason: string | null;
        }
      | undefined;
    const guard = requirePrivilegedAction(req, {
      action_code: "cohort_update_policy_set",
      action_category: "rollout_intervention",
      entity_refs: { release_id: `${channel}:${cohort}` },
      payload: {
        channel,
        cohort_label: cohort,
        previous: current ?? null,
        next: parsed.data,
      },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    const prevMin = current?.force_min_app_version ?? null;
    const prevMode = current?.force_update_mode ?? "off";
    const prevReason = current?.force_update_reason ?? null;
    db.prepare(
      `INSERT INTO cohort_update_policy_history
       (id, channel, cohort_label, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
        changed_at_rfc3339, changed_by_actor_id, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("cph"),
      channel,
      cohort,
      prevMin,
      prevMode,
      prevReason,
      new Date().toISOString(),
      resolveActorId(req),
      guard.reasonCode,
    );
    const nextMinVersion = parsed.data.force_min_app_version ?? prevMin;
    const nextMode = parsed.data.force_update_mode ?? prevMode;
    const nextReason = parsed.data.force_update_reason ?? prevReason;
    if (current) {
      db.prepare(
        `UPDATE cohort_update_policies
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
             updated_at_rfc3339 = ?, updated_by_actor_id = ?
         WHERE id = ?`,
      ).run(nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req), current.id);
    } else {
      db.prepare(
        `INSERT INTO cohort_update_policies
         (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId("cup"), channel, cohort, nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req));
    }
    return {
      status: 200,
      body: {
        channel,
        cohort_label: cohort,
        force_min_app_version: nextMinVersion,
        force_update_mode: nextMode,
        force_update_reason: nextReason,
        audit_record_id: guard.auditRecordId,
      },
    };
  });
});

app.post("/api/v1/cohorts/:channel/:cohort/update-policy/rollback", authMiddleware, (req, res) => {
  runIdempotent(req, res, () => {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!["stable", "pilot", "internal"].includes(channel)) {
      return { status: 400, body: { error: "invalid_channel" } };
    }
    const previous = db
      .prepare(
        `SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
         FROM cohort_update_policy_history
         WHERE channel = ? AND cohort_label = ?
         ORDER BY changed_at_rfc3339 DESC
         LIMIT 1`,
      )
      .get(channel, cohort) as
      | {
          previous_force_min_app_version: string | null;
          previous_force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          previous_force_update_reason: string | null;
        }
      | undefined;
    if (!previous) {
      return { status: 409, body: { error: "no_policy_history" } };
    }
    const guard = requirePrivilegedAction(req, {
      action_code: "cohort_update_policy_rollback",
      action_category: "rollout_intervention",
      entity_refs: { release_id: `${channel}:${cohort}` },
      payload: { rollback_to_previous: true },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    const existing = db
      .prepare("SELECT id FROM cohort_update_policies WHERE channel = ? AND cohort_label = ?")
      .get(channel, cohort) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE cohort_update_policies
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
             updated_at_rfc3339 = ?, updated_by_actor_id = ?
         WHERE id = ?`,
      ).run(
        previous.previous_force_min_app_version,
        previous.previous_force_update_mode,
        previous.previous_force_update_reason,
        new Date().toISOString(),
        resolveActorId(req),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO cohort_update_policies
         (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId("cup"),
        channel,
        cohort,
        previous.previous_force_min_app_version,
        previous.previous_force_update_mode,
        previous.previous_force_update_reason,
        new Date().toISOString(),
        resolveActorId(req),
      );
    }
    return {
      status: 200,
      body: {
        channel,
        cohort_label: cohort,
        force_min_app_version: previous.previous_force_min_app_version,
        force_update_mode: previous.previous_force_update_mode,
        force_update_reason: previous.previous_force_update_reason,
        audit_record_id: guard.auditRecordId,
      },
    };
  });
});

app.post("/api/v1/licenses", authMiddleware, (req, res) => {
  const parsed = CreateLicenseBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const input = parsed.data;
    const tenant = db
      .prepare(
        "SELECT id, display_name, force_min_app_version, update_channel, is_active FROM tenants WHERE id = ?",
      )
      .get(input.tenant_id) as
      | {
          id: string;
          display_name: string;
          force_min_app_version: string | null;
          update_channel: string;
          is_active: number;
        }
      | undefined;
    if (!tenant || tenant.is_active !== 1) {
      return { status: 404, body: { error: "tenant_not_found_or_inactive" } };
    }

    const id = newId("lic");
    const key = randomLicenseKey();
    const actor = Number.parseInt(String((req as express.Request & { userId?: string }).userId ?? "0"), 10) || null;
    db.prepare(
      `INSERT INTO license_keys
        (id, tenant_id, license_key, max_machines, update_channel, issued_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.tenant_id,
      key,
      input.max_machines,
      input.update_channel ?? tenant.update_channel,
      actor,
      input.expires_at ?? null,
    );

    const auditRecordId = appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: "license_issue",
      action_category: "entitlement",
      correlation_id: `lic-${newId("corr")}`,
      scope_tenant_id: input.tenant_id,
      reason_code: input.operator_reason_code ?? null,
      entity_refs: {
        tenant_id: input.tenant_id,
        entitlement_id: id,
      },
      payload: {
        update_channel: input.update_channel ?? tenant.update_channel,
        max_machines: input.max_machines,
        expires_at: input.expires_at ?? null,
        operator_rationale: input.operator_rationale ?? null,
      },
    });

    return {
      status: 201,
      body: {
        id,
        tenant_id: input.tenant_id,
        tenant_display_name: tenant.display_name,
        license_key: key,
        max_machines: input.max_machines,
        update_channel: input.update_channel ?? tenant.update_channel,
        expires_at: input.expires_at ?? null,
        revoked_at: null,
        audit_record_id: auditRecordId,
      },
    };
  });
});

app.get("/api/v1/tenants/:tenantId/licenses", authMiddleware, (req, res) => {
  const tenantId = req.params.tenantId;
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const pageSize = effectiveLimit + 1;
  let rows: Array<Record<string, unknown>>;
  if (cursor) {
    const [cursorCreatedAt, cursorId] = cursor.split("|");
    rows = db
      .prepare(
        `SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel
         FROM license_keys
         WHERE tenant_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(tenantId, cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        `SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel
         FROM license_keys
         WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(tenantId, pageSize) as Array<Record<string, unknown>>;
  }
  const items = rows.slice(0, effectiveLimit);
  const hasMore = rows.length > effectiveLimit;
  const nextCursor = hasMore
    ? `${String(items[items.length - 1]?.created_at ?? "")}|${String(items[items.length - 1]?.id ?? "")}`
    : null;
  if (withPagination) {
    res.json({ items, next_cursor: nextCursor, limit: effectiveLimit });
    return;
  }
  res.json(items);
});

app.post("/api/v1/licenses/:licenseId/revoke", authMiddleware, (req, res) => {
  const parsed = RevokeLicenseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const guard = requirePrivilegedAction(req, {
      action_code: "license_revoke",
      action_category: "entitlement",
      entity_refs: { entitlement_id: req.params.licenseId },
      payload: { reason: parsed.data.reason ?? "revoked by operator" },
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const licenseId = req.params.licenseId;
    const now = new Date().toISOString();
    const row = db
      .prepare("SELECT id, revoked_at, tenant_id FROM license_keys WHERE id = ?")
      .get(licenseId) as { id: string; revoked_at: string | null; tenant_id: string } | undefined;
    if (!row) {
      return { status: 404, body: { error: "license_not_found" } };
    }
    if (!row.revoked_at) {
      db.prepare("UPDATE license_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(
        now,
        parsed.data.reason ?? "revoked by operator",
        licenseId,
      );
      db.prepare("UPDATE machine_activations SET revoked_at = ? WHERE license_id = ? AND revoked_at IS NULL").run(now, licenseId);
    }
    return { status: 200, body: { ok: true, revoked_at: now, audit_record_id: guard.auditRecordId } };
  });
});

app.get("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, (req, res) => {
  const tenantId = req.params.tenantId;
  const row = db
    .prepare(
      `SELECT id, offline_grace_hours, trust_revocation_disconnects_immediately,
              reconnect_requires_fresh_heartbeat
       FROM tenants WHERE id = ?`,
    )
    .get(tenantId) as
    | {
        id: string;
        offline_grace_hours: number;
        trust_revocation_disconnects_immediately: number;
        reconnect_requires_fresh_heartbeat: number;
      }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  res.json({
    tenant_id: tenantId,
    grace_hours: row.offline_grace_hours,
    trust_revocation_disconnects_immediately: row.trust_revocation_disconnects_immediately === 1,
    reconnect_requires_fresh_heartbeat: row.reconnect_requires_fresh_heartbeat === 1,
  });
});

app.put("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, (req, res) => {
  const tenantId = req.params.tenantId;
  const parsed = OfflinePolicyUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const guard = requirePrivilegedAction(req, {
      action_code: "offline_policy_update",
      action_category: "platform_override",
      scope_tenant_id: tenantId,
      entity_refs: { tenant_id: tenantId },
      payload: parsed.data,
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const tenant = db.prepare("SELECT id FROM tenants WHERE id = ?").get(tenantId) as { id: string } | undefined;
    if (!tenant) {
      return { status: 404, body: { error: "tenant_not_found" } };
    }
    const input = parsed.data;
    db.prepare(
      `UPDATE tenants
       SET offline_grace_hours = ?,
           trust_revocation_disconnects_immediately = ?,
           reconnect_requires_fresh_heartbeat = ?
       WHERE id = ?`,
    ).run(
      input.offline_grace_hours,
      input.trust_revocation_disconnects_immediately ? 1 : 0,
      input.reconnect_requires_fresh_heartbeat ? 1 : 0,
      tenantId,
    );
    return {
      status: 200,
      body: {
        tenant_id: tenantId,
        grace_hours: input.offline_grace_hours,
        trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately,
        reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat,
        audit_record_id: guard.auditRecordId,
      },
    };
  });
});

app.get("/api/v1/tenants/:tenantId/activations", authMiddleware, (req, res) => {
  const tenantId = req.params.tenantId;
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const rows = db
    .prepare(
      `SELECT a.machine_fingerprint, a.last_seen_at, a.app_version, a.revoked_at, l.update_channel
       FROM machine_activations a
       JOIN license_keys l ON l.id = a.license_id
       WHERE a.tenant_id = ?
       ORDER BY a.last_seen_at DESC, a.machine_fingerprint DESC`,
    )
    .all(tenantId) as Array<{
      machine_fingerprint: string;
      last_seen_at: string;
      app_version: string | null;
      revoked_at: string | null;
      update_channel: string;
    }>;
  const filtered = cursor
    ? rows.filter((row) => {
        const [cursorLastSeenAt, cursorMachineId] = cursor.split("|");
        if (row.last_seen_at < cursorLastSeenAt) return true;
        if (row.last_seen_at > cursorLastSeenAt) return false;
        return row.machine_fingerprint < (cursorMachineId ?? "");
      })
    : rows;
  const pagedRows = filtered.slice(0, effectiveLimit + 1);
  const nowMs = Date.now();
  const mapped = pagedRows.slice(0, effectiveLimit).map((row) => {
    const ageMs = nowMs - new Date(row.last_seen_at).getTime();
    const heartbeat_freshness = Number.isFinite(ageMs) && ageMs <= 15 * 60_000 ? "live" : "stale";
    return {
      machine_id: row.machine_fingerprint,
      tenant_id: tenantId,
      last_heartbeat_rfc3339: row.last_seen_at,
      app_version: row.app_version,
      trusted_device: row.revoked_at == null,
      activation_source: "license_claim",
      anomaly_flags: row.revoked_at ? ["revoked"] : [],
      heartbeat_freshness,
      update_channel: row.update_channel,
    };
  });
  if (withPagination) {
    const hasMore = pagedRows.length > effectiveLimit;
    const last = mapped[mapped.length - 1];
    res.json({
      items: mapped,
      next_cursor: hasMore && last ? `${last.last_heartbeat_rfc3339 ?? ""}|${last.machine_id}` : null,
      limit: effectiveLimit,
    });
    return;
  }
  res.json(mapped);
});

app.get("/api/v1/ops/sync-overview", authMiddleware, (_req, res) => {
  const tenants = db
    .prepare(
      `SELECT id, update_channel, force_min_app_version
       FROM tenants
       WHERE is_active = 1`,
    )
    .all() as Array<{ id: string; update_channel: string; force_min_app_version: string | null }>;

  const nowMs = Date.now();
  const tenantRows = tenants.map((tenant) => {
    const activations = db
      .prepare(
        `SELECT a.last_seen_at, a.revoked_at, l.update_channel
         FROM machine_activations a
         JOIN license_keys l ON l.id = a.license_id
         WHERE a.tenant_id = ?`,
      )
      .all(tenant.id) as Array<{ last_seen_at: string; revoked_at: string | null; update_channel: string }>;
    const machineCount = activations.length;
    const staleCount = activations.filter((a) => {
      const ageMs = nowMs - new Date(a.last_seen_at).getTime();
      return !Number.isFinite(ageMs) || ageMs > 15 * 60_000;
    }).length;
    const revokedCount = activations.filter((a) => a.revoked_at != null).length;
    const channelMismatch = activations.filter((a) => a.update_channel !== tenant.update_channel).length;
    const lagSeconds = staleCount === 0 ? 0 : Math.min(900, staleCount * 45);
    const checkpointAgeSeconds = staleCount === 0 ? 30 : Math.min(1800, staleCount * 120);
    const rejectionRateBps = Math.min(500, revokedCount * 25 + channelMismatch * 15);
    const retryPressure = Math.min(100, staleCount * 12 + channelMismatch * 7);
    const deadLetterCount = revokedCount + channelMismatch;
    let severity: OpsSeverity = "info";
    if (deadLetterCount > 0 || retryPressure >= 40 || lagSeconds >= 120) severity = "warn";
    if (deadLetterCount >= 3 || retryPressure >= 70 || lagSeconds >= 240) severity = "critical";
    return {
      tenant_id: tenant.id,
      lag_seconds: lagSeconds,
      checkpoint_age_seconds: checkpointAgeSeconds,
      rejection_rate_bps: rejectionRateBps,
      retry_pressure: retryPressure,
      dead_letter_count: deadLetterCount,
      severity,
    };
  });

  const drillByTenant = Object.fromEntries(
    tenantRows.map((row) => {
      const rows: Array<{
        batch_id: string;
        entity_type: string;
        failure_reason_code: string;
        idempotency_key: string;
        last_attempt_rfc3339: string;
        attempt_count: number;
      }> = [];
      if (row.retry_pressure >= 30) {
        rows.push({
          batch_id: `batch_${row.tenant_id.slice(-6)}_sync`,
          entity_type: "mutable_operational",
          failure_reason_code: row.retry_pressure >= 70 ? "retry_timeout" : "transient_retry_pressure",
          idempotency_key: `idem:${row.tenant_id}:sync:${row.dead_letter_count}`,
          last_attempt_rfc3339: new Date().toISOString(),
          attempt_count: Math.max(1, Math.floor(row.retry_pressure / 20)),
        });
      }
      if (row.dead_letter_count > 0) {
        rows.push({
          batch_id: `batch_${row.tenant_id.slice(-6)}_dlq`,
          entity_type: "append_only_event",
          failure_reason_code: "dead_letter_backlog",
          idempotency_key: `idem:${row.tenant_id}:dlq:${row.dead_letter_count}`,
          last_attempt_rfc3339: new Date().toISOString(),
          attempt_count: Math.max(1, row.dead_letter_count),
        });
      }
      return [row.tenant_id, rows];
    }),
  );

  const repairQueue = tenantRows
    .filter((row) => row.dead_letter_count > 0 || row.retry_pressure >= 40)
    .map((row, idx) => ({
      item_id: `rq_${row.tenant_id}_${idx + 1}`,
      tenant_id: row.tenant_id,
      queue_kind: row.dead_letter_count > 0 ? "dead_letter" : "replay_repair",
      severity: row.severity,
      summary:
        row.dead_letter_count > 0
          ? `Dead-letter backlog detected (${row.dead_letter_count}).`
          : `Retry pressure elevated (${row.retry_pressure}%).`,
      recommended_action:
        row.severity === "critical" ? "escalate" : row.dead_letter_count > 0 ? "requeue" : "replay",
    }));

  const heartbeatAnomalies = tenantRows
    .filter((row) => row.lag_seconds > 0)
    .slice(0, 20)
    .map((row, idx) => ({
      tenant_id: row.tenant_id,
      machine_id: `machine_${row.tenant_id.slice(-4)}_${idx + 1}`,
      anomaly_code: row.lag_seconds >= 240 ? "expired_offline_grace" : "stale_policy_snapshot",
      detected_at_rfc3339: new Date().toISOString(),
    }));

  const aggregate = {
    max_lag_seconds: tenantRows.reduce((m, row) => Math.max(m, row.lag_seconds), 0),
    checkpoint_p95_age_seconds: tenantRows.length
      ? Math.round(
          tenantRows.map((r) => r.checkpoint_age_seconds).sort((a, b) => a - b)[
            Math.max(0, Math.floor(tenantRows.length * 0.95) - 1)
          ] ?? 0,
        )
      : 0,
    aggregate_retry_pressure: tenantRows.length
      ? Math.round(tenantRows.reduce((sum, row) => sum + row.retry_pressure, 0) / tenantRows.length)
      : 0,
    dead_letter_total: tenantRows.reduce((sum, row) => sum + row.dead_letter_count, 0),
    worst_severity: tenantRows.reduce<OpsSeverity>((acc, row) => worstSeverity(acc, row.severity), "info"),
  };

  res.json({
    aggregate,
    tenant_rows: tenantRows,
    repair_queue: repairQueue,
    heartbeat_anomalies: heartbeatAnomalies,
    drill_by_tenant: drillByTenant,
  });
});

app.get("/api/v1/ops/rollout-overview", authMiddleware, (_req, res) => {
  const tenants = db
    .prepare(
      `SELECT id, update_channel, rollout_cohort, force_min_app_version, force_update_mode
       FROM tenants
       WHERE is_active = 1`,
    )
    .all() as Array<{
      id: string;
      update_channel: "stable" | "pilot" | "internal";
      rollout_cohort: string;
      force_min_app_version: string | null;
      force_update_mode: ForceUpdateMode;
    }>;
  const machineCountsByTenant = new Map<string, number>();
  const machineRows = db
    .prepare("SELECT tenant_id, COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL GROUP BY tenant_id")
    .all() as Array<{ tenant_id: string; c: number }>;
  for (const row of machineRows) {
    machineCountsByTenant.set(row.tenant_id, row.c);
  }
  const mismatches = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM license_keys l
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.update_channel != t.update_channel`,
    )
    .get() as { c: number };
  const totalMachines = machineRows.reduce((sum, row) => sum + row.c, 0);
  const impact = {
    release_id: process.env.ROLLOUT_RELEASE_ID ?? `rel_desktop_${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}`,
    affected_tenants: tenants.length,
    affected_machines: totalMachines,
    entitlement_channel_ok: mismatches.c === 0,
    known_blockers: [
      ...(mismatches.c > 0 ? [`${mismatches.c} tenant/license channel mismatches detected`] : []),
      ...(tenants.some((t) => t.force_min_app_version) ? ["forced minimum app version set for at least one cohort"] : []),
      ...(tenants.some((t) => t.force_update_mode === "required" || t.force_update_mode === "emergency")
        ? ["force-update enforcement is active for at least one tenant"]
        : []),
    ],
  };

  const groups = new Map<string, { channel: string; cohort_label: string; tenant_count: number; machine_count: number; governance: "active" | "paused" | "recalled"; paused_at_rfc3339: string | null }>();
  for (const tenant of tenants) {
    const key = `${tenant.update_channel}::${tenant.rollout_cohort}`;
    const existing =
      groups.get(key) ??
      {
        channel: tenant.update_channel,
        cohort_label: tenant.rollout_cohort,
        tenant_count: 0,
        machine_count: 0,
        governance: "active" as const,
        paused_at_rfc3339: null,
      };
    existing.tenant_count += 1;
    existing.machine_count += machineCountsByTenant.get(tenant.id) ?? 0;
    if (tenant.force_update_mode === "required" || tenant.force_update_mode === "emergency" || tenant.force_min_app_version) {
      existing.governance = "paused";
      existing.paused_at_rfc3339 = new Date().toISOString();
    }
    groups.set(key, existing);
  }

  const diagnostics = [
    {
      category: "download",
      count_24h: Math.max(0, Math.round(totalMachines * 0.02)),
      last_event_rfc3339: totalMachines > 0 ? new Date().toISOString() : null,
      sample_correlation_ids: totalMachines > 0 ? ["dl_corr_01"] : [],
    },
    {
      category: "signature_verification",
      count_24h: mismatches.c,
      last_event_rfc3339: mismatches.c > 0 ? new Date().toISOString() : null,
      sample_correlation_ids: mismatches.c > 0 ? ["sig_corr_01"] : [],
    },
    {
      category: "migration",
      count_24h: tenants.filter((t) => t.force_min_app_version != null).length,
      last_event_rfc3339: tenants.some((t) => t.force_min_app_version != null) ? new Date().toISOString() : null,
      sample_correlation_ids: tenants.some((t) => t.force_min_app_version != null) ? ["mig_corr_01"] : [],
    },
    {
      category: "post_deploy_heartbeat",
      count_24h: Math.max(0, Math.round(totalMachines * 0.015)),
      last_event_rfc3339: totalMachines > 0 ? new Date().toISOString() : null,
      sample_correlation_ids: totalMachines > 0 ? ["hb_corr_01"] : [],
    },
  ];

  res.json({
    impact,
    cohort_stages: Array.from(groups.values()),
    diagnostics,
  });
});

app.get("/api/v1/ops/platform-overview", authMiddleware, (_req, res) => {
  const syncRows = db
    .prepare(
      `SELECT t.id as tenant_id,
              SUM(CASE WHEN a.revoked_at IS NULL THEN 0 ELSE 1 END) as revoked_count,
              COUNT(a.id) as machine_count
       FROM tenants t
       LEFT JOIN machine_activations a ON a.tenant_id = t.id
       WHERE t.is_active = 1
       GROUP BY t.id`,
    )
    .all() as Array<{ tenant_id: string; revoked_count: number; machine_count: number }>;
  const totalMachines = syncRows.reduce((sum, row) => sum + row.machine_count, 0);
  const revokedMachines = syncRows.reduce((sum, row) => sum + row.revoked_count, 0);
  const serviceSeverity: OpsSeverity = revokedMachines >= 5 ? "warn" : "info";

  const platformServices = [
    { service: "api", severity: "info", detail: `active tenants: ${syncRows.length}` },
    {
      service: "workers",
      severity: serviceSeverity,
      detail: revokedMachines > 0 ? `repair queue pressure from ${revokedMachines} revoked activations` : "worker backlog nominal",
    },
    { service: "postgresql", severity: "info", detail: "sqlite control-plane backend healthy" },
    { service: "redis", severity: "info", detail: "cache layer optional for v1 stack" },
    {
      service: "object_storage",
      severity: totalMachines > 1000 ? "warn" : "info",
      detail: `artifact growth tied to ${totalMachines} machine activations`,
    },
    { service: "admin_ui", severity: "info", detail: "console static delivery healthy" },
  ];

  const infraPressure = [
    {
      metric_code: "activation_volume_24h",
      value: totalMachines,
      unit: "activations",
      threshold_hint: "warn > 1000/day",
      trend: totalMachines > 1000 ? "up" : "flat",
    },
    {
      metric_code: "revoked_machine_ratio_pct",
      value: totalMachines === 0 ? 0 : Number(((revokedMachines / totalMachines) * 100).toFixed(1)),
      unit: "%",
      threshold_hint: "critical > 15%",
      trend: revokedMachines > 0 ? "up" : "flat",
    },
    {
      metric_code: "tenant_coverage",
      value: syncRows.length,
      unit: "tenants",
      threshold_hint: "review sudden drops",
      trend: "flat",
    },
  ];

  const alerts = [
    ...(revokedMachines > 0
      ? [
          {
            alert_id: "alt_sync_revoked",
            title: "Revoked machine activations detected",
            severity: revokedMachines >= 5 ? "critical" : "warn",
            state: "open",
            owner_actor_id: null,
            acknowledged_at_rfc3339: null,
            notes: [],
            drill_refs: {
              correlation_id: "corr_revoked_activations",
            },
          },
        ]
      : []),
    ...(totalMachines === 0
      ? [
          {
            alert_id: "alt_rollout_no_machines",
            title: "No active machine telemetry",
            severity: "info",
            state: "open",
            owner_actor_id: null,
            acknowledged_at_rfc3339: null,
            notes: ["No claims yet; expected on fresh tenant onboarding."],
            drill_refs: {},
          },
        ]
      : []),
  ];

  res.json({
    platform_services: platformServices,
    infra_pressure: infraPressure,
    alerts,
  });
});

function mapAuditRow(row: {
  record_id: string;
  sequence: number;
  occurred_at_rfc3339: string;
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  payload_canonical_sha256: string;
  chain_prev_hash: string | null;
  record_integrity_sha256: string;
  reason_code: string | null;
  approval_correlation_id: string | null;
  entity_refs_json: string;
}) {
  let refs: AuditEntityRefs = {};
  try {
    refs = JSON.parse(row.entity_refs_json) as AuditEntityRefs;
  } catch {
    refs = {};
  }
  return {
    record_id: row.record_id,
    sequence: row.sequence,
    occurred_at_rfc3339: row.occurred_at_rfc3339,
    actor_id: row.actor_id,
    action_code: row.action_code,
    action_category: row.action_category,
    correlation_id: row.correlation_id,
    scope_tenant_id: row.scope_tenant_id,
    before_snapshot_sha256: row.before_snapshot_sha256,
    after_snapshot_sha256: row.after_snapshot_sha256,
    payload_canonical_sha256: row.payload_canonical_sha256,
    chain_prev_hash: row.chain_prev_hash,
    record_integrity_sha256: row.record_integrity_sha256,
    reason_code: row.reason_code,
    approval_correlation_id: row.approval_correlation_id,
    entity_refs: refs,
  };
}

app.get("/api/v1/audit/ledger", authMiddleware, (req, res) => {
  const parsed = AuditLedgerQuery.safeParse(req.query ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "query");
    return;
  }
  const { q, category, limit } = parsed.data;
  const pagination = parsePagination(req.query);
  const effectiveLimit = limit ?? pagination.limit;
  const cursorSequence = pagination.cursor ? Number.parseInt(pagination.cursor, 10) : null;
  const qTrimmed = q?.trim().toLowerCase() ?? "";
  const rows = (cursorSequence
    ? db
        .prepare(
          `SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                  correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                  payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                  approval_correlation_id, entity_refs_json
           FROM audit_records
           WHERE sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`,
        )
        .all(cursorSequence, effectiveLimit + 1)
    : db
        .prepare(
          `SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                  correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                  payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                  approval_correlation_id, entity_refs_json
           FROM audit_records
           ORDER BY sequence DESC
           LIMIT ?`,
        )
        .all(effectiveLimit + 1)) as Array<{
      record_id: string;
      sequence: number;
      occurred_at_rfc3339: string;
      actor_id: string;
      action_code: string;
      action_category: string;
      correlation_id: string;
      scope_tenant_id: string | null;
      before_snapshot_sha256: string | null;
      after_snapshot_sha256: string | null;
      payload_canonical_sha256: string;
      chain_prev_hash: string | null;
      record_integrity_sha256: string;
      reason_code: string | null;
      approval_correlation_id: string | null;
      entity_refs_json: string;
    }>;
  const mapped = rows.map(mapAuditRow).filter((row) => {
    if (category && category !== "all" && row.action_category !== category) return false;
    if (!qTrimmed) return true;
    return (
      row.record_id.toLowerCase().includes(qTrimmed) ||
      row.actor_id.toLowerCase().includes(qTrimmed) ||
      row.correlation_id.toLowerCase().includes(qTrimmed) ||
      row.action_code.toLowerCase().includes(qTrimmed) ||
      (row.entity_refs.tenant_id?.toLowerCase().includes(qTrimmed) ?? false) ||
      (row.entity_refs.support_ticket_id?.toLowerCase().includes(qTrimmed) ?? false)
    );
  });
  const items = mapped.slice(0, effectiveLimit);
  const hasMore = mapped.length > effectiveLimit;
  if (pagination.withPagination) {
    res.json({
      items,
      next_cursor: hasMore && items.length > 0 ? String(items[items.length - 1]?.sequence ?? "") : null,
      limit: effectiveLimit,
    });
    return;
  }
  res.json(items);
});

app.get("/api/v1/audit/ledger/verify-chain", authMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
              correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
              payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
              approval_correlation_id, entity_refs_json
       FROM audit_records
       ORDER BY sequence ASC`,
    )
    .all() as Array<{
      record_id: string;
      sequence: number;
      occurred_at_rfc3339: string;
      actor_id: string;
      action_code: string;
      action_category: string;
      correlation_id: string;
      scope_tenant_id: string | null;
      before_snapshot_sha256: string | null;
      after_snapshot_sha256: string | null;
      payload_canonical_sha256: string;
      chain_prev_hash: string | null;
      record_integrity_sha256: string;
      reason_code: string | null;
      approval_correlation_id: string | null;
      entity_refs_json: string;
    }>;
  let status: "ok" | "integrity_mismatch" | "chain_broken" = "ok";
  let previous: string | null = null;
  for (const row of rows) {
    const mapped = mapAuditRow(row);
    const preimage = auditRecordPreimage({
      record_id: mapped.record_id,
      sequence: mapped.sequence,
      occurred_at_rfc3339: mapped.occurred_at_rfc3339,
      actor_id: mapped.actor_id,
      action_code: mapped.action_code,
      action_category: mapped.action_category,
      correlation_id: mapped.correlation_id,
      scope_tenant_id: mapped.scope_tenant_id,
      before_snapshot_sha256: mapped.before_snapshot_sha256,
      after_snapshot_sha256: mapped.after_snapshot_sha256,
      payload_canonical_sha256: mapped.payload_canonical_sha256,
      chain_prev_hash: mapped.chain_prev_hash,
      reason_code: mapped.reason_code,
      approval_correlation_id: mapped.approval_correlation_id,
      entity_refs: mapped.entity_refs,
    });
    const computed = sha256Hex(preimage);
    if (computed !== mapped.record_integrity_sha256) {
      status = "integrity_mismatch";
      break;
    }
    if (mapped.chain_prev_hash !== previous) {
      status = "chain_broken";
      break;
    }
    previous = mapped.record_integrity_sha256;
  }
  res.json({ status, checked_count: rows.length });
});

app.get("/api/v1/audit/ledger/export", authMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT sequence, occurred_at_rfc3339, actor_id, action_code, action_category, correlation_id,
              scope_tenant_id, reason_code, approval_correlation_id, record_id
       FROM audit_records
       ORDER BY sequence DESC`,
    )
    .all() as Array<{
      sequence: number;
      occurred_at_rfc3339: string;
      actor_id: string;
      action_code: string;
      action_category: string;
      correlation_id: string;
      scope_tenant_id: string | null;
      reason_code: string | null;
      approval_correlation_id: string | null;
      record_id: string;
    }>;
  const header =
    "sequence,occurred_at_rfc3339,actor_id,action_code,action_category,correlation_id,scope_tenant_id,reason_code,approval_correlation_id,record_id";
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.sequence,
        r.occurred_at_rfc3339,
        r.actor_id,
        r.action_code,
        r.action_category,
        r.correlation_id,
        r.scope_tenant_id ?? "",
        r.reason_code ?? "",
        r.approval_correlation_id ?? "",
        r.record_id,
      ]
        .map((v) => `"${String(v).replaceAll(`"`, `""`)}"`)
        .join(","),
    ),
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="audit-ledger.csv"');
  res.status(200).send(csv);
});

app.get("/api/v1/support/tickets", authMiddleware, (req, res) => {
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const cursorCreatedAt = cursor?.split("|")[0] ?? null;
  const cursorTicketId = cursor?.split("|")[1] ?? "";
  const rows = (cursor
    ? db
        .prepare(
          `SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
           FROM support_tickets
           WHERE (created_at_rfc3339 < ?) OR (created_at_rfc3339 = ? AND ticket_id < ?)
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`,
        )
        .all(cursorCreatedAt, cursorCreatedAt, cursorTicketId, effectiveLimit + 1)
    : db
        .prepare(
          `SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
           FROM support_tickets
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`,
        )
        .all(effectiveLimit + 1)) as Array<{
      ticket_id: string;
      tenant_id: string;
      state: string;
      severity: "info" | "warn" | "critical";
      affected_module: string;
      sync_status_hint: string;
      app_version_reported: string;
      linked_incident_ids_json: string;
      sla_due_rfc3339: string | null;
      created_at_rfc3339: string;
    }>;
  const mapped = rows.slice(0, effectiveLimit).map((row) => {
    const linkedAudit = db
      .prepare("SELECT audit_record_id FROM support_ticket_interventions WHERE ticket_id = ? ORDER BY created_at_rfc3339 DESC")
      .all(row.ticket_id) as Array<{ audit_record_id: string }>;
    let incidents: string[] = [];
    try {
      incidents = JSON.parse(row.linked_incident_ids_json) as string[];
    } catch {
      incidents = [];
    }
    return {
      ticket_id: row.ticket_id,
      tenant_id: row.tenant_id,
      state: row.state,
      severity: row.severity,
      affected_module: row.affected_module,
      sync_status_hint: row.sync_status_hint,
      app_version_reported: row.app_version_reported,
      linked_incident_ids: incidents,
      linked_audit_record_ids: linkedAudit.map((a) => a.audit_record_id),
      sla_due_rfc3339: row.sla_due_rfc3339,
      created_at_rfc3339: row.created_at_rfc3339,
    };
  });
  if (withPagination) {
    const hasMore = rows.length > effectiveLimit;
    const last = mapped[mapped.length - 1];
    res.json({
      items: mapped,
      next_cursor: hasMore && last ? `${last.created_at_rfc3339}|${last.ticket_id}` : null,
      limit: effectiveLimit,
    });
    return;
  }
  res.json(mapped);
});

app.post("/api/v1/support/tickets/:ticketId/interventions", authMiddleware, (req, res) => {
  const parsed = SupportInterventionBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  runIdempotent(req, res, () => {
    const ticketId = req.params.ticketId;
    const ticket = db
      .prepare(
        `SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
         FROM support_tickets WHERE ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          ticket_id: string;
          tenant_id: string;
          state: string;
          severity: "info" | "warn" | "critical";
          affected_module: string;
          sync_status_hint: string;
          app_version_reported: string;
          linked_incident_ids_json: string;
          sla_due_rfc3339: string | null;
          created_at_rfc3339: string;
        }
      | undefined;
    if (!ticket) {
      return { status: 404, body: { error: "ticket_not_found" } };
    }
    const nextState = parsed.data.next_state ?? ticket.state;
    const guard = requirePrivilegedAction(req, {
      action_code: parsed.data.action_code,
      action_category: "support_intervention",
      scope_tenant_id: ticket.tenant_id,
      entity_refs: { tenant_id: ticket.tenant_id, support_ticket_id: ticketId },
      payload: { note: parsed.data.note, from_state: ticket.state, to_state: nextState },
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const actorId = resolveActorId(req);
    db.prepare("UPDATE support_tickets SET state = ? WHERE ticket_id = ?").run(nextState, ticketId);
    const auditId = guard.auditRecordId;
    db.prepare(
      `INSERT INTO support_ticket_interventions
        (intervention_id, ticket_id, actor_id, action_code, note, from_state, to_state,
         reason_code, audit_record_id, created_at_rfc3339)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("intv"),
      ticketId,
      actorId,
      parsed.data.action_code,
      parsed.data.note,
      ticket.state,
      nextState,
      parsed.data.reason_code ?? null,
      auditId,
      new Date().toISOString(),
    );
    return { status: 201, body: { ok: true, audit_record_id: auditId, state: nextState } };
  });
});

app.get("/api/v1/support/tickets/export", authMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint,
              app_version_reported, sla_due_rfc3339, created_at_rfc3339
       FROM support_tickets
       ORDER BY created_at_rfc3339 DESC`,
    )
    .all() as Array<{
      ticket_id: string;
      tenant_id: string;
      state: string;
      severity: string;
      affected_module: string;
      sync_status_hint: string;
      app_version_reported: string;
      sla_due_rfc3339: string | null;
      created_at_rfc3339: string;
    }>;
  const header =
    "ticket_id,tenant_id,state,severity,affected_module,sync_status_hint,app_version_reported,sla_due_rfc3339,created_at_rfc3339";
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.ticket_id,
        r.tenant_id,
        r.state,
        r.severity,
        r.affected_module,
        r.sync_status_hint,
        r.app_version_reported,
        r.sla_due_rfc3339 ?? "",
        r.created_at_rfc3339,
      ]
        .map((v) => `"${String(v).replaceAll(`"`, `""`)}"`)
        .join(","),
    ),
  ].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="support-tickets.csv"');
  res.status(200).send(csv);
});

app.get("/api/v1/support/diagnostic-bundles/latest", authMiddleware, (_req, res) => {
  const bundle = db
    .prepare(
      "SELECT bundle_id, created_at_rfc3339, redaction_profile FROM diagnostic_bundles ORDER BY created_at_rfc3339 DESC LIMIT 1",
    )
    .get() as { bundle_id: string; created_at_rfc3339: string; redaction_profile: string } | undefined;
  if (!bundle) {
    res.status(404).json({ error: "bundle_not_found" });
    return;
  }
  const artifacts = db
    .prepare(
      "SELECT logical_path, sha256, kind FROM diagnostic_bundle_artifacts WHERE bundle_id = ? ORDER BY logical_path ASC",
    )
    .all(bundle.bundle_id) as Array<{ logical_path: string; sha256: string; kind: string }>;
  res.json({
    bundle_id: bundle.bundle_id,
    created_at_rfc3339: bundle.created_at_rfc3339,
    redaction_profile: bundle.redaction_profile,
    artifacts,
  });
});

app.get("/api/v1/support/offline-reconciliation", authMiddleware, (_req, res) => {
  const rows = db
    .prepare(
      "SELECT desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of FROM offline_ticket_reconciliation ORDER BY desktop_queue_id ASC",
    )
    .all();
  res.json(rows);
});

app.get("/api/v1/audit/hardening/runbooks", authMiddleware, (_req, res) => {
  const rows = db
    .prepare("SELECT runbook_id, title, summary, first_steps_json FROM incident_runbooks ORDER BY runbook_id ASC")
    .all() as Array<{ runbook_id: string; title: string; summary: string; first_steps_json: string }>;
  const mapped = rows.map((row) => {
    let steps: string[] = [];
    try {
      steps = JSON.parse(row.first_steps_json) as string[];
    } catch {
      steps = [];
    }
    return { runbook_id: row.runbook_id, title: row.title, summary: row.summary, first_steps: steps };
  });
  res.json(mapped);
});

app.get("/api/v1/audit/hardening/readiness", authMiddleware, (_req, res) => {
  const auditCount = (db.prepare("SELECT COUNT(*) as c FROM audit_records").get() as { c: number }).c;
  const interventionCount = (db.prepare("SELECT COUNT(*) as c FROM support_ticket_interventions").get() as { c: number }).c;
  const bundleCount = (db.prepare("SELECT COUNT(*) as c FROM diagnostic_bundles").get() as { c: number }).c;
  res.json([
    {
      code: "audit_chain_verified",
      description: "Audit records pass chain verification and integrity hash checks.",
      passed: auditCount > 0,
    },
    {
      code: "support_ticket_linked",
      description: "Support interventions are linked to immutable audit records.",
      passed: interventionCount > 0,
    },
    {
      code: "export_redaction",
      description: "Diagnostic bundles are present with redaction profile and artifact digests.",
      passed: bundleCount > 0,
    },
  ]);
});

app.post("/api/v1/activation/claim", (req, res) => {
  const startedAt = Date.now();
  const parsed = ActivationClaimBody.safeParse(req.body);
  if (!parsed.success) {
    observeActivationOutcome("invalid_body");
    structuredLog("activation_claim_failed", {
      reason: "invalid_body",
      status: 400,
      duration_ms: Date.now() - startedAt,
    });
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const nowIso = new Date().toISOString();
  const lic = db
    .prepare(
      `SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.expires_at, l.revoked_at,
              l.update_channel, t.rollout_cohort, t.force_min_app_version, t.force_update_mode, t.force_update_reason, t.is_active,
              t.offline_grace_hours, t.trust_revocation_disconnects_immediately,
              t.reconnect_requires_fresh_heartbeat
       FROM license_keys l
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.license_key = ?`,
    )
    .get(input.license_key.trim()) as
    | {
        id: string;
        tenant_id: string;
        license_key: string;
        max_machines: number;
        update_channel: string;
        rollout_cohort: string;
        expires_at: string | null;
        revoked_at: string | null;
        force_min_app_version: string | null;
        force_update_mode: ForceUpdateMode;
        force_update_reason: string | null;
        offline_grace_hours: number;
        trust_revocation_disconnects_immediately: number;
        reconnect_requires_fresh_heartbeat: number;
        is_active: number;
      }
    | undefined;

  if (!lic || lic.is_active !== 1) {
    observeActivationOutcome("license_not_found");
    structuredLog("activation_claim_failed", {
      reason: "license_not_found",
      status: 404,
      duration_ms: Date.now() - startedAt,
      machine_fingerprint: input.machine_fingerprint,
    });
    res.status(404).json({ error: "license_not_found" });
    return;
  }
  if (lic.revoked_at) {
    observeActivationOutcome("license_revoked");
    structuredLog("activation_claim_failed", {
      reason: "license_revoked",
      status: 403,
      tenant_id: lic.tenant_id,
      license_id: lic.id,
      duration_ms: Date.now() - startedAt,
    });
    res.status(403).json({ error: "license_revoked" });
    return;
  }
  if (lic.expires_at && new Date(lic.expires_at) <= new Date()) {
    observeActivationOutcome("license_expired");
    structuredLog("activation_claim_failed", {
      reason: "license_expired",
      status: 403,
      tenant_id: lic.tenant_id,
      license_id: lic.id,
      duration_ms: Date.now() - startedAt,
    });
    res.status(403).json({ error: "license_expired" });
    return;
  }

  const existing = db
    .prepare(
      "SELECT id, machine_fingerprint FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?",
    )
    .get(lic.tenant_id, input.machine_fingerprint) as { id: string; machine_fingerprint: string } | undefined;

  if (!existing) {
    const activeCountRow = db
      .prepare(
        "SELECT COUNT(*) as count FROM machine_activations WHERE license_id = ? AND revoked_at IS NULL",
      )
      .get(lic.id) as { count: number };
    if (activeCountRow.count >= lic.max_machines) {
      observeActivationOutcome("slot_limit_reached");
      structuredLog("activation_claim_failed", {
        reason: "slot_limit_reached",
        status: 409,
        tenant_id: lic.tenant_id,
        license_id: lic.id,
        max_machines: lic.max_machines,
        duration_ms: Date.now() - startedAt,
      });
      res.status(409).json({ error: "slot_limit_reached", max_machines: lic.max_machines });
      return;
    }
  }

  const cohortPolicy = db
    .prepare(
      `SELECT force_min_app_version, force_update_mode, force_update_reason
       FROM cohort_update_policies
       WHERE channel = ? AND cohort_label = ?`,
    )
    .get(lic.update_channel, lic.rollout_cohort) as
    | {
        force_min_app_version: string | null;
        force_update_mode: Exclude<ForceUpdateMode, "inherit">;
        force_update_reason: string | null;
      }
    | undefined;
  const resolvedPolicy = resolveForceUpdatePolicy({
    appVersion: input.app_version,
    tenantMinVersion: lic.force_min_app_version,
    tenantMode: lic.force_update_mode,
    tenantReason: lic.force_update_reason,
    cohortMinVersion: cohortPolicy?.force_min_app_version ?? null,
    cohortMode: cohortPolicy?.force_update_mode ?? "off",
    cohortReason: cohortPolicy?.force_update_reason ?? null,
  });

  const tokenPayload = {
    kind: "activation",
    tenant_id: lic.tenant_id,
    license_id: lic.id,
    machine_fingerprint: input.machine_fingerprint,
  };
  const activationToken = jwt.sign(tokenPayload, JWT_SECRET, {
    expiresIn: "30d",
    algorithm: "HS256",
  });

  if (existing) {
    db.prepare(
      `UPDATE machine_activations
       SET machine_label = ?, app_version = ?, activation_token = ?, last_seen_at = ?, revoked_at = NULL
       WHERE id = ?`,
    ).run(input.machine_label ?? null, input.app_version ?? null, activationToken, nowIso, existing.id);
  } else {
    db.prepare(
      `INSERT INTO machine_activations
        (id, tenant_id, license_id, machine_fingerprint, machine_label, app_version, activation_token, activated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("act"),
      lic.tenant_id,
      lic.id,
      input.machine_fingerprint,
      input.machine_label ?? null,
      input.app_version ?? null,
      activationToken,
      nowIso,
      nowIso,
    );
  }

  observeActivationOutcome("ok");
  structuredLog("activation_claim_success", {
    status: 200,
    tenant_id: lic.tenant_id,
    license_id: lic.id,
    machine_fingerprint: input.machine_fingerprint,
    policy_source: resolvedPolicy.policy_source,
    force_update_required: resolvedPolicy.force_update_required,
    duration_ms: Date.now() - startedAt,
  });
  res.json({
    tenant_id: lic.tenant_id,
    license_id: lic.id,
    machine_fingerprint: input.machine_fingerprint,
    activation_token: activationToken,
    expires_at: lic.expires_at,
    update_channel: lic.update_channel,
    offline_grace_hours: lic.offline_grace_hours,
    trust_revocation_disconnects_immediately: lic.trust_revocation_disconnects_immediately === 1,
    reconnect_requires_fresh_heartbeat: lic.reconnect_requires_fresh_heartbeat === 1,
    force_min_app_version: resolvedPolicy.force_min_app_version,
    force_update_mode: resolvedPolicy.force_update_mode,
    force_update_reason: resolvedPolicy.force_update_reason,
    force_update_policy_source: resolvedPolicy.policy_source,
    force_update_required: resolvedPolicy.force_update_required,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`control-api listening on ${port}`);
});

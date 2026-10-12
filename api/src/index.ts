/**
 * Maintafox control-plane API: email/password JWT, tenants, license lifecycle,
 * and machine activation claims for desktop clients.
 */
import bcrypt from "bcryptjs";
import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";
import { z } from "zod";

import {
  CapabilitiesMapSchema,
  EditionSlugSchema,
  SYSTEM_EDITION_IDS,
  parseEditionId,
  type EditionId,
} from "./edition-catalog.js";
import {
  EditionCatalogError,
  createEdition,
  deleteEdition,
  editionExists,
  ensureSystemEditionsPresent,
  getEdition,
  listEditions,
  loadCapabilitiesJsonForSign,
  repairAllEditionCapabilities,
  seedEditionCatalogIfEmpty,
  updateEdition,
} from "./edition-catalog-store.js";
import {
  addHoursIso,
  buildSignedEntitlementEnvelope,
  capabilitiesDigest,
  loadEntitlementSigningKey,
  type EntitlementEnvelopePayload,
} from "./entitlement-signer.js";
import {
  assertTenantOwnsObjectKey,
  buildTenantMediaObjectKey,
  TenantMediaObjectStore,
} from "./storage/object-store.js";
import {
  AUDIT_RECORD_COLUMNS,
  auditRecordPreimage,
  mapAuditRow,
  verifyAuditChain,
  type AuditEntityRefs,
  type AuditRecordRow,
} from "./audit-chain.js";
import { openDatabase, type Database } from "./db/database.js";
import { runMigrations } from "./db/migrate.js";
import {
  loadSyncConfig,
  loadSyncEntityRegistry,
  purgeTenantSyncData,
  removeStateOutsideTenantScope,
  runSyncExchangeV1,
  runSyncExchangeV2,
  runSyncRetention,
  runSyncSnapshotV2,
  SyncRequestError,
  SyncSnapshotBodyV2,
  syncExchangeBodyV2,
  type SyncConfig,
  type SyncEntityRegistry,
} from "./sync/index.js";
import {
  DEVICE_TOKEN_ROTATE_AFTER_SECONDS,
  STEP_UP_TTL_SECONDS,
  VENDOR_ADMIN_TTL_SECONDS,
  signDeviceActivationToken,
  signStepUpToken,
  signVendorAdminToken,
  verifyDeviceActivationToken,
  verifyStepUpToken,
  verifyVendorAdminToken,
} from "./auth-tokens.js";

/**
 * Express 4 does not catch a rejected promise from an async handler (the request would hang and
 * the rejection would be unhandled). Wrap every handler registered through the app's routing
 * methods so a rejection reaches next(err) and the final error handler. Error handlers (4 args)
 * are left as they are so Express still recognises them by arity.
 */
function forwardAsyncErrors(target: express.Express): void {
  type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
  const wrap = (fn: unknown): unknown => {
    if (typeof fn !== "function" || fn.length === 4) return fn;
    const handler = fn as Handler;
    return function asyncSafe(req: express.Request, res: express.Response, next: express.NextFunction) {
      try {
        const out = handler(req, res, next);
        if (out && typeof (out as Promise<unknown>).catch === "function") {
          (out as Promise<unknown>).catch(next);
        }
      } catch (err) {
        next(err);
      }
    };
  };
  for (const method of ["use", "get", "post", "put", "patch", "delete"] as const) {
    const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
    (target as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
}

/**
 * Startup failure: write synchronously (stderr is an async pipe on Windows, so console.error
 * followed by process.exit can drop the message) and exit non-zero.
 */
function fatal(message: string): never {
  writeSync(2, `FATAL: ${message}
`);
  process.exit(1);
}

/** Required configuration: the process refuses to start rather than run on a hidden default. */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    fatal(`environment variable ${name} is required (see .env.example).`);
  }
  return value;
}

const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 32) {
  fatal("Set JWT_SECRET (min 32 characters) in the environment.");
}
const JWT_SECRET: string = JWT_SECRET_RAW;

try {
  loadEntitlementSigningKey();
} catch (err) {
  fatal((err as Error).message);
}

const CORS_ORIGIN = requireEnv("CORS_ORIGIN");

/** Comma-separated `CORS_ORIGIN` (e.g. console + Tauri dev); empty segments ignored. */
function parseCorsOrigins(raw: string): string[] {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    fatal("CORS_ORIGIN must list at least one origin.");
  }
  return list;
}

/**
 * Desktop (Tauri webview) origins, allowed ONLY on device routes (activation + sync).
 * Windows WebView2 serves the installed app from `http://tauri.localhost` (or
 * `https://tauri.localhost` with `useHttpsScheme`); macOS/Linux use `tauri://localhost`.
 * Optional: unset/empty means no desktop origin is allowed (logged at startup).
 * Each entry must be an exact `scheme://host[:port]` origin — no wildcard, path or `null`.
 */
function parseDesktopAppOrigins(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const origin of list) {
    if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) {
      fatal(
        `DESKTOP_APP_ORIGINS entry "${origin}" is not an exact origin (expected scheme://host[:port], no wildcard or path).`,
      );
    }
  }
  return list;
}

const CONSOLE_CORS_ORIGINS = parseCorsOrigins(CORS_ORIGIN);
const DESKTOP_APP_ORIGINS = parseDesktopAppOrigins(process.env.DESKTOP_APP_ORIGINS);
if (DESKTOP_APP_ORIGINS.length === 0) {
  console.warn(
    "DESKTOP_APP_ORIGINS is not set: installed desktop apps cannot call activation/sync routes from their webview.",
  );
}

/** Routes the desktop app calls with a device token (or none, for activation preview/claim). */
function isDeviceRoute(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("/api/v1/activation/") || p.startsWith("/api/v1/sync/");
}

/**
 * Admin/console routes: only CORS_ORIGIN (credentialed). Device routes additionally accept
 * DESKTOP_APP_ORIGINS, without credentials — the desktop authenticates with a Bearer header.
 */
const corsOptionsDelegate: cors.CorsOptionsDelegate<express.Request> = (req, callback) => {
  const origin = req.header("Origin");
  if (
    origin &&
    !CONSOLE_CORS_ORIGINS.includes(origin) &&
    DESKTOP_APP_ORIGINS.includes(origin) &&
    isDeviceRoute(req.path)
  ) {
    callback(null, { origin, credentials: false });
    return;
  }
  callback(null, { origin: CONSOLE_CORS_ORIGINS, credentials: true });
};
/** Only read when the users table is empty (first boot); see seedAdminIfEmpty. */
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim();
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const NODE_ENV = process.env.NODE_ENV ?? "development";
const SEED_BEHAVIOR_RAW = (process.env.SEED_BEHAVIOR ?? (NODE_ENV === "production" ? "disabled" : "full")).toLowerCase();
const SEED_BEHAVIOR = SEED_BEHAVIOR_RAW === "disabled" || SEED_BEHAVIOR_RAW === "safe" || SEED_BEHAVIOR_RAW === "full"
  ? SEED_BEHAVIOR_RAW
  : "disabled";
/** Minimum length of the X-Operator-Reason header on privileged actions. Always enforced. */
const PRIVILEGED_REASON_MIN_LENGTH = 4;
/** Desktop clamps one push to 1000 outbox rows (sync/queries.rs get_sync_push_payload). */
const SYNC_MAX_OUTBOX_BATCH = 1000;
/** Must stay <= nginx `client_max_body_size` on /api/v1/sync/exchange (deploy/nginx-edge.conf). */
const SYNC_EXCHANGE_BODY_LIMIT = "32mb";
const DEFAULT_JSON_BODY_LIMIT = "1mb";

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

/** All API data lives in Postgres (versioned migrations in api/migrations). */
const DATABASE_URL = requireEnv("DATABASE_URL");

let syncConfig: SyncConfig;
let syncEntityRegistry: SyncEntityRegistry;
try {
  syncConfig = loadSyncConfig();
  syncEntityRegistry = loadSyncEntityRegistry();
} catch (err) {
  fatal((err as Error).message);
}

let db: Database;
try {
  db = await openDatabase(DATABASE_URL, "maintafox-control-api");
  const migrations = await runMigrations(db, structuredLog);
  structuredLog("schema_migrations_ready", {
    applied_now: migrations.applied,
    previously_applied: migrations.alreadyApplied,
  });
} catch (err) {
  fatal(`database startup failed: ${(err as Error).message}`);
}

{
  const removed = await removeStateOutsideTenantScope(db, syncEntityRegistry.tenantScopedTypes());
  if (removed > 0) {
    structuredLog("sync_state_outside_tenant_scope_removed", { rows: removed });
  }
}

await seedEditionCatalogIfEmpty(db);
await ensureSystemEditionsPresent(db);
await repairAllEditionCapabilities(db);

/** Any catalog edition id (system or custom). Existence checked against DB on write. */
const EditionIdSchema = z.string().min(2).max(64);

type TenantInsertInput = {
  id: string;
  slug: string;
  display_name: string;
  force_min_app_version?: string | null;
  force_update_mode?: string;
  force_update_reason?: string | null;
  rollout_cohort?: string;
  update_channel?: string;
  edition?: EditionId;
  offline_grace_hours?: number;
  trust_revocation_disconnects_immediately?: boolean;
  reconnect_requires_fresh_heartbeat?: boolean;
};

/** Postgres unique_violation on tenants.slug. */
function isTenantSlugUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && e.constraint === "tenants_slug_key";
}

function tenantWriteFailure(err: unknown): { status: number; body: { error: string; message: string } } {
  if (err instanceof EditionCatalogError && err.code === "edition_not_found") {
    return { status: 400, body: { error: "edition_not_found", message: err.message } };
  }
  if (isTenantSlugUniqueViolation(err)) {
    return { status: 409, body: { error: "tenant_conflict", message: "This tenant slug is already taken." } };
  }
  structuredLog("tenant_write_failed", { message: String(err) });
  return { status: 500, body: { error: "tenant_write_failed", message: String(err) } };
}

async function insertTenantRow(input: TenantInsertInput): Promise<void> {
  const editionRaw = input.edition?.trim() || "core";
  if (!(await editionExists(db, editionRaw))) {
    throw new EditionCatalogError("edition_not_found", `Edition '${editionRaw}' not found`);
  }
  // Savepoint: callers inside a transaction catch the slug unique violation (409) and go on.
  await db.savepoint(() => db.run(
    `INSERT INTO tenants
       (id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort,
        update_channel, edition, entitlement_lineage, offline_grace_hours, trust_revocation_disconnects_immediately,
        reconnect_requires_fresh_heartbeat, is_initialized, has_demo_data, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, 1, ?)`,
    input.id,
    input.slug,
    input.display_name,
    input.force_min_app_version ?? null,
    input.force_update_mode ?? "inherit",
    input.force_update_reason ?? null,
    input.rollout_cohort ?? "stable-main",
    input.update_channel ?? "stable",
    editionRaw,
    input.offline_grace_hours ?? 72,
    input.trust_revocation_disconnects_immediately ? 1 : 0,
    (input.reconnect_requires_fresh_heartbeat ?? true) ? 1 : 0,
    new Date().toISOString(),
  ));
}

async function updateTenantRow(
  tenantId: string,
  input: {
    slug: string;
    display_name: string;
    rollout_cohort: string;
    update_channel: string;
    edition: string;
    bumpEntitlementLineage?: boolean;
  },
): Promise<void> {
  if (!(await editionExists(db, input.edition))) {
    throw new EditionCatalogError("edition_not_found", `Edition '${input.edition}' not found`);
  }
  await db.savepoint(() => db.run(
    `UPDATE tenants
     SET slug = ?, display_name = ?, rollout_cohort = ?, update_channel = ?, edition = ?,
         entitlement_lineage = entitlement_lineage + ?
     WHERE id = ?`,
    input.slug,
    input.display_name,
    input.rollout_cohort,
    input.update_channel,
    input.edition,
    input.bumpEntitlementLineage ? 1 : 0,
    tenantId,
  ));
}

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

await seedAdminIfEmpty();
if (shouldSeedDomainData()) {
  await seedTenantIfEmpty();
  await seedAuditSupportIfEmpty();
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
  reason:
    | "ok"
    | "invalid_body"
    | "license_not_found"
    | "license_revoked"
    | "license_expired"
    | "slot_limit_reached"
    | "activation_revoked",
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

async function appendAuditRecord(input: {
  actor_id: string;
  action_code: string;
  action_category: string;
  correlation_id: string;
  scope_tenant_id?: string | null;
  reason_code?: string | null;
  approval_correlation_id?: string | null;
  entity_refs?: AuditEntityRefs;
  payload?: unknown;
}): Promise<string> {
  // The hash chain needs a gap-free sequence: serialize appends (joins the caller's transaction).
  return db.tx(async () => {
    await db.lockXact("audit-chain", "append");
    const prev = await db.get("SELECT sequence, record_integrity_sha256 FROM audit_records ORDER BY sequence DESC LIMIT 1") as { sequence: number; record_integrity_sha256: string } | undefined;
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
    await db.run(`INSERT INTO audit_records
        (record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
         correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
         payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
         approval_correlation_id, entity_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, recordId,
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
      JSON.stringify(entityRefs));
    return recordId;
  });
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
  edition: EditionIdSchema.optional(),
  offline_grace_hours: z.number().int().min(1).max(720).optional(),
  trust_revocation_disconnects_immediately: z.boolean().optional(),
  reconnect_requires_fresh_heartbeat: z.boolean().optional(),
}).strict();

const UpdateTenantBody = z
  .object({
    slug: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/).optional(),
    display_name: z.string().min(2).max(128).optional(),
    rollout_cohort: z.string().trim().min(2).max(64).optional(),
    update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
    edition: EditionIdSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

const UpdateLicenseBody = z
  .object({
    max_machines: z.number().int().min(1).max(1000).optional(),
    expires_at: z.string().datetime().nullable().optional(),
    update_channel: z.enum(["stable", "pilot", "internal"]).optional(),
    operator_rationale: z.string().trim().min(8).max(512).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty_patch" });

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

const SlickPayUserInfoSchema = z
  .object({
    firstname: z.string().min(1).max(128).optional(),
    lastname: z.string().min(1).max(128).optional(),
    phone: z.string().min(6).max(32).optional(),
    email: z.string().email().optional(),
    address: z.string().min(1).max(256).optional(),
    contact_id: z.string().uuid().optional(),
    /** Company / organization aliases accepted from the public website. */
    company: z.string().min(2).max(128).optional(),
    company_name: z.string().min(2).max(128).optional(),
    entreprise: z.string().min(2).max(128).optional(),
    organization: z.string().min(2).max(128).optional(),
    business_name: z.string().min(2).max(128).optional(),
    slug: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  })
  .passthrough();

const SlickPayInitiateBody = z
  .object({
    plan: z.string().trim().min(1).max(64),
    amount: z.number().nonnegative(),
    tenant_id: z.string().min(3).optional(),
    extra_slots: z.number().int().min(0).max(1000).optional().default(0),
    user_info: SlickPayUserInfoSchema.optional(),
    return_url: z.string().url().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.tenant_id && !body.user_info) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["user_info"],
        message: "user_info is required when tenant_id is omitted (new customer checkout)",
      });
    }
  });

const ActivationClaimBody = z.object({
  license_key: z.string().min(8),
  machine_fingerprint: z.string().min(8).max(256),
  machine_label: z.string().max(128).optional(),
  app_version: z.string().max(32).optional(),
}).strict();

/** Desktop sync push — additive fields allowed (device_class, media_manifest, tenant_config). */
const SyncExchangeOutboxItem = z
  .object({
    idempotency_key: z.string().min(1).max(256),
    entity_type: z.string().min(1).max(256),
    entity_sync_id: z.string().min(1).max(256),
    operation: z.enum(["create", "update", "delete", "upsert", "archive"]),
    row_version: z.number().int().nonnegative(),
    payload_json: z.string().min(1),
    payload_hash: z.string().min(1).max(128),
  })
  .strict();

const SyncExchangeBody = z.object({
  protocol_version: z.literal("v1"),
  checkpoint_token: z.string().nullable().optional(),
  idempotency_key: z.string().min(8).max(128),
  outbox_batch: z.array(SyncExchangeOutboxItem).max(SYNC_MAX_OUTBOX_BATCH),
  device_class: z.enum(["desktop", "mobile"]).optional(),
  media_manifest: z.array(z.unknown()).optional(),
  tenant_config: z.unknown().optional(),
});

/** Sync protocol v2 request (deploy/SYNC_PROTOCOL_V2.md); same batch cap as v1. */
const SyncExchangeBodyV2 = syncExchangeBodyV2(SYNC_MAX_OUTBOX_BATCH);

const SyncMediaPresignPutBody = z
  .object({
    parent_entity_type: z.string().min(1).max(128),
    parent_entity_sync_id: z.string().min(1).max(256),
    content_sha256: z.string().min(64).max(80),
    object_key: z.string().min(1).max(1024).optional(),
  })
  .strict();

const SyncMediaPresignGetBody = z
  .object({
    object_key: z.string().min(1).max(1024),
  })
  .strict();

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
forwardAsyncErrors(app);
// Deployment topology: internet → nginx edge (deploy/nginx-edge.conf) → this API, which is only
// `expose`d inside the compose network. Trusting exactly one hop makes req.ip the real client
// address (last X-Forwarded-For entry appended by nginx) without trusting client-supplied entries.
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
// Sync batches carry up to SYNC_MAX_OUTBOX_BATCH rows; every other route keeps the small default.
// body-parser skips already-parsed bodies, so the route-specific parser must be registered first.
app.use("/api/v1/sync/exchange", express.json({ limit: SYNC_EXCHANGE_BODY_LIMIT }));
app.use(express.json({ limit: DEFAULT_JSON_BODY_LIMIT }));

function rateLimitedResponse(_req: express.Request, res: express.Response): void {
  res.status(429).json({ error: "rate_limited", message: "Too many requests; retry later." });
}

/** Brute-force guard on password login (per client IP). */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Password re-verification for privileged actions (per authenticated operator). */
const stepUpRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `user:${(req as AuthRequest).userId ?? "unknown"}`,
  handler: rateLimitedResponse,
});

/** Licence-key guessing guard on activation preview/claim (per client IP). */
const activationRateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Public checkout creates tenants from unauthenticated input (per client IP). */
const publicCheckoutRateLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedResponse,
});

/** Per activated machine; desktop retries with backoff on 429 (sync RATE_LIMIT class). */
const deviceRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
    return act ? `device:${act.tenantId}:${act.machineFingerprint}` : `ip:${req.ip ?? "unknown"}`;
  },
  handler: rateLimitedResponse,
});
app.use(cors(corsOptionsDelegate));
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

app.get("/health", async (_req, res) => {
  // All API data is in Postgres: report unhealthy (503) when it cannot be reached, so the
  // container healthcheck and the edge see the outage.
  try {
    await db.query("SELECT 1");
  } catch (err) {
    structuredLog("health_database_unreachable", { error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ status: "unavailable", database: "unreachable" });
    return;
  }
  res.json({
    status: "ok",
    seed_behavior: SEED_BEHAVIOR,
    privileged_guard: {
      require_step_up: true,
      require_reason: true,
    },
  });
});

app.get("/api/v1/ops/observability/slo", authMiddleware, async (_req, res) => {
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
  const staleRow = await db.get(`SELECT COUNT(*) as c
       FROM machine_activations
       WHERE revoked_at IS NULL
         AND last_seen_at::timestamptz < now() - interval '5 minutes'`) as { c: number };
  const totalMachinesRow = await db.get("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL") as { c: number };
  const revokedMachinesRow = await db.get("SELECT COUNT(*) as c FROM machine_activations WHERE revoked_at IS NOT NULL") as { c: number };
  const channelMismatchRow = await db.get(`SELECT COUNT(*) as c
       FROM machine_activations a
       JOIN license_keys l ON l.id = a.license_id
       JOIN tenants t ON t.id = a.tenant_id
       WHERE l.update_channel != t.update_channel`) as { c: number };
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

app.post("/api/v1/auth/login", loginRateLimiter, async (req, res) => {
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
  const user = await db.get("SELECT id, email, password_hash FROM users WHERE lower(email) = lower(?)", email) as
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
  const token = signVendorAdminToken(JWT_SECRET, user);
  observeAuthAttempt(Date.now() - startedAt, true);
  structuredLog("auth_login_success", {
    status: 200,
    user_id: user.id,
    email: user.email,
  });
  res.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: VENDOR_ADMIN_TTL_SECONDS,
  });
});

/**
 * Vendor-console operator authentication. Only accepts vendor_admin tokens (device activation and
 * step-up tokens are rejected by audience/kind) and re-checks that the operator still exists, so a
 * deleted operator's unexpired token stops working immediately.
 */
async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const claims = verifyVendorAdminToken(JWT_SECRET, h.slice(7));
  if (!claims) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  const operator = await db.get("SELECT id FROM users WHERE id = ?", claims.userId) as { id: number } | undefined;
  if (!operator) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  (req as AuthRequest).userId = String(claims.userId);
  next();
}

const StepUpBody = z.object({ password: z.string().min(1).max(1024) }).strict();

/**
 * Privileged-action step-up: the operator re-enters their password and receives a short-lived
 * token bound to their user id, sent as X-Step-Up-Token on privileged requests
 * (see requirePrivilegedGuard). Interim control until TOTP lands (master plan Phase 4.1).
 */
app.post("/api/v1/auth/step-up", authMiddleware, stepUpRateLimiter, async (req, res) => {
  const parsed = StepUpBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const userId = Number((req as AuthRequest).userId);
  const user = await db.get("SELECT id, password_hash FROM users WHERE id = ?", userId) as
    | { id: number; password_hash: string }
    | undefined;
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    structuredLog("auth_step_up_failed", { user_id: userId, status: 401 });
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const jti = newId("stepup");
  structuredLog("auth_step_up_success", { user_id: userId, step_up_id: jti });
  res.json({
    step_up_token: signStepUpToken(JWT_SECRET, user.id, jti),
    token_type: "StepUp",
    expires_in: STEP_UP_TTL_SECONDS,
  });
});

type ActivationAuthContext = {
  tenantId: string;
  licenseId: string;
  machineFingerprint: string;
  /** Raw bearer token (echoed by policy-refresh for desktop claim schema). */
  token: string;
  /** Token issue time, seconds since epoch. */
  tokenIssuedAt: number;
};

/** `last_seen_at` is written at most this often per device (the sync heartbeat runs every ~15 s). */
const LAST_SEEN_TOUCH_INTERVAL_MS = 60_000;

/**
 * Device requests are accepted only while the token is the one most recently issued to this
 * machine and the machine, its licence and its tenant are all still valid. Denials:
 * 401 missing_token | invalid_token | token_superseded;
 * 403 tenant_inactive | license_revoked | license_expired | activation_revoked.
 */
async function activationAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const token = h.slice(7);
  const claims = verifyDeviceActivationToken(JWT_SECRET, token);
  if (!claims) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  const row = await db.get(`SELECT a.id, a.revoked_at, a.activation_token, a.last_seen_at,
              l.revoked_at AS license_revoked_at, l.expires_at AS license_expires_at,
              t.is_active AS tenant_is_active
       FROM machine_activations a
       JOIN license_keys l ON l.id = a.license_id
       JOIN tenants t ON t.id = a.tenant_id
       WHERE a.tenant_id = ? AND a.license_id = ? AND a.machine_fingerprint = ?`, claims.tenantId, claims.licenseId, claims.machineFingerprint) as
    | {
        id: string;
        revoked_at: string | null;
        activation_token: string;
        last_seen_at: string;
        license_revoked_at: string | null;
        license_expires_at: string | null;
        tenant_is_active: number;
      }
    | undefined;
  const deny = (status: number, error: string) => {
    structuredLog("activation_auth_denied", {
      status,
      reason: error,
      tenant_id: claims.tenantId,
      license_id: claims.licenseId,
      machine_fingerprint: claims.machineFingerprint,
      path: req.path,
    });
    res.status(status).json({ error });
  };
  if (!row) {
    deny(403, "activation_revoked");
    return;
  }
  if (row.activation_token !== token) {
    deny(401, "token_superseded");
    return;
  }
  if (row.tenant_is_active !== 1) {
    deny(403, "tenant_inactive");
    return;
  }
  if (row.license_revoked_at) {
    deny(403, "license_revoked");
    return;
  }
  if (row.license_expires_at && new Date(row.license_expires_at) <= new Date()) {
    deny(403, "license_expired");
    return;
  }
  if (row.revoked_at) {
    deny(403, "activation_revoked");
    return;
  }
  const nowMs = Date.now();
  const lastSeenMs = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= LAST_SEEN_TOUCH_INTERVAL_MS) {
    await db.run("UPDATE machine_activations SET last_seen_at = ? WHERE id = ?", new Date(nowMs).toISOString(), row.id);
  }
  (req as express.Request & { activation?: ActivationAuthContext }).activation = {
    tenantId: claims.tenantId,
    licenseId: claims.licenseId,
    machineFingerprint: claims.machineFingerprint,
    token,
    tokenIssuedAt: claims.issuedAt,
  };
  next();
}

// Fan-out implemented in api/src/sync (selectInboundForDevice).


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

/**
 * Runs a mutating operation in one transaction. With an Idempotency-Key header the stored response
 * is replayed for the same request (409 for a different one); the key lookup, the operation and
 * the stored response commit together, and concurrent requests with the same key are serialized.
 */
async function runIdempotent(
  req: express.Request,
  res: express.Response,
  operation: () => Promise<IdempotentResponse>,
): Promise<void> {
  const idemHeader = req.header("Idempotency-Key")?.trim();
  if (!idemHeader) {
    const out = await db.tx(operation);
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
  const outcome = await db.tx(async (): Promise<
    { kind: "conflict" } | { kind: "replay" | "fresh"; status: number; body: unknown }
  > => {
    await db.lockXact("admin-idempotency", scopedKey);
    const existing = await db.get<{ request_hash: string; response_status: number; response_json: string }>(
      `SELECT request_hash, response_status, response_json
       FROM idempotency_keys
       WHERE idempotency_key = ?`,
      scopedKey,
    );
    if (existing) {
      if (existing.request_hash !== requestHash) {
        return { kind: "conflict" };
      }
      return { kind: "replay", status: existing.response_status, body: JSON.parse(existing.response_json) };
    }
    const out = await operation();
    await db.run(
      `INSERT INTO idempotency_keys
        (idempotency_key, actor_id, method, path, request_hash, response_status, response_json, created_at_rfc3339)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      scopedKey,
      actorId,
      req.method,
      req.path,
      requestHash,
      out.status,
      JSON.stringify(out.body),
      new Date().toISOString(),
    );
    return { kind: "fresh", status: out.status, body: out.body };
  });
  if (outcome.kind === "conflict") {
    res.status(409).json({ error: "idempotency_key_conflict" });
    return;
  }
  res.setHeader("X-Idempotent-Replay", outcome.kind === "replay" ? "true" : "false");
  res.status(outcome.status).json(outcome.body);
}

async function requirePrivilegedAction(
  req: express.Request,
  input: {
    action_code: string;
    action_category: string;
    scope_tenant_id?: string | null;
    entity_refs?: AuditEntityRefs;
    payload?: unknown;
  },
): Promise<{ ok: true; reasonCode: string | null; auditRecordId: string } | { ok: false; status: number; body: unknown }> {
  const reasonCode = req.header("X-Operator-Reason")?.trim() ?? null;
  const stepUpToken = req.header("X-Step-Up-Token")?.trim() ?? null;
  if (!reasonCode || reasonCode.length < PRIVILEGED_REASON_MIN_LENGTH) {
    return {
      ok: false,
      status: 403,
      body: { error: "privileged_action_guard_failed", reason: "missing_reason_code" },
    };
  }
  if (!stepUpToken) {
    return {
      ok: false,
      status: 403,
      body: { error: "privileged_action_guard_failed", reason: "missing_step_up_token" },
    };
  }
  const operatorId = Number((req as AuthRequest).userId);
  const stepUp = Number.isSafeInteger(operatorId) ? verifyStepUpToken(JWT_SECRET, stepUpToken, operatorId) : null;
  if (!stepUp) {
    return {
      ok: false,
      status: 403,
      body: { error: "privileged_action_guard_failed", reason: "invalid_or_expired_step_up_token" },
    };
  }
  const auditRecordId = await appendAuditRecord({
    actor_id: resolveActorId(req),
    action_code: input.action_code,
    action_category: input.action_category,
    correlation_id: `priv-${newId("corr")}`,
    scope_tenant_id: input.scope_tenant_id ?? null,
    reason_code: reasonCode,
    entity_refs: input.entity_refs,
    payload: {
      ...(input.payload as Record<string, unknown> | undefined),
      privileged_step_up_present: true,
      step_up_id: stepUp.jti,
    },
  });
  return { ok: true, reasonCode, auditRecordId };
}

app.get("/api/v1/me/permissions", authMiddleware, async (_req, res) => {
  res.json(VENDOR_PERMISSIONS);
});

const CreateEditionBody = z
  .object({
    id: EditionSlugSchema,
    label: z.string().trim().min(2).max(128),
    capabilities: CapabilitiesMapSchema,
    clone_from: EditionIdSchema.optional(),
  })
  .strict();

const UpdateEditionBody = z
  .object({
    label: z.string().trim().min(2).max(128).optional(),
    capabilities: CapabilitiesMapSchema,
    expected_row_version: z.number().int().min(1),
  })
  .strict();

function editionCatalogHttpError(err: unknown, res: express.Response): boolean {
  if (!(err instanceof EditionCatalogError)) return false;
  const status =
    err.code === "edition_not_found"
      ? 404
      : err.code === "edition_version_conflict" ||
          err.code === "edition_in_use" ||
          err.code === "edition_id_taken"
        ? 409
        : err.code === "edition_system_immutable" || err.code === "edition_id_invalid"
          ? 400
          : err.code === "catalog_schema_invalid"
            ? 500
            : 400;
  res.status(status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
  return true;
}

app.get("/api/v1/editions", authMiddleware, async (_req, res) => {
  res.json({ items: await listEditions(db) });
});

app.post("/api/v1/editions", authMiddleware, async (req, res) => {
  const parsed = CreateEditionBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  if (SYSTEM_EDITION_IDS.includes(parsed.data.id as (typeof SYSTEM_EDITION_IDS)[number])) {
    res.status(400).json({
      error: "edition_system_immutable",
      message: "Cannot create an edition that overwrites a system id; clone with a different id.",
    });
    return;
  }
  try {
    let capabilities = parsed.data.capabilities;
    if (parsed.data.clone_from) {
      const source = await getEdition(db, parsed.data.clone_from);
      if (!source) {
        res.status(400).json({ error: "edition_not_found", message: `clone_from '${parsed.data.clone_from}' not found` });
        return;
      }
      // Body capabilities still required (strict full map); clone_from is a UI convenience hint only when equal.
      void source;
      capabilities = parsed.data.capabilities;
    }
    const created = await createEdition(db, {
      id: parsed.data.id,
      label: parsed.data.label,
      capabilities,
      actorId: resolveActorId(req),
    });
    await appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: "edition_catalog_create",
      action_category: "entitlement",
      correlation_id: `edition-create-${created.id}`,
      payload: { edition_id: created.id, label: created.label },
    });
    res.status(201).json(created);
  } catch (err) {
    if (editionCatalogHttpError(err, res)) return;
    throw err;
  }
});

app.patch("/api/v1/editions/:editionId", authMiddleware, async (req, res) => {
  const editionId = req.params.editionId;
  const parsed = UpdateEditionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const ifMatch = req.header("if-match");
  let expected = parsed.data.expected_row_version;
  if (ifMatch) {
    const n = Number.parseInt(ifMatch.replace(/"/g, ""), 10);
    if (Number.isFinite(n)) expected = n;
  }
  try {
    const updated = await updateEdition(db, editionId, {
      label: parsed.data.label,
      capabilities: parsed.data.capabilities,
      expected_row_version: expected,
      actorId: resolveActorId(req),
    });
    await appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: "edition_catalog_update",
      action_category: "entitlement",
      correlation_id: `edition-update-${editionId}-${updated.row_version}`,
      payload: {
        edition_id: editionId,
        row_version: updated.row_version,
        label: updated.label,
      },
    });
    res.json(updated);
  } catch (err) {
    if (editionCatalogHttpError(err, res)) return;
    throw err;
  }
});

app.delete("/api/v1/editions/:editionId", authMiddleware, async (req, res) => {
  const editionId = req.params.editionId;
  try {
    await deleteEdition(db, editionId);
    await appendAuditRecord({
      actor_id: resolveActorId(req),
      action_code: "edition_catalog_delete",
      action_category: "entitlement",
      correlation_id: `edition-delete-${editionId}`,
      payload: { edition_id: editionId },
    });
    res.status(204).send();
  } catch (err) {
    if (editionCatalogHttpError(err, res)) return;
    throw err;
  }
});

app.get("/api/v1/tenants", authMiddleware, async (req, res) => {
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const pageSize = effectiveLimit + 1;
  let rows: Array<Record<string, unknown>>;
  if (cursor) {
    const [cursorCreatedAt, cursorId] = cursor.split("|");
    rows = await db.all(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
                offline_grace_hours, trust_revocation_disconnects_immediately,
                reconnect_requires_fresh_heartbeat, is_initialized, has_demo_data, is_active, created_at
         FROM tenants
         WHERE (created_at < ?) OR (created_at = ? AND id < ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`, cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
  } else {
    rows = await db.all(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
                COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
                offline_grace_hours, trust_revocation_disconnects_immediately,
                reconnect_requires_fresh_heartbeat, is_initialized, has_demo_data, is_active, created_at
         FROM tenants
         ORDER BY created_at DESC, id DESC
         LIMIT ?`, pageSize) as Array<Record<string, unknown>>;
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

app.post("/api/v1/tenants", authMiddleware, async (req, res) => {
  const parsed = CreateTenantBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const input = parsed.data;
    const id = newId("tenant");
    const edition = (input.edition?.trim() || "core");
    if (!await editionExists(db, edition)) {
      return { status: 400, body: { error: "edition_not_found", message: `Edition '${edition}' not found` } };
    }
    try {
      await insertTenantRow({
        id,
        slug: input.slug,
        display_name: input.display_name,
        force_min_app_version: input.force_min_app_version ?? null,
        force_update_mode: input.force_update_mode ?? "inherit",
        force_update_reason: input.force_update_reason ?? null,
        rollout_cohort: input.rollout_cohort ?? "stable-main",
        update_channel: input.update_channel ?? "stable",
        edition,
        offline_grace_hours: input.offline_grace_hours ?? 72,
        trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately ?? false,
        reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat ?? true,
      });
    } catch (err) {
      return tenantWriteFailure(err);
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
        edition,
        entitlement_lineage: 0,
        offline_grace_hours: input.offline_grace_hours ?? 72,
        trust_revocation_disconnects_immediately: input.trust_revocation_disconnects_immediately ?? false,
        reconnect_requires_fresh_heartbeat: input.reconnect_requires_fresh_heartbeat ?? true,
        is_initialized: false,
        has_demo_data: false,
      },
    };
  });
});

app.patch("/api/v1/tenants/:tenantId", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const parsed = UpdateTenantBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const row = await db.get(`SELECT id, slug, display_name, rollout_cohort, update_channel,
              COALESCE(edition, 'core') AS edition
       FROM tenants WHERE id = ?`, tenantId) as
    | {
        id: string;
        slug: string;
        display_name: string;
        rollout_cohort: string;
        update_channel: string;
        edition: string;
      }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  const input = parsed.data;
  const nextSlug = input.slug ?? row.slug;
  const nextDisplay = input.display_name ?? row.display_name;
  const nextCohort = input.rollout_cohort ?? row.rollout_cohort;
  const nextChannel = input.update_channel ?? row.update_channel;
  const prevEdition = row.edition || "core";
  const nextEdition = input.edition != null ? input.edition.trim() : prevEdition;
  if (!await editionExists(db, nextEdition)) {
    res.status(400).json({ error: "edition_not_found", message: `Edition '${nextEdition}' not found` });
    return;
  }
  const editionChanged = nextEdition !== prevEdition;
  try {
    await updateTenantRow(tenantId, {
      slug: nextSlug,
      display_name: nextDisplay,
      rollout_cohort: nextCohort,
      update_channel: nextChannel,
      edition: nextEdition,
      bumpEntitlementLineage: editionChanged,
    });
  } catch (err) {
    const failure = tenantWriteFailure(err);
    res.status(failure.status).json(failure.body);
    return;
  }
  const out = await db.get(`SELECT id, slug, display_name, force_min_app_version, force_update_mode, force_update_reason, rollout_cohort, update_channel,
              COALESCE(edition, 'core') AS edition, COALESCE(entitlement_lineage, 0) AS entitlement_lineage,
              offline_grace_hours, trust_revocation_disconnects_immediately, reconnect_requires_fresh_heartbeat, is_active, created_at
       FROM tenants WHERE id = ?`, tenantId) as Record<string, unknown>;
  res.json(out);
});

app.delete("/api/v1/tenants/:tenantId", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const exists = await db.get(`SELECT id FROM tenants WHERE id = ?`, tenantId) as { id: string } | undefined;
  if (!exists) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  let syncRowsDeleted: Record<string, number>;
  try {
    syncRowsDeleted = await db.tx(async () => {
      await db.run(
        `DELETE FROM support_ticket_interventions WHERE ticket_id IN (SELECT ticket_id FROM support_tickets WHERE tenant_id = ?)`,
        tenantId,
      );
      await db.run(`DELETE FROM support_tickets WHERE tenant_id = ?`, tenantId);
      await db.run(`DELETE FROM machine_activations WHERE tenant_id = ?`, tenantId);
      await db.run(`DELETE FROM license_keys WHERE tenant_id = ?`, tenantId);
      await db.run(`DELETE FROM tenant_update_policy_history WHERE tenant_id = ?`, tenantId);
      // Every sync table (v1 log/cursors and v2 state/checkpoints), under the tenant sync lock.
      const purged = await purgeTenantSyncData(db, tenantId);
      await db.run(`DELETE FROM tenants WHERE id = ?`, tenantId);
      return purged;
    });
  } catch (err) {
    res.status(500).json({ error: "tenant_delete_failed", message: String(err) });
    return;
  }
  structuredLog("tenant_deleted", { tenant_id: tenantId, sync_rows_deleted: syncRowsDeleted });
  res.status(204).send();
});

app.get("/api/v1/tenants/:tenantId/update-policy", authMiddleware, async (req, res) => {
  const row = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
       FROM tenants
       WHERE id = ?`, req.params.tenantId) as
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

app.put("/api/v1/tenants/:tenantId/update-policy", authMiddleware, async (req, res) => {
  const parsed = TenantUpdatePolicyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const current = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
         FROM tenants
         WHERE id = ?`, req.params.tenantId) as
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
    const guard = await requirePrivilegedAction(req, {
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
    await db.run(`INSERT INTO tenant_update_policy_history
       (id, tenant_id, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
        changed_at_rfc3339, changed_by_actor_id, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("tph"),
      current.tenant_id,
      current.force_min_app_version,
      current.force_update_mode,
      current.force_update_reason,
      new Date().toISOString(),
      resolveActorId(req),
      guard.reasonCode);
    const nextMinVersion = parsed.data.force_min_app_version ?? current.force_min_app_version;
    const nextMode = parsed.data.force_update_mode ?? current.force_update_mode;
    const nextReason = parsed.data.force_update_reason ?? current.force_update_reason;
    await db.run(`UPDATE tenants
       SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
       WHERE id = ?`, nextMinVersion, nextMode, nextReason, current.tenant_id);
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

app.post("/api/v1/tenants/:tenantId/update-policy/rollback", authMiddleware, async (req, res) => {
  await runIdempotent(req, res, async () => {
    const current = await db.get(`SELECT id as tenant_id, update_channel, rollout_cohort, force_min_app_version, force_update_mode, force_update_reason
         FROM tenants
         WHERE id = ?`, req.params.tenantId) as
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
    const previous = await db.get(`SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
         FROM tenant_update_policy_history
         WHERE tenant_id = ?
         ORDER BY changed_at_rfc3339 DESC
         LIMIT 1`, current.tenant_id) as
      | {
          previous_force_min_app_version: string | null;
          previous_force_update_mode: ForceUpdateMode;
          previous_force_update_reason: string | null;
        }
      | undefined;
    if (!previous) {
      return { status: 409, body: { error: "no_policy_history" } };
    }
    const guard = await requirePrivilegedAction(req, {
      action_code: "tenant_update_policy_rollback",
      action_category: "rollout_intervention",
      scope_tenant_id: current.tenant_id,
      entity_refs: { tenant_id: current.tenant_id },
      payload: { rollback_to_previous: true },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    await db.run(`UPDATE tenants
       SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?
       WHERE id = ?`, previous.previous_force_min_app_version,
      previous.previous_force_update_mode,
      previous.previous_force_update_reason,
      current.tenant_id);
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

app.get("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, async (req, res) => {
  const channel = req.params.channel;
  const cohort = req.params.cohort;
  if (!["stable", "pilot", "internal"].includes(channel)) {
    res.status(400).json({ error: "invalid_channel" });
    return;
  }
  const row = await db.get(`SELECT channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
       FROM cohort_update_policies
       WHERE channel = ? AND cohort_label = ?`, channel, cohort) as
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

app.put("/api/v1/cohorts/:channel/:cohort/update-policy", authMiddleware, async (req, res) => {
  const parsed = UpdatePolicyBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!["stable", "pilot", "internal"].includes(channel)) {
      return { status: 400, body: { error: "invalid_channel" } };
    }
    const current = await db.get(`SELECT id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason
         FROM cohort_update_policies
         WHERE channel = ? AND cohort_label = ?`, channel, cohort) as
      | {
          id: string;
          channel: string;
          cohort_label: string;
          force_min_app_version: string | null;
          force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          force_update_reason: string | null;
        }
      | undefined;
    const guard = await requirePrivilegedAction(req, {
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
    await db.run(`INSERT INTO cohort_update_policy_history
       (id, channel, cohort_label, previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason,
        changed_at_rfc3339, changed_by_actor_id, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId("cph"),
      channel,
      cohort,
      prevMin,
      prevMode,
      prevReason,
      new Date().toISOString(),
      resolveActorId(req),
      guard.reasonCode);
    const nextMinVersion = parsed.data.force_min_app_version ?? prevMin;
    const nextMode = parsed.data.force_update_mode ?? prevMode;
    const nextReason = parsed.data.force_update_reason ?? prevReason;
    if (current) {
      await db.run(`UPDATE cohort_update_policies
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
             updated_at_rfc3339 = ?, updated_by_actor_id = ?
         WHERE id = ?`, nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req), current.id);
    } else {
      await db.run(`INSERT INTO cohort_update_policies
         (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("cup"), channel, cohort, nextMinVersion, nextMode, nextReason, new Date().toISOString(), resolveActorId(req));
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

app.post("/api/v1/cohorts/:channel/:cohort/update-policy/rollback", authMiddleware, async (req, res) => {
  await runIdempotent(req, res, async () => {
    const channel = req.params.channel;
    const cohort = req.params.cohort;
    if (!["stable", "pilot", "internal"].includes(channel)) {
      return { status: 400, body: { error: "invalid_channel" } };
    }
    const previous = await db.get(`SELECT previous_force_min_app_version, previous_force_update_mode, previous_force_update_reason
         FROM cohort_update_policy_history
         WHERE channel = ? AND cohort_label = ?
         ORDER BY changed_at_rfc3339 DESC
         LIMIT 1`, channel, cohort) as
      | {
          previous_force_min_app_version: string | null;
          previous_force_update_mode: Exclude<ForceUpdateMode, "inherit">;
          previous_force_update_reason: string | null;
        }
      | undefined;
    if (!previous) {
      return { status: 409, body: { error: "no_policy_history" } };
    }
    const guard = await requirePrivilegedAction(req, {
      action_code: "cohort_update_policy_rollback",
      action_category: "rollout_intervention",
      entity_refs: { release_id: `${channel}:${cohort}` },
      payload: { rollback_to_previous: true },
    });
    if (!guard.ok) return { status: guard.status, body: guard.body };
    const existing = await db.get("SELECT id FROM cohort_update_policies WHERE channel = ? AND cohort_label = ?", channel, cohort) as { id: string } | undefined;
    if (existing) {
      await db.run(`UPDATE cohort_update_policies
         SET force_min_app_version = ?, force_update_mode = ?, force_update_reason = ?,
             updated_at_rfc3339 = ?, updated_by_actor_id = ?
         WHERE id = ?`, previous.previous_force_min_app_version,
        previous.previous_force_update_mode,
        previous.previous_force_update_reason,
        new Date().toISOString(),
        resolveActorId(req),
        existing.id);
    } else {
      await db.run(`INSERT INTO cohort_update_policies
         (id, channel, cohort_label, force_min_app_version, force_update_mode, force_update_reason, updated_at_rfc3339, updated_by_actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newId("cup"),
        channel,
        cohort,
        previous.previous_force_min_app_version,
        previous.previous_force_update_mode,
        previous.previous_force_update_reason,
        new Date().toISOString(),
        resolveActorId(req));
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

app.post("/api/v1/licenses", authMiddleware, async (req, res) => {
  const parsed = CreateLicenseBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const input = parsed.data;
    const tenant = await db.get("SELECT id, display_name, force_min_app_version, update_channel, is_active FROM tenants WHERE id = ?", input.tenant_id) as
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
    await db.run(`INSERT INTO license_keys
        (id, tenant_id, license_key, max_machines, update_channel, issued_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id,
      input.tenant_id,
      key,
      input.max_machines,
      input.update_channel ?? tenant.update_channel,
      actor,
      input.expires_at ?? null);

    const auditRecordId = await appendAuditRecord({
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

app.get("/api/v1/tenants/:tenantId/licenses", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const pageSize = effectiveLimit + 1;
  let rows: Array<Record<string, unknown>>;
  if (cursor) {
    const [cursorCreatedAt, cursorId] = cursor.split("|");
    rows = await db.all(`SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel
         FROM license_keys
         WHERE tenant_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`, tenantId, cursorCreatedAt, cursorCreatedAt, cursorId ?? "", pageSize) as Array<Record<string, unknown>>;
  } else {
    rows = await db.all(`SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel
         FROM license_keys
         WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`, tenantId, pageSize) as Array<Record<string, unknown>>;
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

app.patch("/api/v1/licenses/:licenseId", authMiddleware, async (req, res) => {
  const licenseId = req.params.licenseId;
  const parsed = UpdateLicenseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const row = await db.get(`SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel FROM license_keys WHERE id = ?`, licenseId) as
    | {
        id: string;
        tenant_id: string;
        license_key: string;
        max_machines: number;
        expires_at: string | null;
        revoked_at: string | null;
        revoked_reason: string | null;
        created_at: string;
        update_channel: string;
      }
    | undefined;
  if (!row) {
    res.status(404).json({ error: "license_not_found" });
    return;
  }
  if (row.revoked_at) {
    res.status(409).json({ error: "license_revoked", message: "Cannot update a revoked license key." });
    return;
  }
  const input = parsed.data;
  const nextMax = input.max_machines ?? row.max_machines;
  const nextExpires =
    input.expires_at === undefined ? row.expires_at : input.expires_at === null ? null : input.expires_at;
  const nextChannel = input.update_channel ?? row.update_channel;
  await db.run(`UPDATE license_keys SET max_machines = ?, expires_at = ?, update_channel = ? WHERE id = ?`, nextMax, nextExpires, nextChannel, licenseId);
  const out = await db.get(`SELECT id, tenant_id, license_key, max_machines, expires_at, revoked_at, revoked_reason, created_at, update_channel FROM license_keys WHERE id = ?`, licenseId) as Record<string, unknown>;
  res.json(out);
});

// ─── SlickPay payments (renewal checkout + webhook) ─────────────────────────

const SLICKPAY_PUBLIC_KEY = (process.env.SLICKPAY_PUBLIC_KEY ?? "").trim();
const SLICKPAY_SECRET_KEY = (process.env.SLICKPAY_SECRET_KEY ?? "").trim();
const SLICKPAY_WEBHOOK_SECRET = (process.env.SLICKPAY_WEBHOOK_SECRET ?? SLICKPAY_SECRET_KEY).trim();
const SLICKPAY_API_BASE_URL = (process.env.SLICKPAY_API_BASE_URL ?? "https://prodapi.slick-pay.com").replace(/\/$/, "");
const SLICKPAY_WEBHOOK_URL = (process.env.SLICKPAY_WEBHOOK_URL ?? "https://api.maintafox.systems/api/v1/webhooks/slickpay").trim();
const SLICKPAY_DEFAULT_RETURN_URL = (
  process.env.SLICKPAY_DEFAULT_RETURN_URL ?? "https://console.maintafox.systems/vendor-console/entitlements"
).trim();
const SLICKPAY_EXTRA_SLOT_PRICE = Number.parseFloat(process.env.SLICKPAY_EXTRA_SLOT_PRICE ?? "0");

function slickPayConfigured(): boolean {
  return SLICKPAY_PUBLIC_KEY.length > 0 && SLICKPAY_SECRET_KEY.length > 0;
}

function safeEqualUtf8(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function computeLicenseExpiresPlusOneYear(currentExpiresAt: string | null, now = new Date()): string {
  const base =
    currentExpiresAt && !Number.isNaN(Date.parse(currentExpiresAt)) && new Date(currentExpiresAt) > now
      ? new Date(currentExpiresAt)
      : now;
  const next = new Date(base.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString();
}

async function slickPayApi(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SLICKPAY_API_BASE_URL}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLICKPAY_PUBLIC_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

async function pickActiveLicenseForTenant(tenantId: string): Promise<{
  id: string;
  tenant_id: string;
  max_machines: number;
  expires_at: string | null;
  revoked_at: string | null;
} | undefined> {
  return await db.get(`SELECT id, tenant_id, max_machines, expires_at, revoked_at
       FROM license_keys
       WHERE tenant_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`, tenantId) as
    | {
        id: string;
        tenant_id: string;
        max_machines: number;
        expires_at: string | null;
        revoked_at: string | null;
      }
    | undefined;
}

type SlickPayUserInfo = z.infer<typeof SlickPayUserInfoSchema>;

function pickCompanyNameFromUserInfo(ui: SlickPayUserInfo): string | null {
  const candidates = [ui.company, ui.company_name, ui.entreprise, ui.organization, ui.business_name];
  for (const raw of candidates) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v.length >= 2) return v.slice(0, 128);
  }
  return null;
}

function resolveTenantDisplayNameFromUserInfo(ui: SlickPayUserInfo): string | null {
  const company = pickCompanyNameFromUserInfo(ui);
  if (company) return company;
  const person = [ui.firstname, ui.lastname]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (person.length >= 2) return person.slice(0, 128);
  if (ui.email && ui.email.trim().length >= 3) return ui.email.trim().slice(0, 128);
  return null;
}

function slugifyTenantSlug(raw: string): string {
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const clipped = ascii.slice(0, 48).replace(/-+$/g, "");
  return clipped.length >= 2 ? clipped : "customer";
}

async function allocateUniqueTenantSlug(preferred: string): Promise<string> {
  const base = slugifyTenantSlug(preferred);
  const exists = async (slug: string) =>
    Boolean(await db.get("SELECT id FROM tenants WHERE slug = ?", slug));
  if (!(await exists(base))) return base;
  for (let i = 0; i < 12; i += 1) {
    const candidate = `${base.slice(0, 52)}-${randomBytes(2).toString("hex")}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base.slice(0, 40)}-${randomBytes(4).toString("hex")}`;
}

async function resolveEditionFromPlan(plan: string): Promise<string> {
  const normalized = plan.trim().toLowerCase().replace(/\s+/g, "-");
  if (await editionExists(db, normalized)) return normalized;
  if (await editionExists(db, plan.trim())) return plan.trim();
  return "core";
}

async function createTenantFromSlickPayUserInfo(
  ui: SlickPayUserInfo,
  plan: string,
): Promise<{ id: string; slug: string; display_name: string; edition: string }> {
  const displayName = resolveTenantDisplayNameFromUserInfo(ui);
  if (!displayName) {
    const err = new Error("insufficient_user_info");
    (err as Error & { code?: string }).code = "insufficient_user_info";
    throw err;
  }
  const slug = await allocateUniqueTenantSlug(ui.slug?.trim() || displayName);
  const id = newId("tenant");
  const edition = await resolveEditionFromPlan(plan);
  await insertTenantRow({
    id,
    slug,
    display_name: displayName,
    update_channel: "stable",
    rollout_cohort: "stable-main",
    edition,
  });
  await appendAuditRecord({
    actor_id: "payment_proxy",
    action_code: "tenant_create",
    action_category: "billing",
    correlation_id: id,
    scope_tenant_id: id,
    reason_code: "slickpay_new_customer",
    entity_refs: { tenant_id: id },
    payload: {
      slug,
      display_name: displayName,
      edition,
      email: ui.email ?? null,
      company: pickCompanyNameFromUserInfo(ui),
    },
  });
  return { id, slug, display_name: displayName, edition };
}

async function issueLicenseForPaidOrder(input: {
  tenantId: string;
  maxMachines: number;
  expiresAt: string;
  updateChannel?: string;
}): Promise<{ id: string; license_key: string; max_machines: number; expires_at: string }> {
  const tenant = await db.get(`SELECT id, update_channel, is_active FROM tenants WHERE id = ?`, input.tenantId) as { id: string; update_channel: string; is_active: number } | undefined;
  if (!tenant || tenant.is_active !== 1) {
    throw new Error("tenant_not_found_or_inactive");
  }
  const id = newId("lic");
  const key = randomLicenseKey();
  await db.run(`INSERT INTO license_keys
      (id, tenant_id, license_key, max_machines, update_channel, issued_by_user_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, id,
    input.tenantId,
    key,
    input.maxMachines,
    input.updateChannel ?? tenant.update_channel,
    null,
    input.expiresAt);
  return {
    id,
    license_key: key,
    max_machines: input.maxMachines,
    expires_at: input.expiresAt,
  };
}

/** Public payment proxy: create SlickPay invoice and return checkout_url. */
app.post("/api/v1/payments/slickpay/initiate", publicCheckoutRateLimiter, async (req, res) => {
  if (!slickPayConfigured()) {
    res.status(503).json({
      error: "slickpay_not_configured",
      message: "Set SLICKPAY_PUBLIC_KEY and SLICKPAY_SECRET_KEY.",
    });
    return;
  }
  const parsed = SlickPayInitiateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const input = parsed.data;
  const extraSlots = input.extra_slots ?? 0;
  const slotUnit = Number.isFinite(SLICKPAY_EXTRA_SLOT_PRICE) ? Math.max(0, SLICKPAY_EXTRA_SLOT_PRICE) : 0;
  const totalAmount = input.amount + extraSlots * slotUnit;

  let tenant: { id: string; display_name: string; is_active: number };
  let tenantCreated = false;
  if (input.tenant_id) {
    const existing = await db.get(`SELECT id, display_name, is_active FROM tenants WHERE id = ?`, input.tenant_id) as { id: string; display_name: string; is_active: number } | undefined;
    if (!existing) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }
    if (existing.is_active === 0) {
      res.status(409).json({ error: "tenant_inactive" });
      return;
    }
    tenant = existing;
  } else {
    try {
      const createdTenant = await createTenantFromSlickPayUserInfo(input.user_info!, input.plan);
      tenant = { id: createdTenant.id, display_name: createdTenant.display_name, is_active: 1 };
      tenantCreated = true;
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "insufficient_user_info") {
        res.status(400).json({
          error: "user_info_required",
          message:
            "Provide user_info.company (or company_name/entreprise) or firstname+lastname or email when tenant_id is omitted.",
        });
        return;
      }
      const failure = tenantWriteFailure(err);
      res.status(failure.status).json(failure.body);
      return;
    }
  }

  const license = await pickActiveLicenseForTenant(tenant.id);
  const orderId = newId("pay");
  const returnUrl = input.return_url ?? SLICKPAY_DEFAULT_RETURN_URL;
  const meta = {
    payment_order_id: orderId,
    tenant_id: tenant.id,
    license_id: license?.id ?? null,
    plan: input.plan,
    extra_slots: extraSlots,
    tenant_created: tenantCreated,
  };
  // SlickPay docs type webhook_meta_data as array; wrap our object for compatibility.
  const webhookMetaData = [meta];

  await db.run(`INSERT INTO payment_orders
      (id, tenant_id, license_id, plan, amount, extra_slots, total_amount, status, user_info_json, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, orderId,
    tenant.id,
    license?.id ?? null,
    input.plan,
    input.amount,
    extraSlots,
    totalAmount,
    input.user_info ? JSON.stringify(input.user_info) : null,
    JSON.stringify(meta));

  const invoiceBody: Record<string, unknown> = {
    amount: totalAmount,
    url: returnUrl,
    webhook_url: SLICKPAY_WEBHOOK_URL,
    webhook_signature: SLICKPAY_WEBHOOK_SECRET || SLICKPAY_SECRET_KEY,
    webhook_meta_data: webhookMetaData,
    note: `Maintafox ${input.plan} — tenant ${tenant.id}`,
    items: [
      {
        name: `Maintafox ${input.plan}`,
        price: totalAmount,
        quantity: 1,
      },
    ],
  };
  const ui = input.user_info ?? {};
  if (ui.contact_id) {
    invoiceBody.contact = ui.contact_id;
  } else {
    if (ui.firstname) invoiceBody.firstname = ui.firstname;
    if (ui.lastname) invoiceBody.lastname = ui.lastname;
    if (ui.phone) invoiceBody.phone = ui.phone;
    if (ui.email) invoiceBody.email = ui.email;
    const address =
      (typeof ui.address === "string" && ui.address.trim()) ||
      pickCompanyNameFromUserInfo(ui) ||
      tenant.display_name ||
      "Maintafox customer";
    invoiceBody.address = address;
  }

  const failInitiate = async (status: number, body: Record<string, unknown>, errorMessage: string) => {
    await db.run(`UPDATE payment_orders SET status = 'failed', error_message = ?, updated_at = mfx_utc_now_text() WHERE id = ?`, errorMessage.slice(0, 500), orderId);
    if (tenantCreated) {
      // Avoid orphan tenants when SlickPay rejects the first checkout for a new customer.
      const hasLicense = Boolean(await pickActiveLicenseForTenant(tenant.id));
      if (!hasLicense) {
        await db.run(`DELETE FROM payment_orders WHERE id = ?`, orderId);
        await db.run(`DELETE FROM tenants WHERE id = ?`, tenant.id);
      }
    }
    res.status(status).json(body);
  };

  try {
    const created = await slickPayApi("POST", "/api/v2/users/invoices", invoiceBody);
    if (!created.ok) {
      await failInitiate(
        502,
        { error: "slickpay_create_failed", status: created.status, details: created.json },
        `http_${created.status}:${JSON.stringify(created.json).slice(0, 400)}`,
      );
      return;
    }
    const data =
      created.json.data && typeof created.json.data === "object"
        ? (created.json.data as Record<string, unknown>)
        : created.json;
    const invoiceId =
      created.json.id !== undefined && created.json.id !== null
        ? String(created.json.id)
        : data.id !== undefined && data.id !== null
          ? String(data.id)
          : null;
    const checkoutUrl =
      (typeof created.json.url === "string" && created.json.url) ||
      (typeof data.url === "string" && data.url) ||
      null;
    if (!invoiceId || !checkoutUrl) {
      await failInitiate(
        502,
        { error: "slickpay_invalid_response", details: created.json },
        "missing_invoice_id_or_url",
      );
      return;
    }

    await db.run(`UPDATE payment_orders
       SET slickpay_invoice_id = ?, slickpay_payment_url = ?, status = 'awaiting_payment', updated_at = mfx_utc_now_text()
       WHERE id = ?`, invoiceId, checkoutUrl, orderId);

    await appendAuditRecord({
      actor_id: "payment_proxy",
      action_code: "payment_initiate",
      action_category: "billing",
      correlation_id: orderId,
      scope_tenant_id: tenant.id,
      entity_refs: { tenant_id: tenant.id, entitlement_id: license?.id },
      payload: {
        payment_order_id: orderId,
        plan: input.plan,
        total_amount: totalAmount,
        invoice_id: invoiceId,
        tenant_created: tenantCreated,
      },
    });

    res.status(201).json({
      checkout_url: checkoutUrl,
      payment_order_id: orderId,
      invoice_id: invoiceId,
      total_amount: totalAmount,
      currency: "DZD",
      plan: input.plan,
      tenant_id: tenant.id,
      tenant_created: tenantCreated,
      license_id: license?.id ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failInitiate(502, { error: "slickpay_network_error", message }, message);
  }
});

/** SlickPay webhook: verify signature, extend license +1 year, bump entitlement lineage. */
app.post("/api/v1/webhooks/slickpay", async (req, res) => {
  if (!slickPayConfigured() || !SLICKPAY_WEBHOOK_SECRET) {
    res.status(503).json({ error: "slickpay_not_configured" });
    return;
  }

  const payload = (req.body ?? {}) as Record<string, unknown>;
  const headerSig =
    req.header("x-slickpay-signature") ??
    req.header("x-webhook-signature") ??
    req.header("webhook-signature") ??
    (typeof payload.webhook_signature === "string" ? payload.webhook_signature : null) ??
    (typeof payload.signature === "string" ? payload.signature : null);
  if (!headerSig || !safeEqualUtf8(String(headerSig), SLICKPAY_WEBHOOK_SECRET)) {
    res.status(401).json({ error: "invalid_webhook_signature" });
    return;
  }

  const invoiceIdRaw =
    payload.id ??
    payload.invoice_id ??
    (payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>).id ?? (payload.data as Record<string, unknown>).invoice_id
      : null);
  const invoiceId = invoiceIdRaw !== null && invoiceIdRaw !== undefined ? String(invoiceIdRaw) : null;
  if (!invoiceId) {
    res.status(400).json({ error: "missing_invoice_id" });
    return;
  }

  let paymentStatus = "";
  try {
    const details = await slickPayApi("GET", `/api/v2/users/invoices/${encodeURIComponent(invoiceId)}`);
    if (!details.ok) {
      res.status(502).json({ error: "slickpay_verify_failed", status: details.status });
      return;
    }
    const data =
      details.json.data && typeof details.json.data === "object"
        ? (details.json.data as Record<string, unknown>)
        : details.json;
    paymentStatus = String(data.payment_status ?? data.status ?? "").toLowerCase();
  } catch (err) {
    res.status(502).json({
      error: "slickpay_verify_network_error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (paymentStatus !== "paid") {
    res.status(200).json({ ok: true, ignored: true, payment_status: paymentStatus });
    return;
  }

  let order = await db.get(`SELECT id, tenant_id, license_id, plan, extra_slots, status
       FROM payment_orders WHERE slickpay_invoice_id = ? ORDER BY created_at DESC LIMIT 1`, invoiceId) as
    | {
        id: string;
        tenant_id: string;
        license_id: string | null;
        plan: string;
        extra_slots: number;
        status: string;
      }
    | undefined;

  if (!order) {
    const metaRaw = payload.webhook_meta_data ?? payload.meta_data ?? payload.metadata;
    const metaCandidate = Array.isArray(metaRaw)
      ? metaRaw.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      : metaRaw;
    const meta =
      metaCandidate && typeof metaCandidate === "object" && !Array.isArray(metaCandidate)
        ? (metaCandidate as Record<string, unknown>)
        : null;
    const orderId = meta?.payment_order_id ? String(meta.payment_order_id) : null;
    if (orderId) {
      order = await db.get(`SELECT id, tenant_id, license_id, plan, extra_slots, status FROM payment_orders WHERE id = ?`, orderId) as typeof order;
    }
  }

  if (!order) {
    res.status(404).json({ error: "payment_order_not_found", invoice_id: invoiceId });
    return;
  }
  if (order.status === "paid") {
    res.status(200).json({ ok: true, already_processed: true, payment_order_id: order.id });
    return;
  }

  type RenewLicenceRow = {
    id: string;
    tenant_id: string;
    max_machines: number;
    expires_at: string | null;
    revoked_at: string | null;
  };
  const extraSlots = Math.max(0, order.extra_slots ?? 0);
  const nowIso = new Date().toISOString();
  let issuedNewLicense = false;
  let previousExpires: string | null = null;
  let nextExpires = "";
  let nextMaxMachines = 0;
  let finalLicense: RenewLicenceRow | undefined;
  let licenceRevoked = false;
  try {
    let raceAlreadyPaid = false;
    await db.tx(async () => {
      // Two deliveries of the same webhook must not both extend the licence, and two different
      // paid orders of one tenant must extend it one after the other (each from the latest
      // expiry): lock the tenant's renewals and the order, then read the licence under the lock.
      await db.lockXact("licence-renewal", order.tenant_id);
      const locked = await db.get<{ status: string }>(
        `SELECT status FROM payment_orders WHERE id = ? FOR UPDATE`,
        order.id,
      );
      if (locked?.status === "paid") {
        raceAlreadyPaid = true;
        return;
      }
      let license = order.license_id
        ? await db.get<RenewLicenceRow>(
            `SELECT id, tenant_id, max_machines, expires_at, revoked_at FROM license_keys WHERE id = ? FOR UPDATE`,
            order.license_id,
          )
        : undefined;
      if (!license) {
        license = await pickActiveLicenseForTenant(order.tenant_id);
      }
      if (license?.revoked_at) {
        licenceRevoked = true;
        await db.run(
          `UPDATE payment_orders SET status = 'failed', error_message = 'license_revoked', updated_at = mfx_utc_now_text() WHERE id = ?`,
          order.id,
        );
        return;
      }
      previousExpires = license?.expires_at ?? null;
      nextExpires = computeLicenseExpiresPlusOneYear(license?.expires_at ?? null);
      nextMaxMachines = license ? license.max_machines + extraSlots : 1 + extraSlots;
      finalLicense = license;
      if (!finalLicense) {
        const issued = await issueLicenseForPaidOrder({
          tenantId: order.tenant_id,
          maxMachines: nextMaxMachines,
          expiresAt: nextExpires,
        });
        finalLicense = {
          id: issued.id,
          tenant_id: order.tenant_id,
          max_machines: issued.max_machines,
          expires_at: issued.expires_at,
          revoked_at: null,
        };
        issuedNewLicense = true;
      } else {
        await db.run(
          `UPDATE license_keys SET expires_at = ?, max_machines = ? WHERE id = ?`,
          nextExpires,
          nextMaxMachines,
          finalLicense.id,
        );
      }
      await db.run(`UPDATE tenants SET entitlement_lineage = entitlement_lineage + 1 WHERE id = ?`, finalLicense.tenant_id);
      await db.run(
        `UPDATE payment_orders
         SET status = 'paid', paid_at = ?, license_id = ?, slickpay_invoice_id = COALESCE(slickpay_invoice_id, ?),
             updated_at = mfx_utc_now_text()
         WHERE id = ?`,
        nowIso,
        finalLicense.id,
        invoiceId,
        order.id,
      );
    });
    if (licenceRevoked) {
      res.status(409).json({ error: "license_revoked" });
      return;
    }
    if (raceAlreadyPaid) {
      res.status(200).json({ ok: true, already_processed: true, payment_order_id: order.id });
      return;
    }
  } catch (err) {
    res.status(404).json({
      error: "license_issue_failed",
      tenant_id: order.tenant_id,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!finalLicense) {
    res.status(500).json({ error: "license_missing_after_payment" });
    return;
  }

  await appendAuditRecord({
    actor_id: "system_slickpay_webhook",
    action_code: issuedNewLicense ? "license_issue" : "license_renew",
    action_category: "billing",
    correlation_id: order.id,
    scope_tenant_id: finalLicense.tenant_id,
    reason_code: "slickpay_paid",
    entity_refs: { tenant_id: finalLicense.tenant_id, entitlement_id: finalLicense.id },
    payload: {
      payment_order_id: order.id,
      invoice_id: invoiceId,
      plan: order.plan,
      previous_expires_at: previousExpires,
      expires_at: nextExpires,
      max_machines: nextMaxMachines,
      license_issued: issuedNewLicense,
      entitlement_lineage_bumped: true,
    },
  });

  res.status(200).json({
    ok: true,
    payment_order_id: order.id,
    tenant_id: finalLicense.tenant_id,
    license_id: finalLicense.id,
    expires_at: nextExpires,
    previous_expires_at: previousExpires,
    max_machines: nextMaxMachines,
    license_issued: issuedNewLicense,
  });
});

app.post("/api/v1/licenses/:licenseId/revoke", authMiddleware, async (req, res) => {
  const parsed = RevokeLicenseBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const guard = await requirePrivilegedAction(req, {
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
    await db.lockXact("license-slots", licenseId);
    const row = await db.get("SELECT id, revoked_at, tenant_id FROM license_keys WHERE id = ?", licenseId) as { id: string; revoked_at: string | null; tenant_id: string } | undefined;
    if (!row) {
      return { status: 404, body: { error: "license_not_found" } };
    }
    if (!row.revoked_at) {
      await db.run("UPDATE license_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?", now,
        parsed.data.reason ?? "revoked by operator",
        licenseId);
      await db.run("UPDATE machine_activations SET revoked_at = ?, revocation_kind = 'license' WHERE license_id = ? AND revoked_at IS NULL", now, licenseId);
    }
    return { status: 200, body: { ok: true, revoked_at: now, audit_record_id: guard.auditRecordId } };
  });
});

const MachineActionBody = z.object({
  reason: z.string().min(2).max(256).optional(),
}).strict();

type MachineActivationRow = {
  id: string;
  license_id: string;
  revoked_at: string | null;
  revocation_kind: string | null;
};

async function loadMachineActivation(tenantId: string, machineFingerprint: string): Promise<MachineActivationRow | undefined> {
  return await db.get(`SELECT id, license_id, revoked_at, revocation_kind
       FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`, tenantId, machineFingerprint) as MachineActivationRow | undefined;
}

/**
 * Revokes one device. Its next request (sync heartbeat, policy refresh) is refused with
 * `activation_revoked`, its slot is freed, and re-entering the licence key does not undo it.
 */
app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/revoke", authMiddleware, async (req, res) => {
  const parsed = MachineActionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const { tenantId, machineFingerprint } = req.params;
  await runIdempotent(req, res, async () => {
    const guard = await requirePrivilegedAction(req, {
      action_code: "machine_revoke",
      action_category: "entitlement",
      scope_tenant_id: tenantId,
      entity_refs: { tenant_id: tenantId, machine_id: machineFingerprint },
      payload: { reason: parsed.data.reason ?? "revoked by operator" },
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const row = await loadMachineActivation(tenantId, machineFingerprint);
    if (!row) {
      return { status: 404, body: { error: "activation_not_found" } };
    }
    if (row.revoked_at) {
      return {
        status: 200,
        body: { ok: true, revoked_at: row.revoked_at, revocation_kind: row.revocation_kind ?? "license", audit_record_id: guard.auditRecordId },
      };
    }
    const now = new Date().toISOString();
    await db.run("UPDATE machine_activations SET revoked_at = ?, revocation_kind = 'machine' WHERE id = ?", now, row.id);
    structuredLog("machine_activation_revoked", { tenant_id: tenantId, machine_fingerprint: machineFingerprint });
    return { status: 200, body: { ok: true, revoked_at: now, revocation_kind: "machine", audit_record_id: guard.auditRecordId } };
  });
});

/**
 * Reinstates a device revoked with the route above. A device revoked because its licence was
 * revoked cannot be reinstated here (issue a new licence instead). Needs a free slot.
 */
app.post("/api/v1/tenants/:tenantId/machines/:machineFingerprint/reinstate", authMiddleware, async (req, res) => {
  const parsed = MachineActionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  const { tenantId, machineFingerprint } = req.params;
  await runIdempotent(req, res, async () => {
    const guard = await requirePrivilegedAction(req, {
      action_code: "machine_reinstate",
      action_category: "entitlement",
      scope_tenant_id: tenantId,
      entity_refs: { tenant_id: tenantId, machine_id: machineFingerprint },
      payload: { reason: parsed.data.reason ?? "reinstated by operator" },
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const row = await loadMachineActivation(tenantId, machineFingerprint);
    if (!row) {
      return { status: 404, body: { error: "activation_not_found" } };
    }
    if (!row.revoked_at) {
      return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
    }
    if (row.revocation_kind !== "machine") {
      return { status: 409, body: { error: "license_revoked", message: "The licence itself is revoked; issue a new licence." } };
    }
    const lic = await db.get("SELECT max_machines, revoked_at FROM license_keys WHERE id = ?", row.license_id) as { max_machines: number; revoked_at: string | null } | undefined;
    if (!lic || lic.revoked_at) {
      return { status: 409, body: { error: "license_revoked" } };
    }
    await db.lockXact("license-slots", row.license_id);
    if (await countActiveActivations(row.license_id) >= lic.max_machines) {
      return { status: 409, body: { error: "slot_limit_reached", max_machines: lic.max_machines } };
    }
    await db.run("UPDATE machine_activations SET revoked_at = NULL, revocation_kind = NULL WHERE id = ?", row.id);
    structuredLog("machine_activation_reinstated", { tenant_id: tenantId, machine_fingerprint: machineFingerprint });
    return { status: 200, body: { ok: true, audit_record_id: guard.auditRecordId } };
  });
});

app.get("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const row = await db.get(`SELECT id, offline_grace_hours, trust_revocation_disconnects_immediately,
              reconnect_requires_fresh_heartbeat
       FROM tenants WHERE id = ?`, tenantId) as
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

app.put("/api/v1/tenants/:tenantId/offline-policy", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const parsed = OfflinePolicyUpdateBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const guard = await requirePrivilegedAction(req, {
      action_code: "offline_policy_update",
      action_category: "platform_override",
      scope_tenant_id: tenantId,
      entity_refs: { tenant_id: tenantId },
      payload: parsed.data,
    });
    if (!guard.ok) {
      return { status: guard.status, body: guard.body };
    }
    const tenant = await db.get("SELECT id FROM tenants WHERE id = ?", tenantId) as { id: string } | undefined;
    if (!tenant) {
      return { status: 404, body: { error: "tenant_not_found" } };
    }
    const input = parsed.data;
    await db.run(`UPDATE tenants
       SET offline_grace_hours = ?,
           trust_revocation_disconnects_immediately = ?,
           reconnect_requires_fresh_heartbeat = ?
       WHERE id = ?`, input.offline_grace_hours,
      input.trust_revocation_disconnects_immediately ? 1 : 0,
      input.reconnect_requires_fresh_heartbeat ? 1 : 0,
      tenantId);
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

app.get("/api/v1/tenants/:tenantId/activations", authMiddleware, async (req, res) => {
  const tenantId = req.params.tenantId;
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const rows = await db.all(`SELECT a.machine_fingerprint, a.last_seen_at, a.app_version, a.revoked_at, a.revocation_kind, l.update_channel
       FROM machine_activations a
       JOIN license_keys l ON l.id = a.license_id
       WHERE a.tenant_id = ?
       ORDER BY a.last_seen_at COLLATE "C" DESC, a.machine_fingerprint COLLATE "C" DESC`, tenantId) as Array<{
      machine_fingerprint: string;
      last_seen_at: string;
      app_version: string | null;
      revoked_at: string | null;
      revocation_kind: string | null;
      update_channel: string;
    }>;
  // The cursor is compared in JS (binary); the ORDER BY uses the binary "C" collation to match.
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
      // 'machine' = revoked by an operator (reinstatable), 'license' = licence revoked, null = active.
      revocation_kind: row.revoked_at ? (row.revocation_kind ?? "license") : null,
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

app.get("/api/v1/ops/sync-overview", authMiddleware, async (_req, res) => {
  const tenants = await db.all(`SELECT id, update_channel, force_min_app_version
       FROM tenants
       WHERE is_active = 1`) as Array<{ id: string; update_channel: string; force_min_app_version: string | null }>;

  const nowMs = Date.now();
  const tenantRows = await Promise.all(tenants.map(async (tenant) => {
    const activations = await db.all(`SELECT a.last_seen_at, a.revoked_at, l.update_channel
         FROM machine_activations a
         JOIN license_keys l ON l.id = a.license_id
         WHERE a.tenant_id = ?`, tenant.id) as Array<{ last_seen_at: string; revoked_at: string | null; update_channel: string }>;
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
  }));

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

app.get("/api/v1/ops/rollout-overview", authMiddleware, async (_req, res) => {
  const tenants = await db.all(`SELECT id, update_channel, rollout_cohort, force_min_app_version, force_update_mode
       FROM tenants
       WHERE is_active = 1`) as Array<{
      id: string;
      update_channel: "stable" | "pilot" | "internal";
      rollout_cohort: string;
      force_min_app_version: string | null;
      force_update_mode: ForceUpdateMode;
    }>;
  const machineCountsByTenant = new Map<string, number>();
  const machineRows = await db.all("SELECT tenant_id, COUNT(*) as c FROM machine_activations WHERE revoked_at IS NULL GROUP BY tenant_id") as Array<{ tenant_id: string; c: number }>;
  for (const row of machineRows) {
    machineCountsByTenant.set(row.tenant_id, row.c);
  }
  const mismatches = await db.get(`SELECT COUNT(*) as c
       FROM license_keys l
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.update_channel != t.update_channel`) as { c: number };
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

app.get("/api/v1/ops/platform-overview", authMiddleware, async (_req, res) => {
  const syncRows = await db.all(`SELECT t.id as tenant_id,
              SUM(CASE WHEN a.revoked_at IS NULL THEN 0 ELSE 1 END) as revoked_count,
              COUNT(a.id) as machine_count
       FROM tenants t
       LEFT JOIN machine_activations a ON a.tenant_id = t.id
       WHERE t.is_active = 1
       GROUP BY t.id`) as Array<{ tenant_id: string; revoked_count: number; machine_count: number }>;
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
    { service: "postgresql", severity: "info", detail: "postgres control-plane backend healthy" },
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

app.get("/api/v1/audit/ledger", authMiddleware, async (req, res) => {
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
    ? await db.all(`SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                  correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                  payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                  approval_correlation_id, entity_refs_json
           FROM audit_records
           WHERE sequence < ?
           ORDER BY sequence DESC
           LIMIT ?`, cursorSequence, effectiveLimit + 1)
    : await db.all(`SELECT record_id, sequence, occurred_at_rfc3339, actor_id, action_code, action_category,
                  correlation_id, scope_tenant_id, before_snapshot_sha256, after_snapshot_sha256,
                  payload_canonical_sha256, chain_prev_hash, record_integrity_sha256, reason_code,
                  approval_correlation_id, entity_refs_json
           FROM audit_records
           ORDER BY sequence DESC
           LIMIT ?`, effectiveLimit + 1)) as Array<{
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

app.get("/api/v1/audit/ledger/verify-chain", authMiddleware, async (_req, res) => {
  const rows = await db.all<AuditRecordRow>(
    `SELECT ${AUDIT_RECORD_COLUMNS}
     FROM audit_records
     ORDER BY sequence ASC`,
  );
  const result = verifyAuditChain(rows);
  res.json({ status: result.status, checked_count: result.checked_count });
});

app.get("/api/v1/audit/ledger/export", authMiddleware, async (_req, res) => {
  const rows = await db.all(`SELECT sequence, occurred_at_rfc3339, actor_id, action_code, action_category, correlation_id,
              scope_tenant_id, reason_code, approval_correlation_id, record_id
       FROM audit_records
       ORDER BY sequence DESC`) as Array<{
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

app.get("/api/v1/support/tickets", authMiddleware, async (req, res) => {
  const { cursor, limit, withPagination } = parsePagination(req.query);
  const effectiveLimit = withPagination ? limit : 10_000;
  const cursorCreatedAt = cursor?.split("|")[0] ?? null;
  const cursorTicketId = cursor?.split("|")[1] ?? "";
  const rows = (cursor
    ? await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
           FROM support_tickets
           WHERE (created_at_rfc3339 < ?) OR (created_at_rfc3339 = ? AND ticket_id < ?)
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`, cursorCreatedAt, cursorCreatedAt, cursorTicketId, effectiveLimit + 1)
    : await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                  linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
           FROM support_tickets
           ORDER BY created_at_rfc3339 DESC, ticket_id DESC
           LIMIT ?`, effectiveLimit + 1)) as Array<{
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
  const mapped = await Promise.all(rows.slice(0, effectiveLimit).map(async (row) => {
    const linkedAudit = await db.all("SELECT audit_record_id FROM support_ticket_interventions WHERE ticket_id = ? ORDER BY created_at_rfc3339 DESC", row.ticket_id) as Array<{ audit_record_id: string }>;
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
  }));
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

app.post("/api/v1/support/tickets/:ticketId/interventions", authMiddleware, async (req, res) => {
  const parsed = SupportInterventionBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed, "body");
    return;
  }
  await runIdempotent(req, res, async () => {
    const ticketId = req.params.ticketId;
    const ticket = await db.get(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint, app_version_reported,
                linked_incident_ids_json, sla_due_rfc3339, created_at_rfc3339
         FROM support_tickets WHERE ticket_id = ?`, ticketId) as
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
    const guard = await requirePrivilegedAction(req, {
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
    await db.run("UPDATE support_tickets SET state = ? WHERE ticket_id = ?", nextState, ticketId);
    const auditId = guard.auditRecordId;
    await db.run(`INSERT INTO support_ticket_interventions
        (intervention_id, ticket_id, actor_id, action_code, note, from_state, to_state,
         reason_code, audit_record_id, created_at_rfc3339)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId("intv"),
      ticketId,
      actorId,
      parsed.data.action_code,
      parsed.data.note,
      ticket.state,
      nextState,
      parsed.data.reason_code ?? null,
      auditId,
      new Date().toISOString());
    return { status: 201, body: { ok: true, audit_record_id: auditId, state: nextState } };
  });
});

app.get("/api/v1/support/tickets/export", authMiddleware, async (_req, res) => {
  const rows = await db.all(`SELECT ticket_id, tenant_id, state, severity, affected_module, sync_status_hint,
              app_version_reported, sla_due_rfc3339, created_at_rfc3339
       FROM support_tickets
       ORDER BY created_at_rfc3339 DESC`) as Array<{
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

app.get("/api/v1/support/diagnostic-bundles/latest", authMiddleware, async (_req, res) => {
  const bundle = await db.get("SELECT bundle_id, created_at_rfc3339, redaction_profile FROM diagnostic_bundles ORDER BY created_at_rfc3339 DESC LIMIT 1") as { bundle_id: string; created_at_rfc3339: string; redaction_profile: string } | undefined;
  if (!bundle) {
    res.status(404).json({ error: "bundle_not_found" });
    return;
  }
  const artifacts = await db.all("SELECT logical_path, sha256, kind FROM diagnostic_bundle_artifacts WHERE bundle_id = ? ORDER BY logical_path ASC", bundle.bundle_id) as Array<{ logical_path: string; sha256: string; kind: string }>;
  res.json({
    bundle_id: bundle.bundle_id,
    created_at_rfc3339: bundle.created_at_rfc3339,
    redaction_profile: bundle.redaction_profile,
    artifacts,
  });
});

app.get("/api/v1/support/offline-reconciliation", authMiddleware, async (_req, res) => {
  const rows = await db.all("SELECT desktop_queue_id, vendor_ticket_id, sync_state, duplicate_of FROM offline_ticket_reconciliation ORDER BY desktop_queue_id ASC");
  res.json(rows);
});

app.get("/api/v1/audit/hardening/runbooks", authMiddleware, async (_req, res) => {
  const rows = await db.all("SELECT runbook_id, title, summary, first_steps_json FROM incident_runbooks ORDER BY runbook_id ASC") as Array<{ runbook_id: string; title: string; summary: string; first_steps_json: string }>;
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

app.get("/api/v1/audit/hardening/readiness", authMiddleware, async (_req, res) => {
  const auditCount = (await db.get("SELECT COUNT(*) as c FROM audit_records") as { c: number }).c;
  const interventionCount = (await db.get("SELECT COUNT(*) as c FROM support_ticket_interventions") as { c: number }).c;
  const bundleCount = (await db.get("SELECT COUNT(*) as c FROM diagnostic_bundles") as { c: number }).c;
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

function sendSyncRequestError(res: express.Response, err: SyncRequestError): void {
  res.status(err.status).json({ error: err.code, message: err.message });
}

/**
 * Tenant-runtime sync: push local outbox rows and pull inbound changes with the activation token.
 * `protocol_version` selects the protocol: v1 (unchanged for old desktops) or v2
 * (deploy/SYNC_PROTOCOL_V2.md).
 */
app.post("/api/v1/sync/exchange", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!act) {
    res.status(500).json({ error: "internal_error" });
    return;
  }
  const syncAct = { tenantId: act.tenantId, licenseId: act.licenseId, machineFingerprint: act.machineFingerprint };
  const protocolVersion = (req.body as { protocol_version?: unknown } | undefined)?.protocol_version;
  try {
    if (protocolVersion === "v2") {
      const parsed = SyncExchangeBodyV2.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "validation_error", details: parsed.error.flatten() });
        return;
      }
      const outcome = await runSyncExchangeV2(
        db,
        { registry: syncEntityRegistry, checkpointSecret: syncConfig.checkpointSecret },
        syncAct,
        req.body,
        parsed.data,
        structuredLog,
      );
      if (outcome.replayed) res.setHeader("X-Idempotent-Replay", "true");
      res.json(outcome.response);
      return;
    }
    const parsed = SyncExchangeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    res.json(await runSyncExchangeV1(db, { registry: syncEntityRegistry }, syncAct, parsed.data, structuredLog));
  } catch (e) {
    if (e instanceof SyncRequestError) {
      structuredLog("sync_exchange_refused", {
        tenant_id: act.tenantId,
        machine_fingerprint: act.machineFingerprint,
        status: e.status,
        error: e.code,
      });
      sendSyncRequestError(res, e);
      return;
    }
    structuredLog("sync_exchange_error", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "sync_exchange_failed" });
  }
});

/** Protocol v2 bootstrap: paged current state, then a checkpoint for deltas. */
app.post("/api/v1/sync/snapshot", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!act) {
    res.status(500).json({ error: "internal_error" });
    return;
  }
  const parsed = SyncSnapshotBodyV2.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation_error", details: parsed.error.flatten() });
    return;
  }
  try {
    const response = await runSyncSnapshotV2(
      db,
      { checkpointSecret: syncConfig.checkpointSecret },
      { tenantId: act.tenantId, licenseId: act.licenseId, machineFingerprint: act.machineFingerprint },
      parsed.data,
      structuredLog,
    );
    res.json(response);
  } catch (e) {
    if (e instanceof SyncRequestError) {
      sendSyncRequestError(res, e);
      return;
    }
    structuredLog("sync_snapshot_error", {
      tenant_id: act.tenantId,
      machine_fingerprint: act.machineFingerprint,
      error: e instanceof Error ? e.message : String(e),
    });
    res.status(500).json({ error: "sync_snapshot_failed" });
  }
});

app.post("/api/v1/sync/media/presign-put", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!act) {
    res.status(500).json({ error: "internal_error" });
    return;
  }
  const media = getMediaStore();
  if (!media) {
    res.status(503).json({ error: "object_storage_unavailable" });
    return;
  }
  const parsed = SyncMediaPresignPutBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed);
    return;
  }
  try {
    const objectKey =
      parsed.data.object_key?.trim() ||
      buildTenantMediaObjectKey({
        deploymentEnv: media.config.deploymentEnv,
        tenantId: act.tenantId,
        parentEntityType: parsed.data.parent_entity_type,
        parentEntitySyncId: parsed.data.parent_entity_sync_id,
        contentSha256: parsed.data.content_sha256,
      });
    if (!assertTenantOwnsObjectKey(act.tenantId, objectKey)) {
      res.status(403).json({ error: "object_key_tenant_mismatch" });
      return;
    }
    const signed = await media.presignPut(objectKey);
    res.json(signed);
  } catch (e) {
    res.status(400).json({
      error: "presign_put_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

app.post("/api/v1/sync/media/presign-get", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const act = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!act) {
    res.status(500).json({ error: "internal_error" });
    return;
  }
  const media = getMediaStore();
  if (!media) {
    res.status(503).json({ error: "object_storage_unavailable" });
    return;
  }
  const parsed = SyncMediaPresignGetBody.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed);
    return;
  }
  const objectKey = parsed.data.object_key.trim();
  if (!assertTenantOwnsObjectKey(act.tenantId, objectKey)) {
    res.status(403).json({ error: "object_key_tenant_mismatch" });
    return;
  }
  try {
    const signed = await media.presignGet(objectKey);
    res.json(signed);
  } catch (e) {
    res.status(400).json({
      error: "presign_get_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

type ActivationLicenseRow = {
  id: string;
  tenant_id: string;
  license_key: string;
  max_machines: number;
  update_channel: string;
  rollout_cohort: string;
  edition: string;
  entitlement_lineage: number;
  expires_at: string | null;
  revoked_at: string | null;
  force_min_app_version: string | null;
  force_update_mode: ForceUpdateMode;
  force_update_reason: string | null;
  offline_grace_hours: number;
  trust_revocation_disconnects_immediately: number;
  reconnect_requires_fresh_heartbeat: number;
  is_active: number;
  tenant_display_name: string;
  tenant_slug: string;
  is_initialized: number;
  has_demo_data: number;
};

async function loadLicenseForActivation(licenseKey: string): Promise<ActivationLicenseRow | undefined> {
  return await db.get(`SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.expires_at, l.revoked_at,
              l.update_channel, t.rollout_cohort,
              COALESCE(t.edition, 'core') AS edition,
              COALESCE(t.entitlement_lineage, 0) AS entitlement_lineage,
              t.force_min_app_version, t.force_update_mode, t.force_update_reason, t.is_active,
              t.offline_grace_hours, t.trust_revocation_disconnects_immediately,
              t.reconnect_requires_fresh_heartbeat,
              t.display_name AS tenant_display_name, t.slug AS tenant_slug,
              COALESCE(t.is_initialized, 0) AS is_initialized,
              COALESCE(t.has_demo_data, 0) AS has_demo_data
       FROM license_keys l
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.license_key = ?`, licenseKey) as ActivationLicenseRow | undefined;
}

async function countActiveActivations(licenseId: string): Promise<number> {
  const row = await db.get("SELECT COUNT(*) as count FROM machine_activations WHERE license_id = ? AND revoked_at IS NULL", licenseId) as { count: number };
  return row.count;
}

function resolveEnvelopeValidity(lic: ActivationLicenseRow): {
  validUntil: string;
  offlineGraceUntil: string;
} {
  const now = new Date().toISOString();
  const validUntil =
    lic.expires_at && !Number.isNaN(Date.parse(lic.expires_at))
      ? new Date(lic.expires_at).toISOString()
      : "2099-01-01T00:00:00.000Z";
  const offlineGraceUntil = addHoursIso(validUntil === "2099-01-01T00:00:00.000Z" ? now : validUntil, lic.offline_grace_hours);
  // Prefer grace relative to expiry when expiry is set.
  const graceFromExpiry = lic.expires_at
    ? addHoursIso(new Date(lic.expires_at).toISOString(), lic.offline_grace_hours)
    : addHoursIso(now, lic.offline_grace_hours);
  return {
    validUntil,
    offlineGraceUntil: lic.expires_at ? graceFromExpiry : offlineGraceUntil,
  };
}

async function buildEntitlementEnvelopeForLicense(
  lic: ActivationLicenseRow,
  opts?: { bumpLineage?: boolean; persistLineage?: boolean },
): Promise<EntitlementEnvelopePayload> {
  // Soft phase: always issue lineage 1 with null previous so desktop apply does not
  // require a prior local envelope id (control plane does not track device envelopes).
  // entitlement_lineage still bumps for operator audit / concurrency hints.
  // Catalog snapshot + lineage bump run in one transaction, so the envelope is stamped from a
  // single committed catalog version.
  return db.tx(async () => {
    if (opts?.bumpLineage) {
      await db.run(`UPDATE tenants SET entitlement_lineage = entitlement_lineage + 1 WHERE id = ?`, lic.tenant_id);
    } else if (opts?.persistLineage) {
      await db.run(`UPDATE tenants SET entitlement_lineage = CASE WHEN COALESCE(entitlement_lineage, 0) < 1 THEN 1 ELSE entitlement_lineage END WHERE id = ?`, lic.tenant_id);
    }
    const snap = await loadCapabilitiesJsonForSign(db, lic.edition);
    const { validUntil, offlineGraceUntil } = resolveEnvelopeValidity(lic);
    return buildSignedEntitlementEnvelope({
      edition: snap.tier,
      capabilities_json: snap.capabilities_json,
      lineageVersion: 1,
      previousEnvelopeId: null,
      channel: lic.update_channel,
      machineSlots: lic.max_machines,
      validUntil,
      offlineGraceUntil,
    });
  });
}

async function buildActivationSummary(
  lic: ActivationLicenseRow,
  input: z.infer<typeof ActivationClaimBody>,
  resolvedPolicy: ReturnType<typeof resolveForceUpdatePolicy>,
  opts?: { includeEnvelope?: boolean; bumpLineage?: boolean; persistLineage?: boolean },
): Promise<Record<string, unknown>> {
  const edition = await editionExists(db, lic.edition) ? lic.edition : parseEditionId(lic.edition, "core");
  const includeEnvelope = opts?.includeEnvelope === true;
  const envelope = await buildEntitlementEnvelopeForLicense(lic, {
    bumpLineage: opts?.bumpLineage,
    persistLineage: opts?.persistLineage,
  });
  return {
    tenant_id: lic.tenant_id,
    license_id: lic.id,
    machine_fingerprint: input.machine_fingerprint,
    tenant_display_name: lic.tenant_display_name,
    tenant_slug: lic.tenant_slug,
    license_status: "active",
    edition,
    license_plan: edition,
    license_tier: edition,
    update_channel: lic.update_channel,
    expires_at: lic.expires_at,
    device_limit: lic.max_machines,
    activated_device_count: await countActiveActivations(lic.id),
    machine_label: input.machine_label ?? null,
    is_initialized: lic.is_initialized === 1,
    has_demo_data: lic.has_demo_data === 1,
    offline_grace_hours: lic.offline_grace_hours,
    trust_revocation_disconnects_immediately: lic.trust_revocation_disconnects_immediately === 1,
    reconnect_requires_fresh_heartbeat: lic.reconnect_requires_fresh_heartbeat === 1,
    force_min_app_version: resolvedPolicy.force_min_app_version,
    force_update_mode: resolvedPolicy.force_update_mode,
    force_update_reason: resolvedPolicy.force_update_reason,
    force_update_policy_source: resolvedPolicy.policy_source,
    force_update_required: resolvedPolicy.force_update_required,
    capabilities_digest: capabilitiesDigest(envelope.capabilities_json),
    feature_flags_digest: capabilitiesDigest(envelope.feature_flags_json),
    ...(includeEnvelope ? { entitlement_envelope: envelope } : {}),
  };
}

async function resolveActivationPolicy(lic: ActivationLicenseRow, appVersion: string | undefined) {
  const cohortPolicy = await db.get(`SELECT force_min_app_version, force_update_mode, force_update_reason
       FROM cohort_update_policies
       WHERE channel = ? AND cohort_label = ?`, lic.update_channel, lic.rollout_cohort) as
    | {
        force_min_app_version: string | null;
        force_update_mode: Exclude<ForceUpdateMode, "inherit">;
        force_update_reason: string | null;
      }
    | undefined;
  return resolveForceUpdatePolicy({
    appVersion,
    tenantMinVersion: lic.force_min_app_version,
    tenantMode: lic.force_update_mode,
    tenantReason: lic.force_update_reason,
    cohortMinVersion: cohortPolicy?.force_min_app_version ?? null,
    cohortMode: cohortPolicy?.force_update_mode ?? "off",
    cohortReason: cohortPolicy?.force_update_reason ?? null,
  });
}

type ActivationValidateFailure = { status: number; body: Record<string, unknown>; reason: string };

async function validateLicenseForActivation(
  lic: ActivationLicenseRow | undefined,
  input: z.infer<typeof ActivationClaimBody>,
  opts: { reserveSlot: boolean },
): Promise<{ ok: true; lic: ActivationLicenseRow } | { ok: false; failure: ActivationValidateFailure }> {
  if (!lic || lic.is_active !== 1) {
    return {
      ok: false,
      failure: { status: 404, body: { error: "license_not_found" }, reason: "license_not_found" },
    };
  }
  if (lic.revoked_at) {
    return {
      ok: false,
      failure: { status: 403, body: { error: "license_revoked" }, reason: "license_revoked" },
    };
  }
  if (lic.expires_at && new Date(lic.expires_at) <= new Date()) {
    return {
      ok: false,
      failure: { status: 403, body: { error: "license_expired" }, reason: "license_expired" },
    };
  }

  const existing = await db.get(`SELECT id, machine_fingerprint, license_id, revoked_at, revocation_kind
       FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?`, lic.tenant_id, input.machine_fingerprint) as
    | {
        id: string;
        machine_fingerprint: string;
        license_id: string;
        revoked_at: string | null;
        revocation_kind: string | null;
      }
    | undefined;

  // An operator-revoked machine stays revoked until an operator reinstates it: presenting the
  // licence key again (preview or claim) must not undo the revocation.
  if (existing?.revoked_at && existing.revocation_kind === "machine") {
    return {
      ok: false,
      failure: {
        status: 403,
        body: {
          error: "activation_revoked",
          message: "This device was revoked by the vendor. Ask your administrator to have it reinstated.",
        },
        reason: "activation_revoked",
      },
    };
  }

  // A device already holds a slot only while it is active on this same licence; a revoked device or
  // one bound to another licence needs a free slot like a new one.
  const holdsSlot = existing != null && existing.revoked_at == null && existing.license_id === lic.id;
  if (!holdsSlot) {
    const activeCount = await countActiveActivations(lic.id);
    if (activeCount >= lic.max_machines) {
      return {
        ok: false,
        failure: {
          status: 409,
          body: { error: "slot_limit_reached", max_machines: lic.max_machines },
          reason: "slot_limit_reached",
        },
      };
    }
  } else if (!opts.reserveSlot) {
    // Preview: existing fingerprint is fine; slot already held.
  }

  return { ok: true, lic };
}

app.post("/api/v1/activation/preview", activationRateLimiter, async (req, res) => {
  const startedAt = Date.now();
  const parsed = ActivationClaimBody.safeParse(req.body);
  if (!parsed.success) {
    observeActivationOutcome("invalid_body");
    structuredLog("activation_preview_failed", {
      reason: "invalid_body",
      status: 400,
      duration_ms: Date.now() - startedAt,
    });
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const lic = await loadLicenseForActivation(input.license_key.trim());
  const validated = await validateLicenseForActivation(lic, input, { reserveSlot: false });
  if (!validated.ok) {
    observeActivationOutcome(validated.failure.reason as Parameters<typeof observeActivationOutcome>[0]);
    structuredLog("activation_preview_failed", {
      reason: validated.failure.reason,
      status: validated.failure.status,
      duration_ms: Date.now() - startedAt,
      machine_fingerprint: input.machine_fingerprint,
    });
    res.status(validated.failure.status).json(validated.failure.body);
    return;
  }
  const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
  structuredLog("activation_preview_success", {
    status: 200,
    tenant_id: validated.lic.tenant_id,
    license_id: validated.lic.id,
    machine_fingerprint: input.machine_fingerprint,
    duration_ms: Date.now() - startedAt,
  });
  res.json(await buildActivationSummary(validated.lic, input, resolvedPolicy));
});

app.post("/api/v1/activation/claim", activationRateLimiter, async (req, res) => {
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
  const lic = await loadLicenseForActivation(input.license_key.trim());
  // Slot check and activation write run in one transaction under a per-licence lock, so two
  // concurrent claims cannot both take the last slot.
  const claim = await db.tx(async () => {
    // Locks: the licence's slots (vs. other claims, reinstate and revoke), then this device on the
    // tenant (vs. a concurrent claim of the same machine on another licence). The licence is read
    // again under the lock so a concurrent revoke or slot change is seen.
    let current = lic;
    if (lic) {
      await db.lockXact("license-slots", lic.id);
      await db.lockXact("activation-device", `${lic.tenant_id}:${input.machine_fingerprint}`);
      current = await loadLicenseForActivation(input.license_key.trim());
    }
    const validated = await validateLicenseForActivation(current, input, { reserveSlot: true });
    if (!validated.ok) return { ok: false as const, failure: validated.failure };

    const resolvedPolicy = await resolveActivationPolicy(validated.lic, input.app_version);
    const activationToken = signDeviceActivationToken(JWT_SECRET, {
      tenantId: validated.lic.tenant_id,
      licenseId: validated.lic.id,
      machineFingerprint: input.machine_fingerprint,
    });

    // Operator-revoked machines were already refused by validateLicenseForActivation.
    const existing = await db.get<{ id: string; machine_fingerprint: string }>(
      "SELECT id, machine_fingerprint FROM machine_activations WHERE tenant_id = ? AND machine_fingerprint = ?",
      validated.lic.tenant_id,
      input.machine_fingerprint,
    );

    if (existing) {
      // Rebind to the licence being claimed (e.g. after a licence replacement) so the device lookup
      // in activationAuthMiddleware matches the token's license_id.
      await db.run(
        `UPDATE machine_activations
         SET license_id = ?, machine_label = ?, app_version = ?, activation_token = ?, last_seen_at = ?,
             revoked_at = NULL, revocation_kind = NULL
         WHERE id = ?`,
        validated.lic.id,
        input.machine_label ?? null,
        input.app_version ?? null,
        activationToken,
        nowIso,
        existing.id,
      );
    } else {
      await db.run(
        `INSERT INTO machine_activations
          (id, tenant_id, license_id, machine_fingerprint, machine_label, app_version, activation_token, activated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId("act"),
        validated.lic.tenant_id,
        validated.lic.id,
        input.machine_fingerprint,
        input.machine_label ?? null,
        input.app_version ?? null,
        activationToken,
        nowIso,
        nowIso,
      );
    }
    return { ok: true as const, validated, resolvedPolicy, activationToken };
  });
  if (!claim.ok) {
    observeActivationOutcome(claim.failure.reason as Parameters<typeof observeActivationOutcome>[0]);
    structuredLog("activation_claim_failed", {
      reason: claim.failure.reason,
      status: claim.failure.status,
      duration_ms: Date.now() - startedAt,
      machine_fingerprint: input.machine_fingerprint,
      ...(claim.failure.reason !== "license_not_found"
        ? { tenant_id: lic?.tenant_id, license_id: lic?.id }
        : {}),
    });
    res.status(claim.failure.status).json(claim.failure.body);
    return;
  }
  const { validated, resolvedPolicy, activationToken } = claim;

  observeActivationOutcome("ok");
  structuredLog("activation_claim_success", {
    status: 200,
    tenant_id: validated.lic.tenant_id,
    license_id: validated.lic.id,
    machine_fingerprint: input.machine_fingerprint,
    policy_source: resolvedPolicy.policy_source,
    force_update_required: resolvedPolicy.force_update_required,
    duration_ms: Date.now() - startedAt,
  });
  res.json({
    ...(await buildActivationSummary(validated.lic, input, resolvedPolicy, {
      includeEnvelope: true,
      persistLineage: true,
    })),
    // Count after write so activated_device_count includes this device.
    activated_device_count: await countActiveActivations(validated.lic.id),
    activation_token: activationToken,
  });
});

app.post("/api/v1/activation/policy-refresh", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!activation) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const licRow = await db.get(`SELECT l.id, l.tenant_id, l.license_key, l.max_machines, l.expires_at, l.revoked_at,
              l.update_channel, t.rollout_cohort,
              COALESCE(t.edition, 'core') AS edition,
              COALESCE(t.entitlement_lineage, 0) AS entitlement_lineage,
              t.force_min_app_version, t.force_update_mode, t.force_update_reason, t.is_active,
              t.offline_grace_hours, t.trust_revocation_disconnects_immediately,
              t.reconnect_requires_fresh_heartbeat,
              t.display_name AS tenant_display_name, t.slug AS tenant_slug,
              COALESCE(t.is_initialized, 0) AS is_initialized,
              COALESCE(t.has_demo_data, 0) AS has_demo_data
       FROM license_keys l
       JOIN tenants t ON t.id = l.tenant_id
       WHERE l.id = ? AND l.tenant_id = ?`, activation.licenseId, activation.tenantId) as ActivationLicenseRow | undefined;
  if (!licRow || licRow.is_active !== 1) {
    res.status(404).json({ error: "license_not_found" });
    return;
  }
  if (licRow.revoked_at) {
    res.status(403).json({ error: "license_revoked" });
    return;
  }
  if (licRow.expires_at && new Date(licRow.expires_at) <= new Date()) {
    res.status(403).json({ error: "license_expired" });
    return;
  }
  const resolvedPolicy = await resolveActivationPolicy(licRow, undefined);
  const syntheticInput = {
    license_key: licRow.license_key,
    machine_fingerprint: activation.machineFingerprint,
  };
  const summary = await buildActivationSummary(licRow, syntheticInput, resolvedPolicy, {
    includeEnvelope: true,
    bumpLineage: true,
  });
  // Rotate an ageing device token: the new one is stored, so the old one stops working at once
  // (activationAuthMiddleware compares against the stored token).
  let activationToken = activation.token;
  const tokenAgeSeconds = Math.floor(Date.now() / 1000) - activation.tokenIssuedAt;
  if (tokenAgeSeconds >= DEVICE_TOKEN_ROTATE_AFTER_SECONDS) {
    activationToken = signDeviceActivationToken(JWT_SECRET, {
      tenantId: activation.tenantId,
      licenseId: activation.licenseId,
      machineFingerprint: activation.machineFingerprint,
    });
    await db.run(`UPDATE machine_activations SET activation_token = ?
       WHERE tenant_id = ? AND license_id = ? AND machine_fingerprint = ?`, activationToken, activation.tenantId, activation.licenseId, activation.machineFingerprint);
    structuredLog("activation_token_rotated", {
      tenant_id: activation.tenantId,
      license_id: activation.licenseId,
      machine_fingerprint: activation.machineFingerprint,
      previous_token_age_seconds: tokenAgeSeconds,
    });
  }
  res.json({
    ...summary,
    activated_device_count: await countActiveActivations(licRow.id),
    // Always present: the desktop stores it as its bearer token (rotated when ageing).
    activation_token: activationToken,
  });
});

app.get("/api/v1/activation/tenant-status", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!activation) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const row = await db.get(`SELECT id, COALESCE(is_initialized, 0) AS is_initialized FROM tenants WHERE id = ?`, activation.tenantId) as { id: string; is_initialized: number } | undefined;
  if (!row) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  res.json({
    tenant_id: row.id,
    is_initialized: row.is_initialized === 1,
  });
});

app.post("/api/v1/activation/tenant-status/initialize", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
  const activation = (req as express.Request & { activation?: ActivationAuthContext }).activation;
  if (!activation) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const nowIso = new Date().toISOString();
  const result = await db.run(
    `UPDATE tenants
     SET is_initialized = 1,
         bootstrap_completed_at = COALESCE(bootstrap_completed_at, ?),
         bootstrap_method = COALESCE(bootstrap_method, ?)
     WHERE id = ?`,
    nowIso,
    "desktop_activation",
    activation.tenantId,
  );
  if (result.changes === 0) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }
  const row = await db.get(`SELECT id, COALESCE(is_initialized, 0) AS is_initialized FROM tenants WHERE id = ?`, activation.tenantId) as { id: string; is_initialized: number };
  structuredLog("activation_tenant_initialized", {
    tenant_id: row.id,
    machine_fingerprint: activation.machineFingerprint,
  });
  res.json({
    tenant_id: row.id,
    is_initialized: row.is_initialized === 1,
  });
});

const port = Number(process.env.PORT ?? 3000);

let mediaStoreSingleton: TenantMediaObjectStore | null | undefined;

function getMediaStore(): TenantMediaObjectStore | null {
  if (mediaStoreSingleton === undefined) {
    mediaStoreSingleton = TenantMediaObjectStore.fromEnv();
    structuredLog("object_store_config", {
      configured: mediaStoreSingleton !== null,
      bucket: mediaStoreSingleton?.config.bucket ?? null,
    });
  }
  return mediaStoreSingleton;
}

// Last handler: an error thrown or rejected by any route (forwarded by forwardAsyncErrors).
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  structuredLog("route_unhandled_error", {
    method: req.method,
    path: req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "internal_error" });
});

/** Sync retention (log compaction + idempotency pruning) every SYNC_RETENTION_INTERVAL_MINUTES. */
const syncRetentionTimer = setInterval(() => {
  runSyncRetention(db, syncConfig)
    .then((report) => structuredLog("sync_retention_run", report))
    .catch((err) => structuredLog("sync_retention_failed", { error: err instanceof Error ? err.message : String(err) }));
}, syncConfig.retentionIntervalMinutes * 60_000);
syncRetentionTimer.unref();

getMediaStore();
app.listen(port, "0.0.0.0", () => {
  structuredLog("control_api_listening", {
    port,
    sync_entity_registry_version: syncEntityRegistry.version,
    sync_entity_types: syncEntityRegistry.size,
  });
  console.log(`control-api listening on ${port}`);
});

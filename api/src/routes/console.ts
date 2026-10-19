/**
 * The console's dashboards (redesign of Phase 4): one answer per screen, with facts only (codes,
 * counts, dates), so the console words them in the operator's language. Every figure comes from
 * the database, the sync store, backup_runs or a live probe; nothing is estimated.
 *
 *   GET /api/v1/console/overview  key figures, what needs the operator, health summary, customers
 *   GET /api/v1/console/health    server, backups, data sync, app versions in use
 */
import type express from "express";

import type { ApiContext } from "../app/context.js";
import { BACKUP_LOCAL_RETENTION_DAYS } from "../app/config.js";
import {
  BACKUP_MAX_AGE_HOURS,
  DB_LATENCY_MS,
  loadBackupStatus,
  probeDatabase,
  probeDisk,
  probeObjectStorage,
  RESTORE_DRILL_MAX_AGE_DAYS,
  type BackupStatus,
} from "../ops/platform-probes.js";
import { collectSyncHealth, type SyncHealthSnapshot } from "../ops/sync-health.js";

/** A licence ending within this many days is "expiring soon". */
export const LICENCE_EXPIRING_DAYS = 30;
/** A licence that ended less than this many days ago is still listed for renewal. */
export const LICENCE_RECENTLY_EXPIRED_DAYS = 30;
/** A device with no sync (or heartbeat) for this long "is not syncing". */
export const DEVICE_NOT_SYNCING_HOURS = 24;
/** Support tickets in these states are open (constants, written into the SQL below). */
const OPEN_TICKET_STATES = ["new", "triaged", "waiting_for_vendor", "waiting_for_customer"] as const;
const OPEN_TICKET_STATES_SQL = OPEN_TICKET_STATES.map((s) => `'${s}'`).join(", ");

const DAY_MS = 86_400_000;

type TenantRow = { id: string; slug: string; display_name: string; edition: string; created_at: string; suspended_at: string | null; is_active: number };
type LicenceRow = { id: string; tenant_id: string; max_machines: number; expires_at: string | null; revoked_at: string | null };
type DeviceRow = { tenant_id: string; machine_fingerprint: string; machine_label: string | null; app_version: string | null; last_seen_at: string };
type Attention = {
  kind: string;
  severity: "critical" | "warn" | "info";
  tenant_id: string | null;
  tenant_name: string | null;
  facts: Record<string, string | number | null>;
};

export type CustomerStatus = "active" | "expires_soon" | "expired" | "not_activated" | "no_licence" | "suspended";

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** The customer's standing, from their licences and devices (most urgent first). */
/**
 * Suspension is soft (is_active = 0, devices refused, data kept; deletion is a hard DELETE), so an inactive
 * tenant is a suspended one. Older rows may be inactive with suspended_at NULL; they count as suspended too.
 */
export function isSuspended(t: { is_active: number; suspended_at: string | null }): boolean {
  return t.is_active !== 1 || t.suspended_at !== null;
}

function customerStatus(tenant: TenantRow, live: LicenceRow[], valid: LicenceRow[], devicesUsed: number, licenceUntil: string | null, nowMs: number): CustomerStatus {
  if (isSuspended(tenant)) return "suspended";
  if (live.length === 0) return "no_licence";
  if (valid.length === 0) return "expired";
  if (devicesUsed === 0) return "not_activated";
  if (licenceUntil !== null && Date.parse(licenceUntil) - nowMs <= LICENCE_EXPIRING_DAYS * DAY_MS) return "expires_soon";
  return "active";
}

function deviceLastSyncMs(d: SyncHealthSnapshot["devices"][number]): number {
  const exchange = d.last_exchange_rfc3339 ? Date.parse(d.last_exchange_rfc3339) : NaN;
  const heartbeat = Date.parse(d.last_heartbeat_rfc3339);
  return Math.max(Number.isFinite(exchange) ? exchange : 0, Number.isFinite(heartbeat) ? heartbeat : 0);
}

function notSyncing(snap: SyncHealthSnapshot, nowMs: number) {
  return snap.devices.filter((d) => nowMs - deviceLastSyncMs(d) > DEVICE_NOT_SYNCING_HOURS * 3600_000);
}

function backupFacts(backups: BackupStatus[], nowMs: number) {
  const nightly = backups.find((b) => b.kind === "nightly") ?? null;
  const drill = backups.find((b) => b.kind === "restore_drill") ?? null;
  const backupAgeHours = nightly?.last_success_at ? (nowMs - new Date(nightly.last_success_at).getTime()) / 3600_000 : null;
  const drillAgeDays = drill?.last_success_at ? (nowMs - new Date(drill.last_success_at).getTime()) / DAY_MS : null;
  return {
    last_backup_at: iso(nightly?.last_success_at ?? null),
    last_backup_status: nightly?.last_status ?? null,
    last_backup_attempt_at: iso(nightly?.last_finished_at ?? null),
    /** The latest backup file is age-encrypted to the owner's key (the server cannot read it). */
    encrypted: nightly?.last_dump_file ? nightly.last_dump_file.endsWith(".age") : null,
    backup_late: backupAgeHours === null || backupAgeHours > BACKUP_MAX_AGE_HOURS,
    last_restore_test_at: iso(drill?.last_success_at ?? null),
    last_restore_test_status: drill?.last_status ?? null,
    restore_test_overdue: drillAgeDays === null || drillAgeDays > RESTORE_DRILL_MAX_AGE_DAYS,
    /** disabled = copies only on this server; uploaded / failed = an off-site copy is configured. */
    offsite: nightly?.last_offsite_status ?? null,
    /** As configured for the backup container (BACKUP_LOCAL_RETENTION_DAYS); null when not passed to the API. */
    retention_days: BACKUP_LOCAL_RETENTION_DAYS,
  };
}

function backupNeedsAttention(b: ReturnType<typeof backupFacts>): boolean {
  return b.backup_late || b.last_backup_status === "failed" || b.restore_test_overdue || b.last_restore_test_status === "failed";
}

export function registerConsoleRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware } = ctx;

  app.get("/api/v1/console/overview", authMiddleware, async (_req, res) => {
    const nowMs = Date.now();
    const [tenants, licences, devices, editions, tickets, snap, backups] = await Promise.all([
      db.all<TenantRow>("SELECT id, slug, display_name, edition, created_at, suspended_at, is_active FROM tenants ORDER BY display_name"),
      db.all<LicenceRow>("SELECT id, tenant_id, max_machines, expires_at, revoked_at FROM license_keys"),
      db.all<DeviceRow>(
        "SELECT tenant_id, machine_fingerprint, machine_label, app_version, last_seen_at FROM machine_activations WHERE revoked_at IS NULL",
      ),
      db.all<{ id: string; label: string }>("SELECT id, label FROM edition_catalog"),
      db.all<{ ticket_id: string; tenant_id: string; state: string; summary: string | null; created_at_rfc3339: string; bundles: number }>(
        `SELECT t.ticket_id, t.tenant_id, t.state, t.summary, t.created_at_rfc3339,
                (SELECT COUNT(*) FROM diagnostic_bundles b WHERE b.ticket_id = t.ticket_id AND b.status = 'uploaded')::int AS bundles
         FROM support_tickets t
         WHERE t.state IN (${OPEN_TICKET_STATES_SQL})
         ORDER BY t.created_at_rfc3339 DESC`,
      ),
      collectSyncHealth(db),
      loadBackupStatus(db),
    ]);
    const editionLabel = new Map(editions.map((e) => [e.id, e.label]));
    // Every customer is listed (suspended ones included, so an operator can find and resume them), but
    // licence / device / health work items only concern customers that are live.
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const liveTenantById = new Map(tenants.filter((t) => !isSuspended(t)).map((t) => [t.id, t]));
    const labelOf = new Map(devices.map((d) => [`${d.tenant_id}::${d.machine_fingerprint}`, d.machine_label]));
    const isValid = (l: LicenceRow) => l.revoked_at === null && (l.expires_at === null || Date.parse(l.expires_at) > nowMs);

    const customers = tenants.map((t) => {
      const live = licences.filter((l) => l.tenant_id === t.id && l.revoked_at === null);
      const valid = live.filter(isValid);
      const used = devices.filter((d) => d.tenant_id === t.id).length;
      const neverEnds = valid.some((l) => l.expires_at === null);
      // The latest end among licences still valid; null when one never ends or none is valid.
      const licenceUntil = valid.length === 0 || neverEnds ? null : (valid.map((l) => l.expires_at as string).sort().at(-1) ?? null);
      const ended = valid.length === 0 ? (live.map((l) => l.expires_at).filter((x): x is string => x !== null).sort().at(-1) ?? null) : null;
      return {
        tenant_id: t.id,
        slug: t.slug,
        name: t.display_name,
        edition: t.edition,
        edition_label: editionLabel.get(t.edition) ?? t.edition,
        devices_used: used,
        seats: valid.reduce((s, l) => s + l.max_machines, 0),
        licence_until: iso(licenceUntil),
        licence_never_ends: neverEnds,
        licence_ended_at: iso(ended),
        status: customerStatus(t, live, valid, used, licenceUntil, nowMs),
        customer_since: iso(t.created_at),
      };
    });

    const validLicences = licences.filter((l) => liveTenantById.has(l.tenant_id) && isValid(l));
    const expiring = validLicences
      .filter((l) => l.expires_at !== null && Date.parse(l.expires_at) - nowMs <= LICENCE_EXPIRING_DAYS * DAY_MS)
      .sort((a, b) => Date.parse(a.expires_at!) - Date.parse(b.expires_at!));
    const recentlyExpired = licences.filter((l) => {
      const t = liveTenantById.get(l.tenant_id);
      if (!t || l.revoked_at !== null || l.expires_at === null) return false;
      const endedMs = Date.parse(l.expires_at);
      // Listed only while the customer has no other valid licence.
      return endedMs <= nowMs && nowMs - endedMs <= LICENCE_RECENTLY_EXPIRED_DAYS * DAY_MS && !validLicences.some((v) => v.tenant_id === l.tenant_id);
    });
    const tenantDevices = snap.devices.filter((d) => liveTenantById.has(d.tenant_id));
    const behind = notSyncing(snap, nowMs)
      .filter((d) => liveTenantById.has(d.tenant_id))
      .sort((a, b) => deviceLastSyncMs(a) - deviceLastSyncMs(b));
    const backup = backupFacts(backups, nowMs);

    const attention: Attention[] = [];
    if (backup.last_backup_status === "failed") {
      attention.push({ kind: "backup_failed", severity: "critical", tenant_id: null, tenant_name: null, facts: { at: backup.last_backup_attempt_at } });
    } else if (backup.backup_late) {
      attention.push({ kind: "backup_late", severity: "critical", tenant_id: null, tenant_name: null, facts: { last_at: backup.last_backup_at } });
    }
    if (backup.last_restore_test_status === "failed") {
      attention.push({ kind: "restore_test_failed", severity: "critical", tenant_id: null, tenant_name: null, facts: {} });
    } else if (backup.restore_test_overdue) {
      attention.push({ kind: "restore_test_overdue", severity: "warn", tenant_id: null, tenant_name: null, facts: { last_at: backup.last_restore_test_at } });
    }
    for (const l of recentlyExpired) {
      const t = liveTenantById.get(l.tenant_id)!;
      attention.push({
        kind: "licence_expired",
        severity: "critical",
        tenant_id: t.id,
        tenant_name: t.display_name,
        facts: { licence_id: l.id, ended_at: iso(l.expires_at), days_ago: Math.floor((nowMs - Date.parse(l.expires_at!)) / DAY_MS), edition: editionLabel.get(t.edition) ?? t.edition },
      });
    }
    for (const l of expiring) {
      const t = liveTenantById.get(l.tenant_id)!;
      attention.push({
        kind: "licence_expiring",
        severity: "warn",
        tenant_id: t.id,
        tenant_name: t.display_name,
        facts: {
          licence_id: l.id,
          expires_at: iso(l.expires_at),
          days_left: Math.max(0, Math.ceil((Date.parse(l.expires_at!) - nowMs) / DAY_MS)),
          edition: editionLabel.get(t.edition) ?? t.edition,
          devices: devices.filter((d) => d.tenant_id === t.id).length,
        },
      });
    }
    for (const d of behind) {
      const t = liveTenantById.get(d.tenant_id)!;
      const last = deviceLastSyncMs(d);
      attention.push({
        kind: d.last_exchange_rfc3339 === null && d.protocol === "never_synced" ? "device_never_synced" : "device_not_syncing",
        severity: "warn",
        tenant_id: t.id,
        tenant_name: t.display_name,
        facts: {
          machine_id: d.machine_id,
          device_label: labelOf.get(`${d.tenant_id}::${d.machine_id}`) ?? null,
          last_sync_at: last > 0 ? new Date(last).toISOString() : null,
          days: last > 0 ? Math.floor((nowMs - last) / DAY_MS) : null,
        },
      });
    }
    for (const tk of tickets.filter((x) => x.state === "new")) {
      attention.push({
        kind: tk.bundles > 0 ? "ticket_new_with_file" : "ticket_new",
        severity: "info",
        tenant_id: tk.tenant_id,
        tenant_name: tenantById.get(tk.tenant_id)?.display_name ?? null,
        facts: { ticket_id: tk.ticket_id, summary: tk.summary, created_at: iso(tk.created_at_rfc3339) },
      });
    }

    const live = customers.filter((c) => c.status !== "suspended");
    res.json({
      generated_at: new Date(nowMs).toISOString(),
      thresholds: { licence_expiring_days: LICENCE_EXPIRING_DAYS, device_not_syncing_hours: DEVICE_NOT_SYNCING_HOURS },
      figures: {
        customers_total: tenants.length,
        customers_active: tenants.filter((t) => !isSuspended(t)).length,
        devices_in_use: live.reduce((s, c) => s + c.devices_used, 0),
        seats_total: live.reduce((s, c) => s + c.seats, 0),
        seats_free: live.reduce((s, c) => s + Math.max(0, c.seats - c.devices_used), 0),
        licences_expiring: expiring.length,
        open_tickets: tickets.length,
      },
      attention,
      health: {
        status: backupNeedsAttention(backup) || behind.length > 0 ? "attention" : "ok",
        last_backup_at: backup.last_backup_at,
        last_backup_status: backup.last_backup_status,
        backup_encrypted: backup.encrypted,
        last_restore_test_at: backup.last_restore_test_at,
        last_restore_test_status: backup.last_restore_test_status,
        devices_total: tenantDevices.length,
        devices_syncing: tenantDevices.length - behind.length,
      },
      customers,
    });
  });

  app.get("/api/v1/console/health", authMiddleware, async (_req, res) => {
    const nowMs = Date.now();
    const [storage, disk, backups, snap, versions] = await Promise.all([
      probeObjectStorage(),
      probeDisk(),
      loadBackupStatus(db),
      collectSyncHealth(db),
      db.all<{ app_version: string | null; devices: number }>(
        `SELECT a.app_version, COUNT(*)::int AS devices
         FROM machine_activations a JOIN tenants t ON t.id = a.tenant_id
         WHERE a.revoked_at IS NULL AND t.is_active = 1
         GROUP BY a.app_version ORDER BY devices DESC`,
      ),
    ]);
    let database: { state: "ok" | "slow" | "down"; latency_ms: number | null };
    try {
      const probe = await probeDatabase(db);
      database = { state: probe.latency_ms >= DB_LATENCY_MS.warn ? "slow" : "ok", latency_ms: probe.latency_ms };
    } catch {
      database = { state: "down", latency_ms: null };
    }
    const backup = backupFacts(backups, nowMs);
    const behind = notSyncing(snap, nowMs);
    const serverOk = database.state === "ok" && storage.state === "ok";
    res.json({
      checked_at: new Date(nowMs).toISOString(),
      status: serverOk && !backupNeedsAttention(backup) && behind.length === 0 ? "ok" : "attention",
      server: {
        online: true,
        database,
        file_storage: storage.state,
        disk_free_bytes: disk?.free_bytes ?? null,
        disk_total_bytes: disk?.total_bytes ?? null,
      },
      backups: backup,
      sync: {
        devices_total: snap.devices.length,
        devices_up_to_date: snap.devices.length - behind.length,
        first_device_behind: behind[0] ? { tenant_id: behind[0].tenant_id, machine_id: behind[0].machine_id } : null,
        window_hours: snap.window_hours,
        refused_not_applied: snap.tenants.reduce((s, t) => s + t.dead_letter_count, 0),
        conflicts: snap.tenants.reduce((s, t) => s + t.conflicts, 0),
      },
      updates: {
        devices_total: versions.reduce((s, v) => s + v.devices, 0),
        versions: versions.map((v) => ({ version: v.app_version, devices: v.devices })),
      },
    });
  });
}

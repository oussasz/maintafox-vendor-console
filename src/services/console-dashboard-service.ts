/**
 * The console dashboards (control API routes/console.ts): facts and codes, worded by the console.
 * Codes are read as plain strings so a code a newer server adds shows as "unknown" instead of
 * failing the page; extra fields are ignored.
 */
import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import { apiRequestError } from "@/lib/api-error";

const Iso = z.string().nullable();

const CustomerRowSchema = z.object({
  tenant_id: z.string(),
  slug: z.string(),
  name: z.string(),
  edition: z.string(),
  edition_label: z.string(),
  devices_used: z.number(),
  seats: z.number(),
  licence_until: Iso,
  licence_never_ends: z.boolean(),
  licence_ended_at: Iso,
  /** active | expires_soon | expired | not_activated | no_licence | suspended */
  status: z.string(),
  customer_since: Iso,
});
export type CustomerRow = z.infer<typeof CustomerRowSchema>;

const AttentionSchema = z.object({
  /** backup_failed | backup_late | restore_test_failed | restore_test_overdue | licence_expired |
   *  licence_expiring | device_not_syncing | device_never_synced | ticket_new | ticket_new_with_file */
  kind: z.string(),
  severity: z.string(),
  tenant_id: z.string().nullable(),
  tenant_name: z.string().nullable(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});
export type AttentionItem = z.infer<typeof AttentionSchema>;

const OverviewSchema = z.object({
  generated_at: z.string(),
  thresholds: z.object({ licence_expiring_days: z.number(), device_not_syncing_hours: z.number() }),
  figures: z.object({
    customers_total: z.number(),
    customers_active: z.number(),
    devices_in_use: z.number(),
    seats_total: z.number(),
    seats_free: z.number(),
    licences_expiring: z.number(),
    open_tickets: z.number(),
  }),
  attention: z.array(AttentionSchema),
  health: z.object({
    status: z.string(),
    last_backup_at: Iso,
    last_backup_status: z.string().nullable(),
    backup_encrypted: z.boolean().nullable(),
    last_restore_test_at: Iso,
    last_restore_test_status: z.string().nullable(),
    devices_total: z.number(),
    devices_syncing: z.number(),
  }),
  customers: z.array(CustomerRowSchema),
});
export type ConsoleOverview = z.infer<typeof OverviewSchema>;

const HealthSchema = z.object({
  checked_at: z.string(),
  status: z.string(),
  server: z.object({
    online: z.boolean(),
    database: z.object({ state: z.string(), latency_ms: z.number().nullable() }),
    file_storage: z.string(),
    disk_free_bytes: z.number().nullable(),
    disk_total_bytes: z.number().nullable(),
  }),
  backups: z.object({
    last_backup_at: Iso,
    last_backup_status: z.string().nullable(),
    last_backup_attempt_at: Iso,
    encrypted: z.boolean().nullable(),
    backup_late: z.boolean(),
    last_restore_test_at: Iso,
    last_restore_test_status: z.string().nullable(),
    restore_test_overdue: z.boolean(),
    offsite: z.string().nullable(),
    retention_days: z.number().nullable(),
  }),
  sync: z.object({
    devices_total: z.number(),
    devices_up_to_date: z.number(),
    first_device_behind: z.object({ tenant_id: z.string(), machine_id: z.string() }).nullable(),
    window_hours: z.number(),
    refused_not_applied: z.number(),
    conflicts: z.number(),
  }),
  updates: z.object({
    devices_total: z.number(),
    versions: z.array(z.object({ version: z.string().nullable(), devices: z.number() })),
  }),
});
export type ConsoleHealth = z.infer<typeof HealthSchema>;

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await authFetch(path);
  if (!res.ok) throw await apiRequestError(res);
  return schema.parse(await res.json());
}

export const getConsoleOverview = () => getJson("/api/v1/console/overview", OverviewSchema);
export const getConsoleHealth = () => getJson("/api/v1/console/health", HealthSchema);

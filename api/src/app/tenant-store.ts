/** Tenant, licence and activation queries shared by several route families. */
import { EditionCatalogError, editionExists } from "../edition-catalog-store.js";
import type { EditionId } from "../edition-catalog.js";
import type { Database } from "../db/database.js";
import { structuredLog } from "./runtime.js";

export function createTenantStore(db: Database) {
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

  async function countActiveActivations(licenseId: string): Promise<number> {
    const row = await db.get("SELECT COUNT(*) as count FROM machine_activations WHERE license_id = ? AND revoked_at IS NULL", licenseId) as { count: number };
    return row.count;
  }

  return { tenantWriteFailure, insertTenantRow, updateTenantRow, pickActiveLicenseForTenant, countActiveActivations };
}

export type TenantStore = ReturnType<typeof createTenantStore>;

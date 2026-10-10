/**
 * Persisted edition catalog (Postgres). Runtime SSOT for capabilities stamped into envelopes.
 * Functions run on the caller's transaction when called inside Database.tx.
 */
import type { Database } from "./db/database.js";

import {
  CapabilitiesMapSchema,
  EDITION_LABELS,
  SYSTEM_EDITION_IDS,
  capabilitiesMapForEdition,
  listFactoryEditionCatalog,
  repairCapabilitiesJson,
  serializeCapabilitiesMap,
  type CapabilitiesMap,
  type EditionCatalogEntry,
  type SystemEditionId,
} from "./edition-catalog.js";

type EditionRow = {
  id: string;
  label: string;
  capabilities_json: string;
  is_system: number;
  row_version: number;
  updated_at: string | null;
  updated_by: string | null;
};

export type EditionCatalogErrorCode =
  | "edition_not_found"
  | "edition_version_conflict"
  | "edition_in_use"
  | "edition_system_immutable"
  | "edition_id_taken"
  | "catalog_schema_invalid"
  | "edition_id_invalid";

export class EditionCatalogError extends Error {
  constructor(
    public readonly code: EditionCatalogErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EditionCatalogError";
  }
}

function rowToEntry(row: EditionRow): EditionCatalogEntry {
  const repaired = repairCapabilitiesJson(row.capabilities_json);
  if (!repaired) {
    throw new EditionCatalogError(
      "catalog_schema_invalid",
      `Corrupt capabilities_json for edition ${row.id}`,
    );
  }
  return {
    id: row.id,
    label: row.label,
    capabilities: repaired.map,
    is_system: row.is_system === 1,
    row_version: row.row_version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

export async function seedEditionCatalogIfEmpty(db: Database): Promise<void> {
  const count = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM edition_catalog"))!;
  if (count.c > 0) return;

  const now = new Date().toISOString();
  await db.tx(async () => {
    for (const entry of listFactoryEditionCatalog()) {
      await db.run(
        `INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
         VALUES (?, ?, ?, 1, 1, ?, 'system-seed')`,
        entry.id,
        entry.label,
        serializeCapabilitiesMap(entry.capabilities),
        now,
      );
    }
  });
}

/**
 * When MODULE_CAPABILITY_KEYS grows, add missing keys as false (fail-closed).
 * Corrupt rows are left untouched (sign path will fail closed).
 */
export async function repairAllEditionCapabilities(db: Database): Promise<number> {
  const rows = await db.all<{ id: string; capabilities_json: string; row_version: number }>(
    "SELECT id, capabilities_json, row_version FROM edition_catalog",
  );
  let repaired = 0;
  const now = new Date().toISOString();
  await db.tx(async () => {
    for (const row of rows) {
      const result = repairCapabilitiesJson(row.capabilities_json);
      if (!result) continue;
      if (!result.changed) continue;
      await db.run(
        `UPDATE edition_catalog
         SET capabilities_json = ?, row_version = row_version + 1, updated_at = ?, updated_by = 'schema-repair'
         WHERE id = ?`,
        result.json,
        now,
        row.id,
      );
      repaired += 1;
    }
  });
  return repaired;
}

export async function listEditions(db: Database): Promise<EditionCatalogEntry[]> {
  const rows = await db.all<EditionRow>(
    `SELECT id, label, capabilities_json, is_system, row_version, updated_at, updated_by
     FROM edition_catalog
     ORDER BY is_system DESC, id ASC`,
  );
  return rows.map((row) => {
    try {
      return rowToEntry(row);
    } catch {
      // Surface corrupt rows with empty-but-fail-closed map for listing; sign still fails.
      const fallback = {} as CapabilitiesMap;
      for (const k of Object.keys(capabilitiesMapForEdition("core")) as Array<keyof CapabilitiesMap>) {
        fallback[k] = false;
      }
      return {
        id: row.id,
        label: row.label,
        capabilities: fallback,
        is_system: row.is_system === 1,
        row_version: row.row_version,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      };
    }
  });
}

export async function getEdition(db: Database, id: string): Promise<EditionCatalogEntry | null> {
  const row = await db.get<EditionRow>(
    `SELECT id, label, capabilities_json, is_system, row_version, updated_at, updated_by
     FROM edition_catalog WHERE id = ?`,
    id,
  );
  if (!row) return null;
  return rowToEntry(row);
}

export async function editionExists(db: Database, id: string): Promise<boolean> {
  const row = await db.get<{ ok: number }>("SELECT 1 AS ok FROM edition_catalog WHERE id = ?", id);
  return !!row;
}

/**
 * Load capabilities for signing. Throws catalog_schema_invalid / edition_not_found.
 * Caller should run inside db.tx for issue/activate.
 */
export async function loadCapabilitiesJsonForSign(
  db: Database,
  editionId: string,
): Promise<{
  capabilities_json: string;
  tier: string;
  row_version: number;
}> {
  const row = await db.get<{ id: string; capabilities_json: string; row_version: number }>(
    `SELECT id, capabilities_json, row_version FROM edition_catalog WHERE id = ?`,
    editionId,
  );
  if (!row) {
    throw new EditionCatalogError("edition_not_found", `Edition '${editionId}' not found in catalog`);
  }
  const repaired = repairCapabilitiesJson(row.capabilities_json);
  if (!repaired) {
    throw new EditionCatalogError(
      "catalog_schema_invalid",
      `Corrupt capabilities_json for edition ${editionId}`,
    );
  }
  return {
    capabilities_json: repaired.json,
    tier: row.id,
    row_version: row.row_version,
  };
}

export async function countTenantsUsingEdition(db: Database, editionId: string): Promise<number> {
  const row = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tenants WHERE edition = ?", editionId))!;
  return row.c;
}

export async function createEdition(
  db: Database,
  input: {
    id: string;
    label: string;
    capabilities: CapabilitiesMap;
    actorId: string;
  },
): Promise<EditionCatalogEntry> {
  const parsedCaps = CapabilitiesMapSchema.parse(input.capabilities);
  if (await editionExists(db, input.id)) {
    throw new EditionCatalogError("edition_id_taken", `Edition id '${input.id}' already exists`);
  }
  const now = new Date().toISOString();
  const json = serializeCapabilitiesMap(parsedCaps);
  await db.run(
    `INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
    input.id,
    input.label.trim(),
    json,
    now,
    input.actorId,
  );
  const created = await getEdition(db, input.id);
  if (!created) throw new EditionCatalogError("edition_not_found", "Create succeeded but row missing");
  return created;
}

export async function updateEdition(
  db: Database,
  id: string,
  input: {
    label?: string;
    capabilities: CapabilitiesMap;
    expected_row_version: number;
    actorId: string;
  },
): Promise<EditionCatalogEntry> {
  const existing = await db.get<{ id: string; is_system: number; row_version: number }>(
    `SELECT id, is_system, row_version FROM edition_catalog WHERE id = ?`,
    id,
  );
  if (!existing) {
    throw new EditionCatalogError("edition_not_found", `Edition '${id}' not found`);
  }
  const parsedCaps = CapabilitiesMapSchema.parse(input.capabilities);
  const json = serializeCapabilitiesMap(parsedCaps);
  const now = new Date().toISOString();
  const label = input.label?.trim();

  const result = label
    ? await db.run(
        `UPDATE edition_catalog
         SET label = ?, capabilities_json = ?, row_version = row_version + 1,
             updated_at = ?, updated_by = ?
         WHERE id = ? AND row_version = ?`,
        label,
        json,
        now,
        input.actorId,
        id,
        input.expected_row_version,
      )
    : await db.run(
        `UPDATE edition_catalog
         SET capabilities_json = ?, row_version = row_version + 1,
             updated_at = ?, updated_by = ?
         WHERE id = ? AND row_version = ?`,
        json,
        now,
        input.actorId,
        id,
        input.expected_row_version,
      );

  if (result.changes === 0) {
    throw new EditionCatalogError(
      "edition_version_conflict",
      `Edition '${id}' was modified by another operator`,
      { expected_row_version: input.expected_row_version },
    );
  }
  const updated = await getEdition(db, id);
  if (!updated) throw new EditionCatalogError("edition_not_found", "Update succeeded but row missing");
  return updated;
}

/** Postgres foreign_key_violation: tenants.edition still references the row. */
function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23503";
}

export async function deleteEdition(db: Database, id: string): Promise<void> {
  const existing = await db.get<{ id: string; is_system: number }>(
    `SELECT id, is_system FROM edition_catalog WHERE id = ?`,
    id,
  );
  if (!existing) {
    throw new EditionCatalogError("edition_not_found", `Edition '${id}' not found`);
  }
  if (existing.is_system === 1) {
    throw new EditionCatalogError(
      "edition_system_immutable",
      "System editions cannot be deleted",
    );
  }
  const inUse = await countTenantsUsingEdition(db, id);
  if (inUse > 0) {
    throw new EditionCatalogError(
      "edition_in_use",
      `Edition '${id}' is assigned to ${inUse} tenant(s)`,
      { tenant_count: inUse },
    );
  }
  try {
    await db.run("DELETE FROM edition_catalog WHERE id = ?", id);
  } catch (err) {
    // A tenant was assigned between the count and the delete: the FK (ON DELETE RESTRICT) refuses.
    if (isForeignKeyViolation(err)) {
      throw new EditionCatalogError(
        "edition_in_use",
        `Edition '${id}' is still referenced by tenants`,
      );
    }
    throw err;
  }
}

/** Ensure system editions exist even if catalog was partially wiped (id restore only). */
export async function ensureSystemEditionsPresent(db: Database): Promise<void> {
  const now = new Date().toISOString();
  for (const id of SYSTEM_EDITION_IDS) {
    await db.run(
      `INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 1, ?, 'system-seed')
       ON CONFLICT (id) DO NOTHING`,
      id,
      EDITION_LABELS[id as SystemEditionId],
      serializeCapabilitiesMap(capabilitiesMapForEdition(id as SystemEditionId)),
      now,
    );
  }
}

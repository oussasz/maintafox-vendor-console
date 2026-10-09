/**
 * Persisted edition catalog (SQLite). Runtime SSOT for capabilities stamped into envelopes.
 */
import type Database from "better-sqlite3";

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

export function ensureEditionCatalogSchema(db: Database.Database): void {
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS edition_catalog (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      row_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NULL,
      updated_by TEXT NULL
    );
  `);

  // Soft FK guard: SQLite cannot add REFERENCES to an already-altered tenants.edition column
  // without a table rebuild. This trigger enforces ON DELETE RESTRICT for all tenants
  // (including inactive / uninitialized).
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS edition_catalog_delete_guard
    BEFORE DELETE ON edition_catalog
    BEGIN
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM tenants WHERE edition = OLD.id)
        THEN RAISE(ABORT, 'edition_in_use')
      END;
    END;
  `);
}

export function seedEditionCatalogIfEmpty(db: Database.Database): void {
  const count = db.prepare("SELECT COUNT(*) AS c FROM edition_catalog").get() as { c: number };
  if (count.c > 0) return;

  const insert = db.prepare(
    `INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
     VALUES (?, ?, ?, 1, 1, ?, 'system-seed')`,
  );
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const entry of listFactoryEditionCatalog()) {
      insert.run(entry.id, entry.label, serializeCapabilitiesMap(entry.capabilities), now);
    }
  });
  tx();
}

/**
 * When MODULE_CAPABILITY_KEYS grows, add missing keys as false (fail-closed).
 * Corrupt rows are left untouched (sign path will fail closed).
 */
export function repairAllEditionCapabilities(db: Database.Database): number {
  const rows = db.prepare("SELECT id, capabilities_json, row_version FROM edition_catalog").all() as Array<{
    id: string;
    capabilities_json: string;
    row_version: number;
  }>;
  const update = db.prepare(
    `UPDATE edition_catalog
     SET capabilities_json = ?, row_version = row_version + 1, updated_at = ?, updated_by = 'schema-repair'
     WHERE id = ?`,
  );
  let repaired = 0;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const result = repairCapabilitiesJson(row.capabilities_json);
      if (!result) continue;
      if (!result.changed) continue;
      update.run(result.json, now, row.id);
      repaired += 1;
    }
  });
  tx();
  return repaired;
}

export function listEditions(db: Database.Database): EditionCatalogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, label, capabilities_json, is_system, row_version, updated_at, updated_by
       FROM edition_catalog
       ORDER BY is_system DESC, id ASC`,
    )
    .all() as EditionRow[];
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

export function getEdition(db: Database.Database, id: string): EditionCatalogEntry | null {
  const row = db
    .prepare(
      `SELECT id, label, capabilities_json, is_system, row_version, updated_at, updated_by
       FROM edition_catalog WHERE id = ?`,
    )
    .get(id) as EditionRow | undefined;
  if (!row) return null;
  return rowToEntry(row);
}

export function editionExists(db: Database.Database, id: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM edition_catalog WHERE id = ?").get(id) as
    | { ok: number }
    | undefined;
  return !!row;
}

/**
 * Load capabilities for signing. Throws catalog_schema_invalid / edition_not_found.
 * Caller should run inside db.transaction for issue/activate.
 */
export function loadCapabilitiesJsonForSign(db: Database.Database, editionId: string): {
  capabilities_json: string;
  tier: string;
  row_version: number;
} {
  const row = db
    .prepare(
      `SELECT id, capabilities_json, row_version FROM edition_catalog WHERE id = ?`,
    )
    .get(editionId) as { id: string; capabilities_json: string; row_version: number } | undefined;
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

export function countTenantsUsingEdition(db: Database.Database, editionId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM tenants WHERE edition = ?").get(editionId) as {
    c: number;
  };
  return row.c;
}

export function createEdition(
  db: Database.Database,
  input: {
    id: string;
    label: string;
    capabilities: CapabilitiesMap;
    actorId: string;
  },
): EditionCatalogEntry {
  const parsedCaps = CapabilitiesMapSchema.parse(input.capabilities);
  if (editionExists(db, input.id)) {
    throw new EditionCatalogError("edition_id_taken", `Edition id '${input.id}' already exists`);
  }
  const now = new Date().toISOString();
  const json = serializeCapabilitiesMap(parsedCaps);
  db.prepare(
    `INSERT INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).run(input.id, input.label.trim(), json, now, input.actorId);
  const created = getEdition(db, input.id);
  if (!created) throw new EditionCatalogError("edition_not_found", "Create succeeded but row missing");
  return created;
}

export function updateEdition(
  db: Database.Database,
  id: string,
  input: {
    label?: string;
    capabilities: CapabilitiesMap;
    expected_row_version: number;
    actorId: string;
  },
): EditionCatalogEntry {
  const existing = db
    .prepare(`SELECT id, is_system, row_version FROM edition_catalog WHERE id = ?`)
    .get(id) as { id: string; is_system: number; row_version: number } | undefined;
  if (!existing) {
    throw new EditionCatalogError("edition_not_found", `Edition '${id}' not found`);
  }
  const parsedCaps = CapabilitiesMapSchema.parse(input.capabilities);
  const json = serializeCapabilitiesMap(parsedCaps);
  const now = new Date().toISOString();
  const label = input.label?.trim();

  const result = label
    ? db
        .prepare(
          `UPDATE edition_catalog
           SET label = ?, capabilities_json = ?, row_version = row_version + 1,
               updated_at = ?, updated_by = ?
           WHERE id = ? AND row_version = ?`,
        )
        .run(label, json, now, input.actorId, id, input.expected_row_version)
    : db
        .prepare(
          `UPDATE edition_catalog
           SET capabilities_json = ?, row_version = row_version + 1,
               updated_at = ?, updated_by = ?
           WHERE id = ? AND row_version = ?`,
        )
        .run(json, now, input.actorId, id, input.expected_row_version);

  if (result.changes === 0) {
    throw new EditionCatalogError(
      "edition_version_conflict",
      `Edition '${id}' was modified by another operator`,
      { expected_row_version: input.expected_row_version },
    );
  }
  const updated = getEdition(db, id);
  if (!updated) throw new EditionCatalogError("edition_not_found", "Update succeeded but row missing");
  return updated;
}

export function deleteEdition(db: Database.Database, id: string): void {
  const existing = db
    .prepare(`SELECT id, is_system FROM edition_catalog WHERE id = ?`)
    .get(id) as { id: string; is_system: number } | undefined;
  if (!existing) {
    throw new EditionCatalogError("edition_not_found", `Edition '${id}' not found`);
  }
  if (existing.is_system === 1) {
    throw new EditionCatalogError(
      "edition_system_immutable",
      "System editions cannot be deleted",
    );
  }
  const inUse = countTenantsUsingEdition(db, id);
  if (inUse > 0) {
    throw new EditionCatalogError(
      "edition_in_use",
      `Edition '${id}' is assigned to ${inUse} tenant(s)`,
      { tenant_count: inUse },
    );
  }
  try {
    db.prepare("DELETE FROM edition_catalog WHERE id = ?").run(id);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("edition_in_use")) {
      throw new EditionCatalogError(
        "edition_in_use",
        `Edition '${id}' is still referenced by tenants`,
      );
    }
    throw err;
  }
}

/** Ensure system editions exist even if catalog was partially wiped (id restore only). */
export function ensureSystemEditionsPresent(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO edition_catalog (id, label, capabilities_json, is_system, row_version, updated_at, updated_by)
     VALUES (?, ?, ?, 1, 1, ?, 'system-seed')`,
  );
  const now = new Date().toISOString();
  for (const id of SYSTEM_EDITION_IDS) {
    insert.run(
      id,
      EDITION_LABELS[id as SystemEditionId],
      serializeCapabilitiesMap(capabilitiesMapForEdition(id as SystemEditionId)),
      now,
    );
  }
}

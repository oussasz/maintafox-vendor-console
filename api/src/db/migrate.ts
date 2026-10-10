/**
 * Versioned schema migrations: `api/migrations/NNN_name.sql`, applied once each, in ascending
 * order, each in its own transaction, and recorded in `schema_migrations` with a checksum.
 * A recorded migration whose file changed, or a recorded version missing from the build (database
 * newer than the code), stops startup instead of running against an unknown schema.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "./database.js";

/** `api/migrations` (the Docker image copies it to /app/api/migrations next to dist/). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export type MigrationFile = { version: number; name: string; sql: string; checksum: string };

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(dir)) {
    const m = FILE_PATTERN.exec(entry);
    if (!m) {
      if (entry.endsWith(".sql")) {
        throw new Error(`migration file name '${entry}' does not match NNN_lower_snake.sql`);
      }
      continue;
    }
    // Normalise line endings so a Windows checkout and the Linux image agree on the checksum.
    const sql = readFileSync(join(dir, entry), "utf8").replace(/\r\n/g, "\n");
    files.push({
      version: Number(m[1]),
      name: m[2]!,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i += 1) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new Error(`duplicate migration version ${files[i]!.version}`);
    }
  }
  return files;
}

export type MigrationReport = { applied: string[]; alreadyApplied: number };

export async function runMigrations(
  db: Database,
  log: (event: string, fields: Record<string, unknown>) => void,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationReport> {
  const files = loadMigrationFiles(dir);
  // Session-level lock on a dedicated connection: a second API instance waits instead of racing.
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('mfx:schema_migrations', 0))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const appliedRows = (
      await client.query<{ version: number; name: string; checksum: string }>(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    const byVersion = new Map(files.map((f) => [f.version, f]));
    for (const row of appliedRows) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new Error(
          `database has migration ${row.version}_${row.name} which this build does not know (database is newer than the code)`,
        );
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `migration ${row.version}_${row.name} was modified after it was applied (checksum mismatch); add a new migration instead`,
        );
      }
    }
    const appliedVersions = new Set(appliedRows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of files) {
      if (appliedVersions.has(file.version)) continue;
      const label = `${String(file.version).padStart(3, "0")}_${file.name}`;
      try {
        await client.query("BEGIN");
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${label} failed and was rolled back: ${(err as Error).message}`);
      }
      applied.push(label);
      log("schema_migration_applied", { migration: label });
    }
    return { applied, alreadyApplied: appliedRows.length };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('mfx:schema_migrations', 0))");
    } finally {
      client.release();
    }
  }
}

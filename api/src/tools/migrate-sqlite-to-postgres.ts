/**
 * One-shot import of the legacy SQLite control plane (control-plane.db) into Postgres.
 *
 *   DATABASE_URL=postgres://... node dist/tools/migrate-sqlite-to-postgres.js --sqlite /data/control-plane.db [--dry-run]
 *
 * - Applies the schema migrations, then copies every control-plane table in one transaction.
 * - Refuses to run twice (control_plane_sqlite_import marker), refuses a non-empty target, and
 *   refuses source tables or columns it does not know (nothing is dropped silently). Columns that
 *   only exist on legacy VPS tenant tables are kept in tenants.legacy_attributes_json.
 * - Verifies per-table row counts and re-verifies the audit hash chain on the source and on the
 *   copied rows before committing. --dry-run does everything and then rolls the copy back.
 * - The SQLite file is opened read-only and never modified (rollback = keep using it).
 * - SQLite sync fallback tables (only present when the API ran without DATABASE_URL) are refused
 *   unless --discard-sqlite-sync-fallback is given: live sync data is already in Postgres.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";

import SqliteDatabase from "better-sqlite3";

import { AUDIT_RECORD_COLUMNS, verifyAuditChain, type AuditRecordRow } from "../audit-chain.js";
import { openDatabase, type Database, type SqlParam } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";

/** Copy order respects foreign keys. */
const CONTROL_PLANE_TABLES = [
  "users",
  "edition_catalog",
  "tenants",
  "license_keys",
  "machine_activations",
  "audit_records",
  "support_tickets",
  "support_ticket_interventions",
  "diagnostic_bundles",
  "diagnostic_bundle_artifacts",
  "offline_ticket_reconciliation",
  "incident_runbooks",
  "cohort_update_policies",
  "tenant_update_policy_history",
  "cohort_update_policy_history",
  "idempotency_keys",
  "payment_orders",
] as const;

/** Tables created by the old SQLite sync fallback (API without DATABASE_URL). */
const SQLITE_SYNC_FALLBACK_TABLES = [
  "tenant_sync_state",
  "sync_mirror_ingress",
  "sync_exchange_idempotency",
  "sync_device_cursor",
  "sync_rejection_log",
];

const LEGACY_ATTRIBUTES_COLUMN = "legacy_attributes_json";
const INSERT_BATCH_ROWS = 500;

type Args = { sqlitePath: string; dryRun: boolean; discardSyncFallback: boolean };

class ImportRefused extends Error {}

function parseArgs(argv: string[]): Args {
  let sqlitePath: string | null = null;
  let dryRun = false;
  let discardSyncFallback = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--sqlite") {
      sqlitePath = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--discard-sqlite-sync-fallback") {
      discardSyncFallback = true;
    } else {
      throw new ImportRefused(`unknown argument '${a}'`);
    }
  }
  if (!sqlitePath) {
    throw new ImportRefused("--sqlite <path to control-plane.db> is required");
  }
  return { sqlitePath: resolve(sqlitePath), dryRun, discardSyncFallback };
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function sqliteTables(src: SqliteDatabase.Database): Set<string> {
  const rows = src
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function sqliteColumns(src: SqliteDatabase.Database, table: string): string[] {
  return (src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function sqliteCount(src: SqliteDatabase.Database, table: string): number {
  return (src.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

async function pgColumns(
  db: Database,
  table: string,
): Promise<Array<{ column_name: string; is_nullable: string; column_default: string | null; is_identity: string }>> {
  return db.all(
    `SELECT column_name, is_nullable, column_default, is_identity
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY ordinal_position`,
    table,
  );
}

type TableReport = {
  source_rows: number;
  copied_rows: number;
  source_absent: boolean;
  legacy_columns_kept: string[];
  target_defaults_used: string[];
};

async function copyTable(
  src: SqliteDatabase.Database,
  db: Database,
  table: string,
  present: boolean,
): Promise<TableReport> {
  const target = await pgColumns(db, table);
  if (target.length === 0) {
    throw new ImportRefused(`target table ${table} does not exist (migrations not applied?)`);
  }
  if (!present) {
    return { source_rows: 0, copied_rows: 0, source_absent: true, legacy_columns_kept: [], target_defaults_used: [] };
  }
  const sourceCols = sqliteColumns(src, table);
  const targetNames = new Set(target.map((c) => c.column_name));
  const extras = sourceCols.filter((c) => !targetNames.has(c));
  if (extras.length > 0 && table !== "tenants") {
    throw new ImportRefused(`source table ${table} has columns unknown to the Postgres schema: ${extras.join(", ")}`);
  }
  const common = sourceCols.filter((c) => targetNames.has(c));
  const missing = target.filter(
    (c) => !sourceCols.includes(c.column_name) && c.column_name !== LEGACY_ATTRIBUTES_COLUMN,
  );
  for (const col of missing) {
    if (col.is_nullable !== "YES" && col.column_default === null && col.is_identity !== "YES") {
      throw new ImportRefused(`source table ${table} lacks required column ${col.column_name}`);
    }
  }

  const insertCols = extras.length > 0 ? [...common, LEGACY_ATTRIBUTES_COLUMN] : common;
  const sourceCount = sqliteCount(src, table);
  const rows = src.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as IterableIterator<
    Record<string, SqlParam>
  >;
  let batch: SqlParam[][] = [];
  let copied = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const params: SqlParam[] = [];
    const tuples = batch.map((values) => {
      const placeholders = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await db.query(`INSERT INTO ${table} (${insertCols.join(", ")}) VALUES ${tuples.join(", ")}`, params);
    copied += result.rowCount ?? 0;
    batch = [];
  };
  for (const row of rows) {
    const values: SqlParam[] = common.map((c) => row[c] ?? null);
    if (extras.length > 0) {
      const legacy: Record<string, SqlParam> = {};
      for (const c of extras) legacy[c] = row[c] ?? null;
      values.push(JSON.stringify(legacy));
    }
    batch.push(values);
    if (batch.length >= INSERT_BATCH_ROWS) await flush();
  }
  await flush();
  return {
    source_rows: sourceCount,
    copied_rows: copied,
    source_absent: false,
    legacy_columns_kept: extras,
    target_defaults_used: missing.map((c) => c.column_name),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    throw new ImportRefused("environment variable DATABASE_URL is required");
  }
  if (!existsSync(args.sqlitePath)) {
    throw new ImportRefused(`SQLite file not found: ${args.sqlitePath}`);
  }

  const sourceSha256 = await fileSha256(args.sqlitePath);
  const src = new SqliteDatabase(args.sqlitePath, { readonly: true, fileMustExist: true });
  const db = await openDatabase(databaseUrl, "maintafox-sqlite-import");
  try {
    const integrity = src.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
      throw new ImportRefused(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
    }
    const fkProblems = src.prepare("PRAGMA foreign_key_check").all();
    if (fkProblems.length > 0) {
      throw new ImportRefused(
        `SQLite foreign_key_check reports ${fkProblems.length} violation(s): ${JSON.stringify(fkProblems.slice(0, 20))}`,
      );
    }

    const tables = sqliteTables(src);
    const known = new Set<string>([...CONTROL_PLANE_TABLES, ...SQLITE_SYNC_FALLBACK_TABLES]);
    const unknown = [...tables].filter((t) => !known.has(t));
    if (unknown.length > 0) {
      throw new ImportRefused(`SQLite contains tables this import does not know: ${unknown.join(", ")}`);
    }
    const syncFallbackRows: Record<string, number> = {};
    for (const t of SQLITE_SYNC_FALLBACK_TABLES) {
      if (tables.has(t)) syncFallbackRows[t] = sqliteCount(src, t);
    }
    const syncFallbackTotal = Object.values(syncFallbackRows).reduce((a, b) => a + b, 0);
    if (syncFallbackTotal > 0 && !args.discardSyncFallback) {
      throw new ImportRefused(
        `SQLite holds sync fallback data ${JSON.stringify(syncFallbackRows)}. It is not imported; re-run with --discard-sqlite-sync-fallback to confirm it can be left behind.`,
      );
    }

    const sourceAudit = tables.has("audit_records")
      ? verifyAuditChain(
          src.prepare(`SELECT ${AUDIT_RECORD_COLUMNS} FROM audit_records ORDER BY sequence ASC`).all() as AuditRecordRow[],
        )
      : { status: "ok" as const, checked_count: 0, first_bad_sequence: null };
    if (sourceAudit.status !== "ok") {
      throw new ImportRefused(
        `the SQLite audit hash chain is already invalid (${sourceAudit.status} at sequence ${sourceAudit.first_bad_sequence}); investigate before importing`,
      );
    }

    const migrations = await runMigrations(db, () => {});

    const report = await db
      .tx(async () => {
        await db.lockXact("mfx", "sqlite-import");
        const marker = await db.get<{ imported_at: Date; source_path: string }>(
          "SELECT imported_at, source_path FROM control_plane_sqlite_import WHERE id = 1",
        );
        if (marker) {
          throw new ImportRefused(
            `the SQLite control plane was already imported on ${marker.imported_at.toISOString()} from ${marker.source_path}; refusing to run twice`,
          );
        }
        for (const t of CONTROL_PLANE_TABLES) {
          const c = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`))!.c;
          if (c > 0) {
            throw new ImportRefused(
              `target table ${t} already has ${c} row(s); import only into a database where the new API has not run yet`,
            );
          }
        }

        const tableReports: Record<string, TableReport> = {};
        for (const t of CONTROL_PLANE_TABLES) {
          tableReports[t] = await copyTable(src, db, t, tables.has(t));
        }

        // The identity column continues after the copied ids.
        await db.query(
          `SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE((SELECT MAX(id) FROM users), 0) + 1, false)`,
        );

        const mismatches: string[] = [];
        for (const t of CONTROL_PLANE_TABLES) {
          const target = (await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`))!.c;
          const r = tableReports[t]!;
          if (target !== r.source_rows || r.copied_rows !== r.source_rows) {
            mismatches.push(`${t}: source ${r.source_rows}, copied ${r.copied_rows}, target ${target}`);
          }
        }
        if (mismatches.length > 0) {
          throw new ImportRefused(`row counts differ after copy: ${mismatches.join("; ")}`);
        }

        const targetAudit = verifyAuditChain(
          await db.all<AuditRecordRow>(`SELECT ${AUDIT_RECORD_COLUMNS} FROM audit_records ORDER BY sequence ASC`),
        );
        if (targetAudit.status !== "ok" || targetAudit.checked_count !== sourceAudit.checked_count) {
          throw new ImportRefused(
            `audit hash chain does not verify after copy: ${JSON.stringify(targetAudit)} (source checked ${sourceAudit.checked_count})`,
          );
        }

        const rowCounts = Object.fromEntries(Object.entries(tableReports).map(([t, r]) => [t, r.source_rows]));
        await db.run(
          `INSERT INTO control_plane_sqlite_import
             (id, imported_at, source_path, source_sha256, row_counts_json, audit_chain_records)
           VALUES (1, now(), $1, $2, $3, $4)`,
          args.sqlitePath,
          sourceSha256,
          JSON.stringify(rowCounts),
          targetAudit.checked_count,
        );

        const result = {
          status: args.dryRun ? "dry_run_ok_rolled_back" : "imported",
          source_path: args.sqlitePath,
          source_sha256: sourceSha256,
          migrations_applied_now: migrations.applied,
          tables: tableReports,
          audit_chain: { source: sourceAudit, target: targetAudit },
          sqlite_sync_fallback_rows_left_behind: syncFallbackRows,
        };
        if (args.dryRun) {
          // Roll the whole copy back; the report travels out on the error.
          throw Object.assign(new Error("dry-run rollback"), { dryRunReport: result });
        }
        return result;
      })
      .catch((err: unknown) => {
        const dryRunReport = (err as { dryRunReport?: unknown }).dryRunReport;
        if (dryRunReport) return dryRunReport;
        throw err;
      });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    src.close();
    await db.close();
  }
}

main().catch((err: unknown) => {
  const refused = err instanceof ImportRefused;
  process.stderr.write(
    `${JSON.stringify({ status: refused ? "refused" : "failed", error: err instanceof Error ? err.message : String(err) }, null, 2)}\n`,
  );
  process.stderr.write(
    "No control-plane rows were written (the copy runs in one transaction). Schema migrations may have been applied; they are idempotent and harmless for the old API.\n",
  );
  process.exitCode = 1;
});

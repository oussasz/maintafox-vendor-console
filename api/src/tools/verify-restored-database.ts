/**
 * Verifies a database restored from a backup (deploy/BACKUP_AND_RESTORE.md):
 *
 *   node dist/tools/verify-restored-database.js --database <name> --expected-counts <file>
 *
 * Connection: the standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD); --database names
 * the restored database. --expected-counts is the per-table row count read from the dump file
 * itself (deploy/backup/restore.sh), one `schema.table count` per line.
 *
 * Checks, all required to pass (exit 1 otherwise):
 *   - every migration of this build is recorded with the same checksum, and no unknown one;
 *   - every table in the dump has exactly the dumped number of rows, and no table is missing;
 *   - the audit ledger hash chain verifies (same code as GET /api/v1/audit/ledger/verify-chain).
 * Prints one JSON report on stdout.
 */
import { readFileSync } from "node:fs";

import pg from "pg";

import { AUDIT_RECORD_COLUMNS, verifyAuditChain, type AuditRecordRow } from "../audit-chain.js";
import { Database } from "../db/database.js";
import { loadMigrationFiles } from "../db/migrate.js";

type Args = { database: string; expectedCountsPath: string };

function parseArgs(argv: string[]): Args {
  let database: string | null = null;
  let expectedCountsPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--database") {
      database = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--expected-counts") {
      expectedCountsPath = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown argument '${a}'`);
    }
  }
  if (!database || !expectedCountsPath) {
    throw new Error("usage: verify-restored-database --database <name> --expected-counts <file>");
  }
  return { database, expectedCountsPath };
}

/** Parses `schema.table count` lines (blank lines ignored). */
export function parseExpectedCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*) (\d+)$/.exec(line);
    if (!m) {
      throw new Error(`expected-counts line ${index + 1} is not 'schema.table count': '${line}'`);
    }
    if (counts.has(m[1]!)) {
      throw new Error(`expected-counts lists ${m[1]} twice`);
    }
    counts.set(m[1]!, Number(m[2]));
  }
  return counts;
}

export type RestoreVerification = {
  ok: boolean;
  database: string;
  problems: string[];
  migrations: { expected: number; recorded: number };
  tables: Array<{ table: string; expected: number | null; restored: number }>;
  audit_chain: { status: string; checked_count: number; first_bad_sequence: number | null };
};

export async function verifyRestoredDatabase(
  db: Database,
  database: string,
  expected: Map<string, number>,
): Promise<RestoreVerification> {
  const problems: string[] = [];

  const files = loadMigrationFiles();
  const recorded = await db.all<{ version: number; name: string; checksum: string }>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  const recordedByVersion = new Map(recorded.map((r) => [r.version, r]));
  for (const file of files) {
    const row = recordedByVersion.get(file.version);
    if (!row) {
      problems.push(`migration ${file.version}_${file.name} is not recorded in the restored database`);
    } else if (row.checksum !== file.checksum) {
      problems.push(`migration ${file.version}_${file.name} checksum differs from this build`);
    }
  }
  const known = new Set(files.map((f) => f.version));
  for (const row of recorded) {
    if (!known.has(row.version)) {
      problems.push(`restored database has migration ${row.version}_${row.name} unknown to this build`);
    }
  }

  const tables = await db.all<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY schemaname, tablename`,
  );
  const tableReport: RestoreVerification["tables"] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const qualified = `${t.schemaname}.${t.tablename}`;
    seen.add(qualified);
    const row = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${pg.escapeIdentifier(t.schemaname)}.${pg.escapeIdentifier(t.tablename)}`,
    );
    const restored = row?.c ?? 0;
    const want = expected.get(qualified);
    tableReport.push({ table: qualified, expected: want ?? null, restored });
    if (want === undefined) {
      problems.push(`table ${qualified} exists in the restored database but has no data section in the dump`);
    } else if (want !== restored) {
      problems.push(`table ${qualified}: dump has ${want} rows, restored database has ${restored}`);
    }
  }
  for (const qualified of expected.keys()) {
    if (!seen.has(qualified)) {
      problems.push(`table ${qualified} is in the dump but missing from the restored database`);
    }
  }

  const auditRows = await db.all<AuditRecordRow>(
    `SELECT ${AUDIT_RECORD_COLUMNS} FROM audit_records ORDER BY sequence ASC`,
  );
  const chain = verifyAuditChain(auditRows);
  if (chain.status !== "ok") {
    problems.push(`audit chain ${chain.status} at sequence ${chain.first_bad_sequence}`);
  }

  return {
    ok: problems.length === 0,
    database,
    problems,
    migrations: { expected: files.length, recorded: recorded.length },
    tables: tableReport,
    audit_chain: chain,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const expected = parseExpectedCounts(readFileSync(args.expectedCountsPath, "utf8"));
  const db = new Database(
    new pg.Pool({ database: args.database, application_name: "maintafox-restore-verify", max: 2 }),
  );
  try {
    // A scratch database, read-only check: an unrecorded operator scope (recording it would add a
    // row and change the counts being verified).
    const report = await db.runInScope({ kind: "operator", actor: "system:restore-verify" }, () =>
      verifyRestoredDatabase(db, args.database, expected),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`verify-restored-database failed: ${(err as Error).message}\n`);
  process.exit(1);
});

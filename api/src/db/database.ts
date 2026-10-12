/**
 * Postgres data layer for the control API.
 *
 * - `get` / `all` / `run` accept `?` placeholders (converted to `$n`) so the route code keeps the
 *   statement shapes it had on SQLite; statements written with `$n` are passed through unchanged.
 * - `tx(fn)` runs `fn` in one transaction. The open transaction is carried by AsyncLocalStorage,
 *   so every helper called inside `fn` (audit append, catalog reads, ...) joins it without having
 *   to receive a client argument. A nested `tx` joins the outer transaction.
 * - `lockXact(namespace, key)` takes a transaction-scoped advisory lock.
 * - Tenant isolation (migration 007): every statement runs in a transaction as the role mfx_app,
 *   with the data scope of the current async context (`runInScope`): a tenant (device requests)
 *   or an operator actor (console and system tasks). Without a scope, row-level security makes
 *   every tenant-scoped table look empty. A statement outside `tx` gets its own transaction.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import pg from "pg";

// int8 (COUNT(*), BIGSERIAL ids, SUM) arrives as a string by default. Every bigint this API stores
// is far below 2^53, so parse it as a number and fail loudly if that ever stops being true.
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return n;
});

/** A JS array is sent as a Postgres array (use with `= ANY($n::text[])` / `unnest`). */
export type SqlParam = string | number | boolean | null | undefined | Date | Buffer | readonly string[];

export type RunResult = { changes: number };

/** Role every API transaction runs as (migration 007); subject to row-level security. */
export const APP_DB_ROLE = "mfx_app";

/**
 * Data scope of a request or task. `tenant`: only that tenant's rows (device requests).
 * `operator`: all tenants, for an identified vendor operator or system task (cross-tenant work
 * must be explicit; the API records each operator scope it opens in operator_scope_access).
 */
export type DbScope = { kind: "tenant"; tenantId: string } | { kind: "operator"; actor: string };

function sameScope(a: DbScope | undefined, b: DbScope): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "tenant" ? a.tenantId === (b as { tenantId: string }).tenantId : a.actor === (b as { actor: string }).actor;
}

/**
 * Rewrites `?` placeholders to `$1..$n`, skipping string literals, quoted identifiers and
 * comments. A statement that already uses `$n` placeholders is returned unchanged.
 */
export function toPgPlaceholders(sql: string): string {
  if (/\$\d/.test(sql)) return sql;
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function normalizeParams(params: SqlParam[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

export class Database {
  private readonly txClient = new AsyncLocalStorage<pg.PoolClient>();
  private readonly scopeStore = new AsyncLocalStorage<DbScope>();

  constructor(readonly pool: pg.Pool) {}

  /** The data scope of the current async context, if any. */
  currentScope(): DbScope | undefined {
    return this.scopeStore.getStore();
  }

  /**
   * Runs `fn` (and everything it calls, including later middleware when used as
   * `runInScope(scope, next)`) with this data scope. The scope of an open transaction is fixed.
   */
  runInScope<T>(scope: DbScope, fn: () => T): T {
    if (scope.kind === "tenant" && !scope.tenantId) throw new Error("tenant scope needs a tenant id");
    if (scope.kind === "operator" && !scope.actor) throw new Error("operator scope needs an actor");
    if (this.inTransaction() && !sameScope(this.currentScope(), scope)) {
      throw new Error("the data scope cannot change inside an open transaction");
    }
    return this.scopeStore.run(scope, fn);
  }

  /** True when called inside `tx`. */
  inTransaction(): boolean {
    return this.txClient.getStore() !== undefined;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<pg.QueryResult<T>> {
    const client = this.txClient.getStore();
    if (!client) {
      // Role and scope are transaction-local settings: a lone statement gets its own transaction.
      return this.tx(() => this.query<T>(sql, params));
    }
    return client.query<T>(toPgPlaceholders(sql), normalizeParams(params));
  }

  async get<T>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    const r = await this.query(sql, params);
    return r.rows[0] as T | undefined;
  }

  async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    const r = await this.query(sql, params);
    return r.rows as T[];
  }

  async run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    const r = await this.query(sql, params);
    return { changes: r.rowCount ?? 0 };
  }

  /** Runs `fn` in a transaction, or joins the transaction already open in this async context. */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTransaction()) {
      return fn();
    }
    const client = await this.pool.connect();
    let brokenConnection: Error | undefined;
    try {
      await client.query("BEGIN");
      const scope = this.currentScope();
      await client.query(
        "SELECT set_config('role', $1, true), set_config('mfx.tenant_id', $2, true), set_config('mfx.operator_actor', $3, true)",
        [APP_DB_ROLE, scope?.kind === "tenant" ? scope.tenantId : "", scope?.kind === "operator" ? scope.actor : ""],
      );
      const result = await this.txClient.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        // The connection is unusable; release(err) makes the pool discard it.
        brokenConnection = rollbackErr as Error;
      }
      throw err;
    } finally {
      client.release(brokenConnection);
    }
  }

  /**
   * Runs `fn` so that an error it throws can be caught by the caller without aborting the open
   * transaction (Postgres aborts the whole transaction on any failed statement otherwise).
   * Outside a transaction it simply runs `fn`.
   */
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.inTransaction()) {
      return fn();
    }
    const name = `mfx_sp_${++this.savepointSeq}`;
    await this.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await this.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  }

  private savepointSeq = 0;

  /**
   * Transaction-scoped advisory lock on `namespace:key`, held until the transaction ends.
   * Serializes writers that share the key. Must run inside `tx`.
   */
  async lockXact(namespace: string, key: string): Promise<void> {
    if (!this.inTransaction()) {
      throw new Error(`lockXact(${namespace}) called outside a transaction`);
    }
    await this.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${namespace}:${key}`]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Connections per API process. Sync exchanges hold one for their whole transaction. */
export const PG_POOL_MAX_CONNECTIONS = 20;
/** A request waiting longer than this for a free connection fails (500) instead of hanging. */
export const PG_CONNECTION_WAIT_TIMEOUT_MS = 10_000;
/**
 * Postgres ends a session whose transaction sits idle this long (e.g. a stalled process), so it
 * cannot hold a tenant sync lock indefinitely.
 */
export const PG_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** Opens the pool and verifies connectivity. Sessions run in UTC so text timestamps compare as UTC. */
export async function openDatabase(databaseUrl: string, applicationName: string): Promise<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max: PG_POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: PG_CONNECTION_WAIT_TIMEOUT_MS,
    options: `-c TimeZone=UTC -c idle_in_transaction_session_timeout=${PG_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  });
  pool.on("error", (err) => {
    // An idle client lost its connection; the pool replaces it. Log so it is visible.
    console.error(
      JSON.stringify({ at: new Date().toISOString(), event: "pg_pool_idle_error", message: err.message }),
    );
  });
  const db = new Database(pool);
  // Connectivity only, as the connection user: the mfx_app role does not exist before migration 007.
  await pool.query("SELECT 1");
  return db;
}

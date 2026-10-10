/**
 * Postgres data layer for the control API.
 *
 * - `get` / `all` / `run` accept `?` placeholders (converted to `$n`) so the route code keeps the
 *   statement shapes it had on SQLite; statements written with `$n` are passed through unchanged.
 * - `tx(fn)` runs `fn` in one transaction. The open transaction is carried by AsyncLocalStorage,
 *   so every helper called inside `fn` (audit append, catalog reads, ...) joins it without having
 *   to receive a client argument. A nested `tx` joins the outer transaction.
 * - `lockXact(namespace, key)` takes a transaction-scoped advisory lock.
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

  constructor(readonly pool: pg.Pool) {}

  /** True when called inside `tx`. */
  inTransaction(): boolean {
    return this.txClient.getStore() !== undefined;
  }

  private executor(): pg.Pool | pg.PoolClient {
    return this.txClient.getStore() ?? this.pool;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<pg.QueryResult<T>> {
    return this.executor().query<T>(toPgPlaceholders(sql), normalizeParams(params));
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

/** Opens the pool and verifies connectivity. Sessions run in UTC so text timestamps compare as UTC. */
export async function openDatabase(databaseUrl: string, applicationName: string): Promise<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    options: "-c TimeZone=UTC",
  });
  pool.on("error", (err) => {
    // An idle client lost its connection; the pool replaces it. Log so it is visible.
    console.error(
      JSON.stringify({ at: new Date().toISOString(), event: "pg_pool_idle_error", message: err.message }),
    );
  });
  const db = new Database(pool);
  await db.query("SELECT 1");
  return db;
}

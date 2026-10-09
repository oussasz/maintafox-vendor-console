import type Database from "better-sqlite3";

import { createPostgresSyncStore } from "./postgres-store.js";
import { createSqliteSyncStore } from "./sqlite-store.js";
import type { SyncStore } from "./store.js";

export { runSyncExchange } from "./exchange.js";
export type { SyncExchangeRequest, SyncExchangeResponse } from "./types.js";
export type { SyncStore } from "./store.js";

/**
 * Prefer Postgres when DATABASE_URL is set; otherwise SQLite fallback (dev / single-node).
 */
export async function openSyncStore(
  sqliteDb: Database.Database,
  databaseUrl: string | undefined,
): Promise<SyncStore> {
  const url = databaseUrl?.trim();
  if (url) {
    const store = await createPostgresSyncStore(url);
    await store.ensureSchema();
    return store;
  }
  const store = createSqliteSyncStore(sqliteDb);
  await store.ensureSchema();
  return store;
}

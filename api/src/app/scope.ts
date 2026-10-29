/**
 * Data scopes for tenant isolation (migration 007, api/src/db/database.ts).
 *
 * - Device requests run in their tenant's scope (activationAuthMiddleware).
 * - Vendor operators (authMiddleware) and system tasks (startup, retention, billing webhook) act
 *   across tenants only through an operator scope, opened here and recorded in
 *   operator_scope_access (actor, method, path, time).
 */
import type express from "express";

import type { Database, DbScope } from "../db/database.js";

export function tenantScope(tenantId: string): DbScope {
  return { kind: "tenant", tenantId };
}

/** Records and returns an operator scope for `actor` (`user_<id>` or `system:<task>`). */
export async function openOperatorScope(
  db: Database,
  actor: string,
  request?: { method: string; path: string },
): Promise<DbScope> {
  const scope: DbScope = { kind: "operator", actor };
  await db.runInScope(scope, () =>
    db.run(
      "INSERT INTO operator_scope_access (actor_id, method, path) VALUES (?, ?, ?)",
      actor,
      request?.method ?? null,
      request?.path ?? null,
    ),
  );
  return scope;
}

/** Runs a system task (no request) in a recorded operator scope `system:<task>`. */
export async function runAsSystem<T>(db: Database, task: string, fn: () => Promise<T>): Promise<T> {
  const scope = await openOperatorScope(db, `system:${task}`);
  return db.runInScope(scope, fn);
}

/** Deletes operator_scope_access rows older than `days` (run by the hourly retention timer). */
export async function pruneOperatorScopeAccess(db: Database, days: number): Promise<number> {
  const r = await db.run("DELETE FROM operator_scope_access WHERE accessed_at < now() - make_interval(days => $1)", days);
  return r.changes;
}

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>;

/** Public routes that must act across tenants (billing checkout and webhook): a recorded system scope. */
export function systemScopeMiddleware(db: Database, task: string): Middleware {
  return async (req, _res, next) => {
    const scope = await openOperatorScope(db, `system:${task}`, { method: req.method, path: req.path });
    db.runInScope(scope, next);
  };
}

/**
 * Activation preview / claim present only a licence key: its tenant is resolved by the one
 * cross-tenant lookup allowed here (mfx_license_key_tenant, migration 007) and the request runs in
 * that tenant's scope. An unknown key gets no scope, so it finds nothing (404 license_not_found).
 */
export function licenceKeyTenantScopeMiddleware(db: Database): Middleware {
  return async (req, _res, next) => {
    const key = (req.body as { license_key?: unknown } | undefined)?.license_key;
    const row =
      typeof key === "string"
        ? await db.get<{ tenant_id: string | null }>("SELECT mfx_license_key_tenant($1) AS tenant_id", key.trim())
        : undefined;
    if (row?.tenant_id) {
      db.runInScope(tenantScope(row.tenant_id), next);
      return;
    }
    next();
  };
}

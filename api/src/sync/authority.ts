/**
 * Authority data judged at ingest (sync-signing-design.md v9 §5): accounts, grants and roles are
 * accepted only from a maker allowed to change them, judged on the server's own current state,
 * which therefore only ever holds judged authority data (rows below the signing cutover are
 * legacy and taken as they are).
 *
 * The rules mirror the desktop (src-tauri/src):
 * - plant-wide right: settings/site.rs `tenant_right_holder_condition` (active account, and
 *   is_admin or a tenant-scope, non-emergency assignment in force whose role grants the right);
 * - plant administrator / lasting administrator: auth/last_admin.rs (is_admin, or Administrator /
 *   Superadmin tenant-wide, permanent, no end date; the built-in "admin" with a never-changed
 *   password does not count);
 * - takeover guard and self-grant: rbac/resolver.rs, sync/grant_check.rs.
 * Wire names (row_codec.rs): a reference `<x>_id` travels as `<x>_sync_id`, a catalog reference as
 * `<x>_key`; validity bounds are 'YYYY-MM-DDTHH:MM:SSZ' text.
 */
import type { Database } from "../db/database.js";
import { deliveredPayload } from "./store.js";
import type { PayloadCipher } from "./payload-crypto.js";

export const ELEVATED_ADMIN_ROLES: ReadonlySet<string> = new Set(["Administrator", "Superadmin"]);
export const ADMIN_RIGHTS: ReadonlySet<string> = new Set(["adm.users", "adm.roles"]);
const BUILTIN_ADMIN_USERNAME = "admin";

/** Columns a user may change on their own account without the user-administration right. */
export const SELF_CHANGE_COLUMNS: ReadonlySet<string> = new Set([
  "password_hash",
  "password_changed_at",
  "password_changed_by_sync_id",
  "password_set_by_sync_id",
  "password_set_at",
  "display_name",
  "email",
  "phone",
  "updated_at",
  // Cleared (1 -> 0) by the user's own password change; never raised by the user (checked below).
  "force_password_change",
]);

/**
 * Takeover guard: on the account of an administrator (or of a holder of an administration right),
 * any change except these profile columns needs a plant administrator. Listing what is allowed,
 * not what is guarded, keeps a new credential or link column guarded by default.
 */
export const ADMIN_ACCOUNT_PROFILE_COLUMNS: ReadonlySet<string> = new Set([
  "display_name",
  "email",
  "phone",
  "updated_at",
]);

export type AuthorityCtx = {
  db: Database;
  cipher: PayloadCipher;
  tenantId: string;
  /** 'YYYY-MM-DDTHH:MM:SSZ' (the desktop's assignment clock form). */
  now: string;
};

export type Verdict = { ok: true } | { ok: false; code: string; message: string };
const OK: Verdict = { ok: true };
const refuse = (message: string): Verdict => ({ ok: false, code: "authority_refused", message });

export function assignmentClock(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

type Payload = Record<string, unknown>;

export function parsePayloadObject(raw: string): Payload | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : null;
  } catch {
    return null;
  }
}

function truthy(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** The distinct string values among `values`. */
function strings(...values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** Current (opened) payload of one live entity, or null when absent or deleted. */
export async function livePayload(ctx: AuthorityCtx, entityType: string, entitySyncId: string): Promise<Payload | null> {
  const row = await ctx.db.get<{ payload_raw: string; deleted: boolean }>(
    `SELECT payload_raw, deleted FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = $2 AND entity_sync_id = $3`,
    ctx.tenantId,
    entityType,
    entitySyncId,
  );
  if (!row || row.deleted) return null;
  return parsePayloadObject(deliveredPayload(ctx.cipher, ctx.tenantId, entityType, entitySyncId, row.payload_raw));
}

export function accountUsable(account: Payload | null): account is Payload {
  return account !== null && truthy(account["is_active"]) && isBlank(account["deleted_at"]);
}

/** The built-in "admin" whose password was never changed (its default password is public). */
export function unchangedBuiltin(account: Payload): boolean {
  return (
    account["username"] === BUILTIN_ADMIN_USERNAME &&
    truthy(account["force_password_change"]) &&
    isBlank(account["password_changed_at"])
  );
}

/** Tenant-scope, permanent (non-emergency), in-force assignments of a user, with their role. */
async function permanentTenantAssignments(
  ctx: AuthorityCtx,
  userSyncId: string,
): Promise<Array<{ role_sync_id: string; valid_to: unknown }>> {
  const rows = await ctx.db.all<{ role_sync_id: string | null; valid_to: unknown }>(
    `SELECT payload_json->>'role_sync_id' AS role_sync_id, payload_json->>'valid_to' AS valid_to
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = 'user_scope_assignments' AND NOT deleted
       AND payload_json->>'user_sync_id' = $2
       AND payload_json->>'scope_type' = 'tenant'
       AND (payload_json->>'deleted_at') IS NULL
       AND COALESCE(payload_json->>'is_emergency', '0') IN ('0', 'false')
       AND ((payload_json->>'valid_from') IS NULL OR payload_json->>'valid_from' <= $3)
       AND ((payload_json->>'valid_to') IS NULL OR payload_json->>'valid_to' > $3)`,
    ctx.tenantId,
    userSyncId,
    ctx.now,
  );
  return rows.filter((r): r is { role_sync_id: string; valid_to: unknown } => typeof r.role_sync_id === "string");
}

/**
 * Rights granted by one role (its live role_permissions rows), by permission name; none when the
 * role itself is absent or soft-deleted (desktop tenant_right_holder_condition).
 */
export async function roleRights(ctx: AuthorityCtx, roleSyncId: string): Promise<Set<string>> {
  if ((await roleName(ctx, roleSyncId)) === null) return new Set();
  const rows = await ctx.db.all<{ permission_key: string | null }>(
    `SELECT payload_json->>'permission_key' AS permission_key
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = 'role_permissions' AND NOT deleted
       AND payload_json->>'role_sync_id' = $2
       AND (payload_json->>'deleted_at') IS NULL`,
    ctx.tenantId,
    roleSyncId,
  );
  return new Set(rows.map((r) => r.permission_key).filter((k): k is string => typeof k === "string"));
}

async function roleName(ctx: AuthorityCtx, roleSyncId: string): Promise<string | null> {
  const role = await livePayload(ctx, "roles", roleSyncId);
  if (!role || !isBlank(role["deleted_at"])) return null;
  return typeof role["name"] === "string" ? role["name"] : null;
}

/**
 * Whether a role could make its holders administrators, whatever its current state: an elevated
 * name, or a live role_permissions row giving an administration right. Used to judge GRANTING or
 * REVIVING a role: a soft-deleted role keeps its rights rows and can be brought back.
 */
async function roleCarriesAdministration(ctx: AuthorityCtx, roleSyncId: string): Promise<boolean> {
  // A role the server has never seen could be created later with administration rights (a grant
  // pushed ahead of its role): only a plant administrator may grant it.
  const known = await ctx.db.get<{ one: number }>(
    "SELECT 1 AS one FROM sync_entity_state WHERE tenant_id = $1 AND entity_type = 'roles' AND entity_sync_id = $2",
    ctx.tenantId,
    roleSyncId,
  );
  if (!known) return true;
  const role = await livePayload(ctx, "roles", roleSyncId);
  if (role && typeof role["name"] === "string" && ELEVATED_ADMIN_ROLES.has(role["name"])) return true;
  const row = await ctx.db.get<{ one: number }>(
    `SELECT 1 AS one FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = 'role_permissions' AND NOT deleted
       AND payload_json->>'role_sync_id' = $2
       AND (payload_json->>'deleted_at') IS NULL
       AND payload_json->>'permission_key' IN ('adm.users', 'adm.roles')
     LIMIT 1`,
    ctx.tenantId,
    roleSyncId,
  );
  return row !== undefined;
}

/**
 * Takeover guard subject: an account that is, or would be once reactivated or its role revived, an
 * administrator or a holder of an administration right. Ignores the account's active/deleted state
 * and the grants' validity window, so a deactivated administrator stays protected.
 */
async function administratorInAnyState(ctx: AuthorityCtx, userSyncId: string, account: Payload | null): Promise<boolean> {
  if (account && truthy(account["is_admin"])) return true;
  const grants = await ctx.db.all<{ role_sync_id: string | null }>(
    `SELECT payload_json->>'role_sync_id' AS role_sync_id
     FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = 'user_scope_assignments' AND NOT deleted
       AND payload_json->>'user_sync_id' = $2
       AND (payload_json->>'deleted_at') IS NULL`,
    ctx.tenantId,
    userSyncId,
  );
  for (const g of grants) {
    if (typeof g.role_sync_id === "string" && (await roleCarriesAdministration(ctx, g.role_sync_id))) return true;
  }
  return false;
}

/** settings/site.rs tenant_right_holder_condition, on the server state. */
export async function holdsTenantRight(ctx: AuthorityCtx, userSyncId: string, permission: string): Promise<boolean> {
  const account = await livePayload(ctx, "user_accounts", userSyncId);
  if (!accountUsable(account)) return false;
  if (truthy(account["is_admin"])) return true;
  for (const a of await permanentTenantAssignments(ctx, userSyncId)) {
    if ((await roleRights(ctx, a.role_sync_id)).has(permission)) return true;
  }
  return false;
}

/** Plant administrator: is_admin, or Administrator/Superadmin tenant-wide (permanent, in force). */
export async function isPlantAdministrator(ctx: AuthorityCtx, userSyncId: string, lastingOnly = false): Promise<boolean> {
  const account = await livePayload(ctx, "user_accounts", userSyncId);
  if (!accountUsable(account) || unchangedBuiltin(account)) return false;
  if (truthy(account["is_admin"])) return true;
  for (const a of await permanentTenantAssignments(ctx, userSyncId)) {
    if (lastingOnly && !isBlank(a.valid_to)) continue;
    const name = await roleName(ctx, a.role_sync_id);
    if (name !== null && ELEVATED_ADMIN_ROLES.has(name)) return true;
  }
  return false;
}

/** Lasting administrators of the tenant (auth/last_admin.rs lasting_administrator_ids). */
export async function lastingAdministratorCount(ctx: AuthorityCtx): Promise<number> {
  const users = await ctx.db.all<{ entity_sync_id: string }>(
    `SELECT entity_sync_id FROM sync_entity_state
     WHERE tenant_id = $1 AND entity_type = 'user_accounts' AND NOT deleted`,
    ctx.tenantId,
  );
  let count = 0;
  for (const u of users) {
    if (await isPlantAdministrator(ctx, u.entity_sync_id, true)) count += 1;
  }
  return count;
}

export function changedColumns(previous: Payload | null, next: Payload): string[] {
  const keys = new Set([...Object.keys(next), ...(previous ? Object.keys(previous) : [])]);
  return [...keys].filter(
    (k) => k !== "_sync_format" && JSON.stringify(next[k] ?? null) !== JSON.stringify(previous?.[k] ?? null),
  );
}

export type AuthorityItem = {
  entityType: string;
  entitySyncId: string;
  operation: string;
  /** Parsed payload of the item (null for a delete without a payload object). */
  payload: Payload | null;
  /** Server state before the item (null: create or not held). */
  previous: Payload | null;
  /** The item creates the entity again over the server's tombstone of it. */
  recreatesDeleted: boolean;
  right: "adm.users" | "adm.roles";
};

/**
 * Whether `maker` may make this authority change (design §5, rule 5). Founding and recovery items
 * are judged by the caller before this (they have no maker). The last-administrator rule is
 * checked by the caller after the state write.
 */
export async function judgeAuthorityChange(ctx: AuthorityCtx, item: AuthorityItem, maker: string): Promise<Verdict> {
  const next = item.payload ?? {};
  const isDelete = item.operation === "delete" || item.operation === "archive";

  if (item.entityType === "user_accounts" && maker === item.entitySyncId && item.previous && !isDelete) {
    // Self-change: only the user's own password and profile columns.
    const outside = changedColumns(item.previous, next).filter((c) => !SELF_CHANGE_COLUMNS.has(c));
    const raisesForce = truthy(next["force_password_change"]) && !truthy(item.previous["force_password_change"]);
    if (outside.length === 0 && !raisesForce) {
      return accountUsable(item.previous) ? OK : refuse("the account changing itself is not active");
    }
  }

  if (!(await holdsTenantRight(ctx, maker, item.right))) {
    return refuse(`the signer does not hold ${item.right} for the whole plant`);
  }
  const makerIsAdministrator = await isPlantAdministrator(ctx, maker);
  const needAdministrator = (why: string): Verdict =>
    makerIsAdministrator ? OK : refuse(`${why} needs a plant administrator`);

  switch (item.entityType) {
    case "user_accounts": {
      if (truthy(next["is_admin"]) && !truthy(item.previous?.["is_admin"])) {
        return needAdministrator("making an account an administrator");
      }
      if (item.recreatesDeleted) {
        // A deleted account keeps its grants: bringing it back is a takeover risk.
        return needAdministrator("re-creating a deleted account");
      }
      if (item.previous) {
        const touches =
          isDelete || changedColumns(item.previous, next).some((c) => !ADMIN_ACCOUNT_PROFILE_COLUMNS.has(c));
        // Judged whatever the account's state: a deactivated administrator stays protected.
        if (touches && (await administratorInAnyState(ctx, item.entitySyncId, item.previous))) {
          return needAdministrator("changing the credentials or status of an administrator");
        }
      }
      return OK;
    }
    case "user_scope_assignments": {
      // Both sides of a change are judged: the grant as it was and as it becomes.
      const subjects = strings(next["user_sync_id"], item.previous?.["user_sync_id"]);
      const roleIds = strings(next["role_sync_id"], item.previous?.["role_sync_id"]);
      if (!isDelete && isBlank(next["deleted_at"]) && next["user_sync_id"] === maker) {
        return refuse("nobody may grant a role to their own account");
      }
      for (const roleSyncId of roleIds) {
        // Whatever the role's state: a soft-deleted role keeps its rights and can be revived.
        if (await roleCarriesAdministration(ctx, roleSyncId)) {
          return needAdministrator("granting or changing an administration role");
        }
      }
      for (const subject of subjects) {
        const account = await livePayload(ctx, "user_accounts", subject);
        if (await administratorInAnyState(ctx, subject, account)) {
          return needAdministrator("changing the roles of an administrator");
        }
      }
      return OK;
    }
    case "role_permissions": {
      for (const key of strings(next["permission_key"], item.previous?.["permission_key"])) {
        if (ADMIN_RIGHTS.has(key)) return needAdministrator("giving or removing an administration right");
      }
      for (const roleSyncId of strings(next["role_sync_id"], item.previous?.["role_sync_id"])) {
        if (await roleCarriesAdministration(ctx, roleSyncId)) return needAdministrator("changing an administrator role");
      }
      return OK;
    }
    case "roles": {
      const names = [next["name"], item.previous?.["name"]].filter((n): n is string => typeof n === "string");
      if (names.some((n) => ELEVATED_ADMIN_ROLES.has(n)) || (await roleCarriesAdministration(ctx, item.entitySyncId))) {
        return needAdministrator("changing an administrator role");
      }
      return OK;
    }
    case "permissions": {
      const names = [next["name"], item.previous?.["name"]].filter((n): n is string => typeof n === "string");
      if (names.some((n) => ADMIN_RIGHTS.has(n))) return needAdministrator("changing an administration right");
      return OK;
    }
    default:
      return OK;
  }
}

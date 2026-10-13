/**
 * Startup configuration read from the environment. Evaluated once, at import, in the same order
 * as before the split: the process refuses to start (fatal) on a missing or invalid value.
 */
import "dotenv/config";

import { loadEntitlementSigningKey } from "../entitlement-signer.js";
import { loadEmailConfig, type EmailConfig } from "../notifications/email.js";
import { fatal, requireEnv } from "./runtime.js";

const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 32) {
  fatal("Set JWT_SECRET (min 32 characters) in the environment.");
}
export const JWT_SECRET: string = JWT_SECRET_RAW;

try {
  loadEntitlementSigningKey();
} catch (err) {
  fatal((err as Error).message);
}

const CORS_ORIGIN = requireEnv("CORS_ORIGIN");

/** Comma-separated `CORS_ORIGIN` (e.g. console + Tauri dev); empty segments ignored. */
function parseCorsOrigins(raw: string): string[] {
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.length === 0) {
    fatal("CORS_ORIGIN must list at least one origin.");
  }
  return list;
}

/**
 * Desktop (Tauri webview) origins, allowed ONLY on device routes (activation + sync).
 * Windows WebView2 serves the installed app from `http://tauri.localhost` (or
 * `https://tauri.localhost` with `useHttpsScheme`); macOS/Linux use `tauri://localhost`.
 * Optional: unset/empty means no desktop origin is allowed (logged at startup).
 * Each entry must be an exact `scheme://host[:port]` origin — no wildcard, path or `null`.
 */
function parseDesktopAppOrigins(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const origin of list) {
    if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)) {
      fatal(
        `DESKTOP_APP_ORIGINS entry "${origin}" is not an exact origin (expected scheme://host[:port], no wildcard or path).`,
      );
    }
  }
  return list;
}

export const CONSOLE_CORS_ORIGINS = parseCorsOrigins(CORS_ORIGIN);
export const DESKTOP_APP_ORIGINS = parseDesktopAppOrigins(process.env.DESKTOP_APP_ORIGINS);
if (DESKTOP_APP_ORIGINS.length === 0) {
  console.warn(
    "DESKTOP_APP_ORIGINS is not set: installed desktop apps cannot call activation/sync routes from their webview.",
  );
}

/** Routes the desktop app calls with a device token (or none, for activation preview/claim). */
export function isDeviceRoute(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("/api/v1/activation/") || p.startsWith("/api/v1/sync/");
}

/** Only read when the users table is empty (first boot); see seedAdminIfEmpty. */
export const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL?.trim();
export const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const NODE_ENV = process.env.NODE_ENV ?? "development";
const SEED_BEHAVIOR_RAW = (process.env.SEED_BEHAVIOR ?? (NODE_ENV === "production" ? "disabled" : "full")).toLowerCase();
export const SEED_BEHAVIOR = SEED_BEHAVIOR_RAW === "disabled" || SEED_BEHAVIOR_RAW === "safe" || SEED_BEHAVIOR_RAW === "full"
  ? SEED_BEHAVIOR_RAW
  : "disabled";
/** Minimum length of the X-Operator-Reason header on privileged actions. Always enforced. */
export const PRIVILEGED_REASON_MIN_LENGTH = 4;
/** Desktop clamps one push to 1000 outbox rows (sync/queries.rs get_sync_push_payload). */
export const SYNC_MAX_OUTBOX_BATCH = 1000;
/** Must stay <= nginx `client_max_body_size` on /api/v1/sync/exchange (deploy/nginx-edge.conf). */
export const SYNC_EXCHANGE_BODY_LIMIT = "32mb";
export const DEFAULT_JSON_BODY_LIMIT = "1mb";

/** All API data lives in Postgres (versioned migrations in api/migrations). */
export const DATABASE_URL = requireEnv("DATABASE_URL");

/**
 * Optional bearer token for Prometheus scraping of GET /api/v1/ops/metrics (>= 32 characters).
 * Unset: the endpoint accepts only vendor operator tokens, like every other ops route.
 */
export const METRICS_SCRAPE_TOKEN = (() => {
  const raw = process.env.METRICS_SCRAPE_TOKEN?.trim();
  if (!raw) return null;
  if (raw.length < 32) fatal("METRICS_SCRAPE_TOKEN must be at least 32 characters when set.");
  return raw;
})();

/** Email delivery of desktop notifications (notifications/email.ts); invalid settings stop startup. */
export const EMAIL_CONFIG: EmailConfig = (() => {
  try {
    return loadEmailConfig();
  } catch (err) {
    fatal((err as Error).message);
  }
})();

/**
 * How many days the backup container keeps local copies (the same BACKUP_LOCAL_RETENTION_DAYS it
 * reads), shown on the console's System health page. Optional for the API: unset, the page does
 * not show the figure.
 */
export const BACKUP_LOCAL_RETENTION_DAYS: number | null = (() => {
  const raw = process.env.BACKUP_LOCAL_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 1 && days <= 3650)) {
    fatal(`BACKUP_LOCAL_RETENTION_DAYS must be an integer 1..3650, got '${raw}'.`);
  }
  return days;
})();

/** Rows of operator_scope_access (who acted across tenants) older than this are pruned. */
export const OPERATOR_ACCESS_LOG_RETENTION_DAYS = (() => {
  const raw = requireEnv("OPERATOR_ACCESS_LOG_RETENTION_DAYS");
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 1 && days <= 3650)) {
    fatal(`OPERATOR_ACCESS_LOG_RETENTION_DAYS must be an integer 1..3650, got '${raw}'.`);
  }
  return days;
})();

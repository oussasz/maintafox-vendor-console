/**
 * Operator session in the browser (master plan Phase 4.1).
 *
 * The access token (15 minutes) lives only in this module's memory: never in localStorage or a
 * cookie readable by scripts. The refresh token is an httpOnly cookie the browser sends only to
 * /api/v1/auth; `refreshAccessToken` exchanges it for a new access token (and a new cookie).
 *
 * The server revokes the whole session when an already-used refresh token is presented, so two
 * tabs must never send the same cookie concurrently: refreshes are serialised across tabs with
 * the Web Locks API, and within a tab concurrent callers share one request.
 */
import { apiBase } from "@/lib/api-base";

/** Refresh this long before expiry rather than send a token that may expire in flight. */
const ACCESS_TOKEN_RENEW_MARGIN_MS = 30_000;
const REFRESH_LOCK_NAME = "maintafox-vendor-refresh";
/** Written by consoles before Phase 4.1 (long-lived token in localStorage); removed on load. */
const LEGACY_STORAGE_KEY = "maintafox:vendor:access_token";

type SessionState = { accessToken: string; expiresAtMs: number };

let state: SessionState | null = null;
let inFlight: Promise<boolean> | null = null;
const endedListeners = new Set<() => void>();

try {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
} catch {
  // Storage unavailable (private mode): nothing was stored there either.
}

export function getAccessToken(): string | null {
  return state && state.expiresAtMs > Date.now() ? state.accessToken : null;
}

/** Stores the access token of a login, MFA or refresh response. */
export function setSession(accessToken: string, expiresInSeconds: number): void {
  state = { accessToken, expiresAtMs: Date.now() + expiresInSeconds * 1000 };
}

/** Forgets the access token and tells listeners (AuthGuard) the session is over. */
export function endSession(): void {
  state = null;
  endedListeners.forEach((listener) => listener());
}

export function onSessionEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

async function postRefresh(): Promise<boolean> {
  const res = await fetch(`${apiBase()}/api/v1/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") return false;
  setSession(body.access_token, body.expires_in);
  return true;
}

/**
 * Exchanges the refresh cookie for a new access token. Resolves false when there is no session
 * (no cookie, expired, revoked); network failures reject so callers can tell them apart.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (inFlight) return inFlight;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const run = async (): Promise<boolean> =>
    locks ? await locks.request(REFRESH_LOCK_NAME, postRefresh) : await postRefresh();
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** A usable access token: the current one, or a refreshed one; null when the session is over. */
export async function ensureAccessToken(): Promise<string | null> {
  if (state && state.expiresAtMs - Date.now() > ACCESS_TOKEN_RENEW_MARGIN_MS) return state.accessToken;
  return (await refreshAccessToken()) ? getAccessToken() : null;
}

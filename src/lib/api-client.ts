/**
 * Authenticated requests to the control API. Every console service goes through `authFetch`: it
 * sends the in-memory access token, renews it through the refresh cookie when it is about to
 * expire, retries once when the API refuses the token (expired or revoked meanwhile; a 401 that is an
 * answer, such as a wrong authenticator code, is returned as is), and ends the session
 * when the refresh is refused (AuthGuard then shows the login page).
 */
import { apiBase } from "@/lib/api-base";
import { endSession, ensureAccessToken, refreshAccessToken } from "@/lib/auth-session";

export class SessionEndedError extends Error {
  constructor() {
    // Shown to the operator as common.json errors.sessionEnded (lib/error-text.ts).
    super("session_ended");
    this.name = "SessionEndedError";
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  return {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

/** Error codes of a 401 that mean "this access token is no longer good" (others, e.g. a wrong code, are answers). */
const SESSION_REFUSAL_CODES = new Set(["missing_token", "invalid_token", "session_ended"]);

async function isSessionRefusal(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body.error === "string" && SESSION_REFUSAL_CODES.has(body.error);
  } catch {
    return false;
  }
}

export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await ensureAccessToken();
  if (!token) {
    endSession();
    throw new SessionEndedError();
  }
  const res = await fetch(`${apiBase()}${path}`, withBearer(init, token));
  if (res.status !== 401 || !(await isSessionRefusal(res))) return res;
  // The access token expired or its session was revoked since it was issued: one refresh decides.
  if (!(await refreshAccessToken())) {
    endSession();
    throw new SessionEndedError();
  }
  const renewed = await ensureAccessToken();
  if (!renewed) {
    endSession();
    throw new SessionEndedError();
  }
  return fetch(`${apiBase()}${path}`, withBearer(init, renewed));
}

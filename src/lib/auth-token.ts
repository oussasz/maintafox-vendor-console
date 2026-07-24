const KEY = "maintafox:vendor:access_token";

/** JWT is three base64url segments separated by dots (no crypto verify here). */
export function looksLikeJwt(token: string): boolean {
  const parts = token.trim().split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Returns a non-empty token that has JWT-like shape, or null. */
export function getValidLookingAccessToken(): string | null {
  const token = getAccessToken();
  if (!token || !looksLikeJwt(token)) return null;
  return token;
}

export function setAccessToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Control API base URL (VITE_ADMIN_API_BASE_URL, build-time), without a trailing slash. */
export function apiBase(): string {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) throw new Error("VITE_ADMIN_API_BASE_URL is not configured.");
  return raw.replace(/\/$/, "");
}

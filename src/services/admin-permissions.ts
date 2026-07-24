import { z } from "zod";

import type { PermissionRecord } from "@shared/ipc-types";

import { getAccessToken } from "@/lib/auth-token";

export const PermissionRecordSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string(),
  is_dangerous: z.boolean(),
  requires_step_up: z.boolean(),
});

/** Session is missing, expired, or rejected by the API — redirect to login. */
export class AuthenticationRequiredError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message = "Authentication required", status = 401, code = "unauthenticated") {
    super(message);
    this.name = "AuthenticationRequiredError";
    this.status = status;
    this.code = code;
  }
}

/** Transient/config failure loading permissions — not Access Denied. */
export class PermissionsLoadError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PermissionsLoadError";
    this.status = status;
  }
}

export function isAuthenticationRequiredError(err: unknown): err is AuthenticationRequiredError {
  return err instanceof AuthenticationRequiredError;
}

export function isPermissionsLoadError(err: unknown): err is PermissionsLoadError {
  return err instanceof PermissionsLoadError;
}

function apiBase(): string | null {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

async function errorCodeFromResponse(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: string };
    return typeof body.error === "string" ? body.error.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Loads effective permissions from the VPS admin API.
 * Expected: `GET {VITE_ADMIN_API_BASE_URL}/api/v1/me/permissions` → JSON array of PermissionRecord.
 *
 * Throws {@link AuthenticationRequiredError} for 401 / invalid_token (caller must clear token + redirect).
 * Throws {@link PermissionsLoadError} for config, network, 5xx, or parse failures.
 */
export async function fetchMyPermissions(): Promise<PermissionRecord[]> {
  const base = apiBase();
  if (!base) {
    throw new PermissionsLoadError("Set VITE_ADMIN_API_BASE_URL.");
  }

  const token = getAccessToken();
  if (!token) {
    throw new AuthenticationRequiredError("Not authenticated", 401, "missing_token");
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/me/permissions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch {
    throw new PermissionsLoadError("Network error while loading permissions. Check API URL and CORS.");
  }

  if (!res.ok) {
    const code = await errorCodeFromResponse(res);
    if (
      res.status === 401 ||
      code === "missing_token" ||
      code === "invalid_token" ||
      (res.status === 403 && code === "invalid_token")
    ) {
      throw new AuthenticationRequiredError(
        `Authentication required (${code || res.status})`,
        res.status,
        code || "unauthenticated",
      );
    }
    throw new PermissionsLoadError(`Permissions request failed (${res.status})`, res.status);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new PermissionsLoadError("Permissions response was not valid JSON.");
  }

  const parsed = z.array(PermissionRecordSchema).safeParse(raw);
  if (!parsed.success) {
    throw new PermissionsLoadError("Permissions response shape was invalid.");
  }
  return parsed.data;
}

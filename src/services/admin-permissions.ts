import { z } from "zod";

import type { PermissionRecord } from "@maintafox/contracts";

import { authFetch, SessionEndedError } from "@/lib/api-client";

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

  constructor(status = 401, code = "unauthenticated") {
    super(code);
    this.name = "AuthenticationRequiredError";
    this.status = status;
    this.code = code;
  }
}

/** Why permissions could not be loaded (common.json `permissions.loadError.<kind>`). */
export type PermissionsLoadErrorKind = "config" | "network" | "http" | "invalid";

/** Transient/config failure loading permissions — not Access Denied. */
export class PermissionsLoadError extends Error {
  readonly kind: PermissionsLoadErrorKind;
  readonly status?: number;

  constructor(kind: PermissionsLoadErrorKind, status?: number) {
    super(status === undefined ? kind : `${kind} (${status})`);
    this.name = "PermissionsLoadError";
    this.kind = kind;
    this.status = status;
  }
}

export function isAuthenticationRequiredError(err: unknown): err is AuthenticationRequiredError {
  return err instanceof AuthenticationRequiredError;
}

export function isPermissionsLoadError(err: unknown): err is PermissionsLoadError {
  return err instanceof PermissionsLoadError;
}

function apiBaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_ADMIN_API_BASE_URL?.trim());
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
 * Throws {@link AuthenticationRequiredError} when there is no session (refresh refused) or the API
 * still answers 401 / invalid_token (caller ends the session and redirects).
 * Throws {@link PermissionsLoadError} for config, network, 5xx, or parse failures.
 */
export async function fetchMyPermissions(): Promise<PermissionRecord[]> {
  if (!apiBaseConfigured()) {
    throw new PermissionsLoadError("config");
  }

  let res: Response;
  try {
    res = await authFetch("/api/v1/me/permissions");
  } catch (err) {
    if (err instanceof SessionEndedError) {
      throw new AuthenticationRequiredError(401, "session_ended");
    }
    throw new PermissionsLoadError("network");
  }

  if (!res.ok) {
    const code = await errorCodeFromResponse(res);
    if (
      res.status === 401 ||
      code === "missing_token" ||
      code === "invalid_token" ||
      (res.status === 403 && code === "invalid_token")
    ) {
      throw new AuthenticationRequiredError(res.status, code || "unauthenticated");
    }
    throw new PermissionsLoadError("http", res.status);
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new PermissionsLoadError("invalid");
  }

  const parsed = z.array(PermissionRecordSchema).safeParse(raw);
  if (!parsed.success) {
    throw new PermissionsLoadError("invalid");
  }
  return parsed.data;
}

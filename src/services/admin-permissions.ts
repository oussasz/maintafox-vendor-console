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

function apiBase(): string | null {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

/**
 * Loads effective permissions from the VPS admin API.
 * Expected: `GET {VITE_ADMIN_API_BASE_URL}/api/v1/me/permissions` → JSON array of PermissionRecord.
 * Override path later if your backend uses a different route.
 */
export async function fetchMyPermissions(): Promise<PermissionRecord[]> {
  const base = apiBase();
  if (!base) {
    throw new Error("Set VITE_ADMIN_API_BASE_URL.");
  }

  const token = getAccessToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${base}/api/v1/me/permissions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Permissions request failed (${res.status})`);
  }

  const raw: unknown = await res.json();
  return z.array(PermissionRecordSchema).parse(raw);
}

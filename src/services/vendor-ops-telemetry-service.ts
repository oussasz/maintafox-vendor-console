import { z } from "zod";

import { getAccessToken } from "@/lib/auth-token";

import {
  PlatformOverviewV1Schema,
  RolloutOverviewV1Schema,
  SyncOverviewV1Schema,
} from "@/services/vendor-ops-contracts";

export type SyncOverviewV1 = z.infer<typeof SyncOverviewV1Schema>;
export type RolloutOverviewV1 = z.infer<typeof RolloutOverviewV1Schema>;
export type PlatformOverviewV1 = z.infer<typeof PlatformOverviewV1Schema>;

function apiBase(): string {
  const raw = import.meta.env.VITE_ADMIN_API_BASE_URL?.trim();
  if (!raw) throw new Error("VITE_ADMIN_API_BASE_URL is not configured.");
  return raw.replace(/\/$/, "");
}

async function authFetch(path: string): Promise<Response> {
  const token = getAccessToken();
  if (!token) throw new Error("Not authenticated.");
  return fetch(`${apiBase()}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
}

async function parseOrThrow<T>(res: Response, parser: { parse: (input: unknown) => T }, label: string): Promise<T> {
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status})`);
  }
  return parser.parse(await res.json());
}

export async function getSyncOverview(): Promise<SyncOverviewV1> {
  const res = await authFetch("/api/v1/ops/sync-overview");
  return parseOrThrow(res, SyncOverviewV1Schema, "Sync telemetry");
}

export async function getRolloutOverview(): Promise<RolloutOverviewV1> {
  const res = await authFetch("/api/v1/ops/rollout-overview");
  return parseOrThrow(res, RolloutOverviewV1Schema, "Rollout telemetry");
}

export async function getPlatformOverview(): Promise<PlatformOverviewV1> {
  const res = await authFetch("/api/v1/ops/platform-overview");
  return parseOrThrow(res, PlatformOverviewV1Schema, "Platform telemetry");
}

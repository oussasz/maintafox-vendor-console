import { z } from "zod";

import { authFetch } from "@/lib/api-client";

import {
  PlatformOverviewV1Schema,
  RolloutOverviewV1Schema,
  SyncOverviewV1Schema,
} from "@/services/vendor-ops-contracts";

export type SyncOverviewV1 = z.infer<typeof SyncOverviewV1Schema>;
export type RolloutOverviewV1 = z.infer<typeof RolloutOverviewV1Schema>;
export type PlatformOverviewV1 = z.infer<typeof PlatformOverviewV1Schema>;

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

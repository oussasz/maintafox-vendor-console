import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import { apiRequestError } from "@/lib/api-error";

import {
  PlatformOverviewV1Schema,
  RolloutOverviewV1Schema,
  SyncOverviewV1Schema,
} from "@/services/vendor-ops-contracts";

export type SyncOverviewV1 = z.infer<typeof SyncOverviewV1Schema>;
export type RolloutOverviewV1 = z.infer<typeof RolloutOverviewV1Schema>;
export type PlatformOverviewV1 = z.infer<typeof PlatformOverviewV1Schema>;

async function parseOrThrow<T>(res: Response, parser: { parse: (input: unknown) => T }): Promise<T> {
  if (!res.ok) throw await apiRequestError(res);
  return parser.parse(await res.json());
}

export async function getSyncOverview(): Promise<SyncOverviewV1> {
  const res = await authFetch("/api/v1/ops/sync-overview");
  return parseOrThrow(res, SyncOverviewV1Schema);
}

export async function getRolloutOverview(): Promise<RolloutOverviewV1> {
  const res = await authFetch("/api/v1/ops/rollout-overview");
  return parseOrThrow(res, RolloutOverviewV1Schema);
}

export async function getPlatformOverview(): Promise<PlatformOverviewV1> {
  const res = await authFetch("/api/v1/ops/platform-overview");
  return parseOrThrow(res, PlatformOverviewV1Schema);
}

const DeviceTimelineSchema = z.object({
  tenant_id: z.string(),
  machine_id: z.string(),
  hours: z.number().int(),
  device: z.object({
    app_version: z.string().nullable(),
    activated_at: z.string(),
    last_seen_at: z.string(),
    revoked_at: z.string().nullable(),
    revocation_kind: z.string().nullable(),
  }),
  measured: z
    .object({
      protocol: z.enum(["v2", "v1", "never_synced"]),
      online: z.boolean(),
      last_exchange_rfc3339: z.string().nullable(),
      lag_seconds: z.number(),
      checkpoint_age_seconds: z.number(),
    })
    .passthrough()
    .nullable(),
  open_resync: z.object({ requested_at: z.string(), requested_by: z.string(), reason: z.string() }).nullable(),
  events: z.array(
    z.object({
      at: z.string(),
      kind: z.enum(["exchange", "rejection", "conflict", "resync_requested", "resync_completed", "operator_action"]),
      detail: z.record(z.unknown()),
    }),
  ),
});
export type DeviceTimeline = z.infer<typeof DeviceTimelineSchema>;

/** What the sync store recorded for one device over the last `hours` (routes/sync-operations.ts). */
export async function getDeviceTimeline(tenantId: string, machineId: string, hours: number): Promise<DeviceTimeline> {
  const res = await authFetch(
    `/api/v1/ops/devices/${encodeURIComponent(tenantId)}/${encodeURIComponent(machineId)}/timeline?hours=${hours}`,
  );
  return parseOrThrow(res, DeviceTimelineSchema);
}

/** Repair: full resynchronisation of one device (step-up `sync_repair`, reason, audited). */
export async function requestDeviceResync(
  tenantId: string,
  machineId: string,
  privileged: { reason_code: string; step_up_token: string },
): Promise<void> {
  const res = await authFetch(`/api/v1/ops/devices/${encodeURIComponent(tenantId)}/${encodeURIComponent(machineId)}/resync`, {
    method: "POST",
    headers: { "X-Operator-Reason": privileged.reason_code, "X-Step-Up-Token": privileged.step_up_token },
  });
  if (!res.ok) throw await apiRequestError(res);
}

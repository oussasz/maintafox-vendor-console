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

const AttachmentStateSchema = z.object({ row_version: z.number(), payload_hash: z.string(), deleted: z.boolean() });
export type AttachmentState = z.infer<typeof AttachmentStateSchema>;

const DeletedAttachmentSchema = z.object({
  id: z.string(),
  entity_type: z.string(),
  entity_sync_id: z.string(),
  /** delete, overwrite by a device, or a restore that replaced a live row. */
  change_kind: z.enum(["delete", "overwrite", "restore"]),
  /** The change moved the file reference (always true for a delete). */
  locator_changed: z.boolean(),
  changed_at: z.string(),
  changed_by: z.object({ license_id: z.string().nullable(), machine_fingerprint: z.string(), operator: z.string().nullable() }),
  change_row_version: z.number(),
  prior_state: z.enum(["present", "already_deleted", "unknown"]),
  prior_row_version: z.number().nullable(),
  prior_payload_hash: z.string().nullable(),
  content_sha256: z.string().nullable(),
  byte_size: z.number().nullable(),
  /** A copy of the file is on the server (media manifest); null when unknown. */
  file_on_server: z.boolean().nullable(),
  /** For an equipment / request / work order attachment: its "Photo or file" (media_attachments) entry. */
  companion: z
    .object({ entity_sync_id: z.string(), archive_id: z.string().nullable(), live: z.boolean(), file_on_server: z.boolean() })
    .nullable(),
  /** The entry archived a live version: it can be restored (any time, more than once). */
  restorable: z.boolean(),
  /** The entity on the server now: what a restore replaces (sent back with the restore). */
  current: AttachmentStateSchema.nullable(),
  restores: z.array(z.object({ at: z.string(), by: z.string(), reason: z.string(), audit_record_id: z.string(), row_version: z.number() })),
});
export type DeletedAttachment = z.infer<typeof DeletedAttachmentSchema>;
const DeletedAttachmentsSchema = z.object({ tenant_id: z.string(), items: z.array(DeletedAttachmentSchema) });

/**
 * Photos, attachments and document links deleted or replaced for one customer (archive; no file
 * content). "relevant": deletes and changes that moved the file; "all": also caption/title edits.
 */
export async function listDeletedAttachments(
  tenantId: string,
  options: { filter?: "relevant" | "all"; since?: string } = {},
): Promise<DeletedAttachment[]> {
  const query = new URLSearchParams();
  if (options.filter) query.set("filter", options.filter);
  if (options.since) query.set("since", options.since);
  const qs = query.toString();
  const res = await authFetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}/sync/deleted-attachments${qs ? `?${qs}` : ""}`);
  return (await parseOrThrow(res, DeletedAttachmentsSchema)).items;
}

/**
 * Restores one archived version on every device (step-up `sync_attachment_restore`, reason,
 * audited). `expectedCurrent` is the entity's state from the listing: the server refuses with
 * entity_changed_since_listing if it changed since.
 */
export async function restoreDeletedAttachment(
  tenantId: string,
  archiveId: string,
  expectedCurrent: AttachmentState | null,
  privileged: { reason_code: string; step_up_token: string },
): Promise<void> {
  const res = await authFetch(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/sync/deleted-attachments/${encodeURIComponent(archiveId)}/restore`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operator-Reason": privileged.reason_code,
        "X-Step-Up-Token": privileged.step_up_token,
      },
      body: JSON.stringify({
        expected_current_row_version: expectedCurrent?.row_version ?? null,
        expected_current_payload_hash: expectedCurrent?.payload_hash ?? null,
      }),
    },
  );
  if (!res.ok) throw await apiRequestError(res);
}

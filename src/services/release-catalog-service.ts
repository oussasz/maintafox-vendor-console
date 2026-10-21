/**
 * Desktop release catalog (api/src/routes/release-catalog.ts): the versions the release workflow
 * uploaded, their publication ring and rollout percentage, recalls, and the release workflow's
 * publisher keys. Publishing (step-up rollout_publish), recalling (forced_rollback) and publisher
 * keys (release_publisher_key) are privileged: reason + step-up headers, and an Idempotency-Key.
 */
import { z } from "zod";

import { authFetch } from "@/lib/api-client";
import { throwIfNotOk } from "@/lib/api-error";
import { idempotencyKey, privilegedHeaders, type PrivilegedActionContext } from "@/services/license-control-service";

/**
 * Publication rings, narrowest first (api/src/releases/update-manifest.ts UPDATE_CHANNELS): a
 * release published to a ring is offered to that ring and to every narrower one.
 */
export const RELEASE_RINGS = ["internal", "pilot", "stable"] as const;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];

export function ringRank(ring: ReleaseRing): number {
  return RELEASE_RINGS.indexOf(ring);
}

/** Rings a release may be published to next: its current ring or a wider one (the API refuses narrowing). */
export function ringsAllowedFrom(current: ReleaseRing | null): ReleaseRing[] {
  return current === null ? [...RELEASE_RINGS] : RELEASE_RINGS.filter((r) => ringRank(r) >= ringRank(current));
}

/** Bounds of the rollout percentage the API accepts. */
export const ROLLOUT_PERCENT_MIN = 0;
export const ROLLOUT_PERCENT_MAX = 100;
/** Length bounds the API enforces on release notes and publisher key labels (release-catalog.ts). */
export const RELEASE_NOTES_MAX_LENGTH = 20000;
export const PUBLISHER_KEY_LABEL_MIN_LENGTH = 2;
export const PUBLISHER_KEY_LABEL_MAX_LENGTH = 80;

const isoDate = z.string().min(1);

const ReleaseArtifactSchema = z.object({
  target: z.string().min(1),
  arch: z.string().min(1),
  file_name: z.string().min(1),
  byte_size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  verified_at: isoDate.nullable(),
});

const ReleaseSchema = z.object({
  release_id: z.string().min(1),
  version: z.string().min(1),
  state: z.enum(["uploading", "registered"]),
  notes_en: z.string(),
  notes_fr: z.string(),
  channel: z.enum(RELEASE_RINGS).nullable(),
  rollout_percent: z.number().int().min(ROLLOUT_PERCENT_MIN).max(ROLLOUT_PERCENT_MAX),
  code_signed: z.boolean(),
  git_commit: z.string(),
  registered_by: z.string(),
  registered_at: isoDate,
  published_at: isoDate.nullable(),
  updated_at: isoDate,
  recalled_at: isoDate.nullable(),
  recalled_reason: z.string().nullable(),
  recalled_by: z.string().nullable(),
  artifacts: z.array(ReleaseArtifactSchema),
});

const PublisherKeySchema = z.object({
  key_id: z.string().min(1),
  label: z.string(),
  created_at: isoDate,
  created_by: z.string(),
  last_used_at: isoDate.nullable(),
  revoked_at: isoDate.nullable(),
  revoked_by: z.string().nullable(),
});

const CreatedPublisherKeySchema = PublisherKeySchema.extend({ token: z.string().min(1) });

export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;
export type Release = z.infer<typeof ReleaseSchema>;
export type PublisherKey = z.infer<typeof PublisherKeySchema>;
export type CreatedPublisherKey = z.infer<typeof CreatedPublisherKeySchema>;

/** Where a release stands, as the console shows it. */
export type ReleaseStatus = "uploading" | "draft" | ReleaseRing | "recalled";

export function releaseStatus(r: Pick<Release, "state" | "channel" | "recalled_at">): ReleaseStatus {
  if (r.recalled_at) return "recalled";
  if (r.state === "uploading") return "uploading";
  return r.channel ?? "draft";
}

/** Every release, newest first. */
export async function listReleases(): Promise<Release[]> {
  const res = await authFetch("/api/v1/releases");
  await throwIfNotOk(res);
  const list = z.array(ReleaseSchema).parse(await res.json());
  return [...list].sort((a, b) => Date.parse(b.registered_at) - Date.parse(a.registered_at));
}

/** Release notes shown to users (audited, no step-up). */
export async function updateReleaseNotes(releaseId: string, notes: { notes_en: string; notes_fr: string }): Promise<Release> {
  const res = await authFetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/notes`, {
    method: "PATCH",
    body: JSON.stringify(notes),
    headers: { "Idempotency-Key": idempotencyKey("release-notes") },
  });
  await throwIfNotOk(res);
  return ReleaseSchema.parse(await res.json());
}

/** Publishes or widens a release: ring + rollout percentage (step-up rollout_publish). */
export async function publishRelease(
  releaseId: string,
  input: { channel: ReleaseRing; rollout_percent: number },
  privileged: PrivilegedActionContext,
): Promise<Release> {
  const res = await authFetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/publish`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Idempotency-Key": idempotencyKey("release-publish"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
  return ReleaseSchema.parse(await res.json());
}

/** Withdraws a release for good (step-up forced_rollback); the operator's reason is kept with it. */
export async function recallRelease(releaseId: string, privileged: PrivilegedActionContext): Promise<Release> {
  const res = await authFetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/recall`, {
    method: "POST",
    body: JSON.stringify({ reason: privileged.reason_code }),
    headers: { "Idempotency-Key": idempotencyKey("release-recall"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
  return ReleaseSchema.parse(await res.json());
}

export async function listPublisherKeys(): Promise<PublisherKey[]> {
  const res = await authFetch("/api/v1/release-publisher-keys");
  await throwIfNotOk(res);
  return z.array(PublisherKeySchema).parse(await res.json());
}

/** A new release workflow key; its token is in this answer only (the API keeps its hash). */
export async function createPublisherKey(label: string, privileged: PrivilegedActionContext): Promise<CreatedPublisherKey> {
  const res = await authFetch("/api/v1/release-publisher-keys", {
    method: "POST",
    body: JSON.stringify({ label }),
    headers: { "Idempotency-Key": idempotencyKey("release-key-create"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
  return CreatedPublisherKeySchema.parse(await res.json());
}

export async function revokePublisherKey(keyId: string, privileged: PrivilegedActionContext): Promise<PublisherKey> {
  const res = await authFetch(`/api/v1/release-publisher-keys/${encodeURIComponent(keyId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Idempotency-Key": idempotencyKey("release-key-revoke"), ...privilegedHeaders(privileged) },
  });
  await throwIfNotOk(res);
  return PublisherKeySchema.parse(await res.json());
}

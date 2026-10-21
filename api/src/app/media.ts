/**
 * Tenant media object store (S3-compatible, Garage in production), created once on first use from
 * the S3_* environment. Partly configured settings stop the API at startup (index.ts calls this).
 */
import type express from "express";

import { ObjectStoreBucketMissingError, TenantMediaObjectStore } from "../storage/object-store.js";
import { structuredLog } from "./runtime.js";

let mediaStoreSingleton: TenantMediaObjectStore | null | undefined;

export function getMediaStore(): TenantMediaObjectStore | null {
  if (mediaStoreSingleton === undefined) {
    mediaStoreSingleton = TenantMediaObjectStore.fromEnv();
    structuredLog("object_store_config", {
      configured: mediaStoreSingleton !== null,
      bucket: mediaStoreSingleton?.config.bucket ?? null,
    });
  }
  return mediaStoreSingleton;
}

/**
 * Answers a failed object store call: 503 with `object_storage_bucket_missing` when the bucket is
 * gone, `object_storage_unavailable` otherwise (the store is down or refuses our credentials).
 * The provider's error is logged, not returned to the caller.
 */
export function sendObjectStoreError(res: express.Response, event: string, err: unknown, context: Record<string, unknown> = {}): void {
  const missing = err instanceof ObjectStoreBucketMissingError;
  structuredLog(event, {
    ...context,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  res.status(503).json({ error: missing ? "object_storage_bucket_missing" : "object_storage_unavailable" });
}

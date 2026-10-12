/** Tenant media object store (MinIO / S3), created once on first use from the S3_* environment. */
import { TenantMediaObjectStore } from "../storage/object-store.js";
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

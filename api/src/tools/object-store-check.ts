/**
 * Object store self-check, run once before the API starts (compose service `object-store-check`,
 * deploy/OBJECT_STORAGE.md). Fails loudly (exit 1, one readable line) unless, with the S3_*
 * settings the API will use:
 *   1. the bucket exists (it is created by the object store's own setup, never here);
 *   2. a presigned PUT, exactly as a desktop sends it, stores the bytes;
 *   3. a presigned GET returns the same bytes (SHA-256 compared);
 *   4. the probe object can be deleted again (only keys under PROBE_PREFIX: the API itself never
 *      deletes tenant media, see sync-attachment-archive.integration.mjs).
 * This catches a wrong key, secret, region, endpoint or bucket name, and a server that rejects the
 * presigned URLs the SDK produces, before any desktop sees it.
 *
 *   node dist/tools/object-store-check.js
 */
import { createHash, randomBytes } from "node:crypto";

import { DeleteObjectCommand } from "@aws-sdk/client-s3";

import { createS3Client, loadObjectStoreConfig, TenantMediaObjectStore, type ObjectStoreConfig } from "../storage/object-store.js";

const PROBE_PREFIX = "_maintafox-check/";
const PROBE_URL_TTL_SECONDS = 60;

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
    throw new Error(`${name}: ${e.name ?? "Error"} ${e.message ?? String(err)}${status}`);
  }
}

/** Deletes this check's own probe object; refuses any other key. */
async function deleteProbe(config: ObjectStoreConfig, key: string): Promise<void> {
  if (!key.startsWith(PROBE_PREFIX) || key.includes("..")) throw new Error(`refusing to delete '${key}': not a probe object`);
  await createS3Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

async function main(): Promise<void> {
  const config = loadObjectStoreConfig();
  if (!config) throw new Error("object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY are empty)");
  const store = new TenantMediaObjectStore(config);

  await step(`bucket '${config.bucket}' at ${config.endpoint}`, () => store.headBucket());
  const key = `${PROBE_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
  const probe = randomBytes(4096);
  const sha = createHash("sha256").update(probe).digest("hex");
  try {
    const put = await step("presign PUT", () => store.presignPut(key, PROBE_URL_TTL_SECONDS));
    const putRes = await step("presigned PUT", () => fetch(put.url, { method: "PUT", body: probe }));
    if (!putRes.ok) throw new Error(`presigned PUT: HTTP ${putRes.status} ${(await putRes.text()).slice(0, 300)}`);
    await putRes.arrayBuffer();
    const get = await step("presign GET", () => store.presignGet(key, PROBE_URL_TTL_SECONDS));
    const getRes = await step("presigned GET", () => fetch(get.url));
    if (!getRes.ok) throw new Error(`presigned GET: HTTP ${getRes.status} ${(await getRes.text()).slice(0, 300)}`);
    const back = Buffer.from(await getRes.arrayBuffer());
    if (createHash("sha256").update(back).digest("hex") !== sha) {
      throw new Error(`presigned GET returned ${back.length} bytes that differ from the ${probe.length} bytes written`);
    }
  } finally {
    await step("delete probe object", () => deleteProbe(config, key));
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, endpoint: config.endpoint, bucket: config.bucket, region: config.region, checked: ["bucket", "presigned_put", "presigned_get", "delete"] })}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`object-store-check FAILED: ${(err as Error).message}\n`);
  process.exit(1);
});

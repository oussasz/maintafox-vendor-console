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
 * `--via` (required) says which address the presigned URLs are signed for and sent to:
 *   internal  S3_ENDPOINT, straight to the store. The pre-start check: nginx is not up yet then.
 *   public    S3_PUBLIC_ENDPOINT, exactly the URLs desktops receive, through nginx and TLS. Run it
 *             after a deploy or a DNS/certificate change (deploy/OBJECT_STORAGE.md §1.1).
 *
 *   node dist/tools/object-store-check.js --via internal|public
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

function viaFromArgs(argv: string[]): "internal" | "public" {
  const at = argv.indexOf("--via");
  const via = at >= 0 ? argv[at + 1] : undefined;
  if (via !== "internal" && via !== "public") throw new Error("usage: object-store-check --via internal|public");
  return via;
}

/** Deletes this check's own probe object; refuses any other key. */
async function deleteProbe(config: ObjectStoreConfig, key: string): Promise<void> {
  if (!key.startsWith(PROBE_PREFIX) || key.includes("..")) throw new Error(`refusing to delete '${key}': not a probe object`);
  await createS3Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

async function main(): Promise<void> {
  const via = viaFromArgs(process.argv.slice(2));
  const config = loadObjectStoreConfig();
  if (!config) throw new Error("object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY are empty)");
  const store = new TenantMediaObjectStore(config);
  // Same store, same keys; only the origin the URLs are signed for (and therefore sent to) differs.
  const signing = via === "public" ? store : new TenantMediaObjectStore({ ...config, publicEndpoint: config.endpoint });
  const urlOrigin = via === "public" ? config.publicEndpoint : config.endpoint;

  await step(`bucket '${config.bucket}' at ${config.endpoint}`, () => store.headBucket());
  const key = `${PROBE_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
  const probe = randomBytes(4096);
  const sha = createHash("sha256").update(probe).digest("hex");
  try {
    const put = await step("presign PUT", () => signing.presignPut(key, PROBE_URL_TTL_SECONDS));
    const putRes = await step(`presigned PUT to ${urlOrigin}`, () => fetch(put.url, { method: "PUT", body: probe }));
    if (!putRes.ok) throw new Error(`presigned PUT to ${urlOrigin}: HTTP ${putRes.status} ${(await putRes.text()).slice(0, 300)}`);
    await putRes.arrayBuffer();
    const get = await step("presign GET", () => signing.presignGet(key, PROBE_URL_TTL_SECONDS));
    const getRes = await step(`presigned GET from ${urlOrigin}`, () => fetch(get.url));
    if (!getRes.ok) throw new Error(`presigned GET from ${urlOrigin}: HTTP ${getRes.status} ${(await getRes.text()).slice(0, 300)}`);
    const back = Buffer.from(await getRes.arrayBuffer());
    if (createHash("sha256").update(back).digest("hex") !== sha) {
      throw new Error(`presigned GET returned ${back.length} bytes that differ from the ${probe.length} bytes written`);
    }
  } finally {
    await step("delete probe object", () => deleteProbe(config, key));
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, via, endpoint: config.endpoint, presigned_url_origin: urlOrigin, bucket: config.bucket, region: config.region, checked: ["bucket", "presigned_put", "presigned_get", "delete"] })}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`object-store-check FAILED: ${(err as Error).message}\n`);
  process.exit(1);
});

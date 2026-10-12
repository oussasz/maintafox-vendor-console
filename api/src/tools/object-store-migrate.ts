/**
 * One-time copy of the tenant media bucket from the old MinIO to the new object store (Garage),
 * with verification (deploy/OBJECT_STORAGE.md §4). Read-only on the source: nothing is ever
 * written to or deleted from MinIO, so going back is always possible.
 *
 *   node dist/tools/object-store-migrate.js inventory
 *   node dist/tools/object-store-migrate.js copy
 *   node dist/tools/object-store-migrate.js verify --report <file.json>
 *
 * inventory  counts and bytes on both sides, and on the source the bucket versioning status and
 *            how many old versions / delete markers it holds (they are NOT copied: Garage has no
 *            versioning; they stay readable in the kept MinIO volume, see the runbook).
 * copy       every current object missing on the destination, or present with another size or
 *            ETag, is streamed source -> destination (content type kept). Safe to run again: the
 *            second run copies only what changed since.
 * verify     reads EVERY object in full on both sides and compares size and SHA-256; lists objects
 *            missing on the destination and objects only on the destination. Writes the report
 *            (one entry per object with its SHA-256) and exits 1 on any difference.
 *
 * Source (all required, no defaults): MIGRATE_SOURCE_S3_ENDPOINT, _REGION, _ACCESS_KEY,
 * _SECRET_KEY, _BUCKET, _FORCE_PATH_STYLE (true|false). Destination: the S3_* settings the API
 * uses (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, S3_BUCKET, S3_FORCE_PATH_STYLE,
 * DEPLOYMENT_ENV).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PassThrough, type Readable } from "node:stream";

import { GetBucketVersioningCommand, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3";

import { createS3Client, type ObjectListing, TenantMediaObjectStore } from "../storage/object-store.js";

type Source = { client: S3Client; bucket: string; endpoint: string };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`environment variable ${name} is required for the migration`);
  return value;
}

function sourceFromEnv(): Source {
  const forcePathStyle = required("MIGRATE_SOURCE_S3_FORCE_PATH_STYLE").toLowerCase();
  if (forcePathStyle !== "true" && forcePathStyle !== "false") throw new Error("MIGRATE_SOURCE_S3_FORCE_PATH_STYLE must be 'true' or 'false'");
  const endpoint = required("MIGRATE_SOURCE_S3_ENDPOINT").replace(/\/$/, "");
  return {
    client: createS3Client({
      endpoint,
      region: required("MIGRATE_SOURCE_S3_REGION"),
      accessKeyId: required("MIGRATE_SOURCE_S3_ACCESS_KEY"),
      secretAccessKey: required("MIGRATE_SOURCE_S3_SECRET_KEY"),
      forcePathStyle: forcePathStyle === "true",
    }),
    bucket: required("MIGRATE_SOURCE_S3_BUCKET"),
    endpoint,
  };
}

function destinationFromEnv(): TenantMediaObjectStore {
  const dest = TenantMediaObjectStore.fromEnv();
  if (!dest) throw new Error("destination settings (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, ...) are not set");
  return dest;
}

async function listSource(src: Source): Promise<ObjectListing[]> {
  const out: ObjectListing[] = [];
  let token: string | undefined;
  do {
    const page = await src.client.send(new ListObjectsV2Command({ Bucket: src.bucket, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      if (obj.Key) out.push({ key: obj.Key, size: obj.Size ?? 0, etag: (obj.ETag ?? "").replace(/"/g, "") });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function getSource(src: Source, key: string): Promise<{ body: Readable; contentType: string | undefined }> {
  const out = await src.client.send(new GetObjectCommand({ Bucket: src.bucket, Key: key }));
  if (!out.Body) throw new Error(`source object ${key} has no body`);
  return { body: out.Body as Readable, contentType: out.ContentType };
}

async function digest(body: Readable): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function destinationDigest(dest: TenantMediaObjectStore, key: string): Promise<{ size: number; sha256: string }> {
  const through = new PassThrough();
  const reading = digest(through);
  await dest.downloadObject(key, through);
  return reading;
}

const total = (objs: ObjectListing[]) => objs.reduce((n, o) => n + o.size, 0);

async function inventory(src: Source, dest: TenantMediaObjectStore) {
  await dest.headBucket();
  const source = await listSource(src);
  const versioning = (await src.client.send(new GetBucketVersioningCommand({ Bucket: src.bucket }))).Status ?? "Disabled";
  let noncurrentVersions = 0;
  let noncurrentBytes = 0;
  let deleteMarkers = 0;
  if (versioning === "Enabled" || versioning === "Suspended") {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    let truncated = true;
    while (truncated) {
      const page = await src.client.send(
        new ListObjectVersionsCommand({ Bucket: src.bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker }),
      );
      for (const v of page.Versions ?? []) {
        if (!v.IsLatest) {
          noncurrentVersions += 1;
          noncurrentBytes += v.Size ?? 0;
        }
      }
      deleteMarkers += (page.DeleteMarkers ?? []).length;
      truncated = page.IsTruncated === true;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }
  const destination = await dest.listObjects();
  return {
    source: {
      endpoint: src.endpoint,
      bucket: src.bucket,
      objects: source.length,
      bytes: total(source),
      versioning,
      noncurrent_versions: noncurrentVersions,
      noncurrent_bytes: noncurrentBytes,
      delete_markers: deleteMarkers,
    },
    destination: { endpoint: dest.config.endpoint, bucket: dest.config.bucket, objects: destination.length, bytes: total(destination) },
  };
}

async function copy(src: Source, dest: TenantMediaObjectStore) {
  await dest.headBucket();
  const source = await listSource(src);
  const sourceKeys = new Set(source.map((o) => o.key));
  const present = new Map((await dest.listObjects()).map((o) => [o.key, o]));
  let copied = 0;
  let copiedBytes = 0;
  let skipped = 0;
  for (const obj of source) {
    const there = present.get(obj.key);
    // Same size and the same single-part ETag (the MD5 of the content on both servers): already
    // copied. A multipart ETag ("...-N") depends on the part size, so such objects are copied again.
    if (there && there.size === obj.size && there.etag === obj.etag && !obj.etag.includes("-")) {
      skipped += 1;
      continue;
    }
    const { body, contentType } = await getSource(src, obj.key);
    await dest.putObject(obj.key, body, obj.size, contentType);
    copied += 1;
    copiedBytes += obj.size;
    if (copied % 100 === 0) process.stderr.write(`copied ${copied} objects (${copiedBytes} bytes)\n`);
  }
  return {
    source_objects: source.length,
    copied,
    copied_bytes: copiedBytes,
    already_identical: skipped,
    only_on_destination: [...present.keys()].filter((k) => !sourceKeys.has(k)),
  };
}

async function verify(src: Source, dest: TenantMediaObjectStore, reportPath: string) {
  await dest.headBucket();
  const source = await listSource(src);
  const destination = new Map((await dest.listObjects()).map((o) => [o.key, o]));
  const sourceKeys = new Set(source.map((o) => o.key));
  const objects: { key: string; size: number; sha256: string; status: string }[] = [];
  let different = 0;
  let missing = 0;
  for (const obj of source) {
    const s = await digest((await getSource(src, obj.key)).body);
    if (!destination.has(obj.key)) {
      objects.push({ key: obj.key, size: s.size, sha256: s.sha256, status: "missing_on_destination" });
      missing += 1;
      continue;
    }
    const d = await destinationDigest(dest, obj.key);
    const same = d.size === s.size && d.sha256 === s.sha256;
    if (!same) different += 1;
    objects.push({
      key: obj.key,
      size: s.size,
      sha256: s.sha256,
      status: same ? "identical" : `different (destination ${d.size} bytes, sha256 ${d.sha256})`,
    });
  }
  const summary = {
    checked_at: new Date().toISOString(),
    source: { endpoint: src.endpoint, bucket: src.bucket, objects: source.length, bytes: total(source) },
    destination: { endpoint: dest.config.endpoint, bucket: dest.config.bucket, objects: destination.size, bytes: total([...destination.values()]) },
    identical: source.length - different - missing,
    different,
    missing_on_destination: missing,
    only_on_destination: [...destination.keys()].filter((k) => !sourceKeys.has(k)),
    ok: different === 0 && missing === 0,
  };
  writeFileSync(reportPath, `${JSON.stringify({ ...summary, objects }, null, 2)}\n`);
  return summary;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const src = sourceFromEnv();
  const dest = destinationFromEnv();
  let result: { ok?: boolean } & Record<string, unknown>;
  switch (command) {
    case "inventory":
      result = await inventory(src, dest);
      break;
    case "copy":
      result = await copy(src, dest);
      break;
    case "verify": {
      const i = argv.indexOf("--report");
      const report = i >= 0 ? argv[i + 1] : undefined;
      if (!report) throw new Error("verify needs --report <file.json>");
      result = await verify(src, dest, report);
      break;
    }
    default:
      throw new Error(`unknown command '${command ?? ""}' (inventory | copy | verify)`);
  }
  process.stdout.write(`${JSON.stringify({ command, result })}\n`);
  if (result.ok === false) {
    process.stderr.write("object-store-migrate: verification FAILED (see the report)\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`object-store-migrate failed: ${(err as Error).message}\n`);
  process.exit(1);
});

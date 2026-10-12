/**
 * MinIO -> Garage media migration tool (api/src/tools/object-store-migrate.ts,
 * deploy/OBJECT_STORAGE.md §4) against a real S3-compatible server: inventory, copy (idempotent,
 * content type kept), verify (full SHA-256 on both sides, report file), and that verify fails on a
 * changed or missing object and a second copy repairs it.
 *
 * CI runs it with source and destination as two buckets of the pinned Garage image: MinIO can no
 * longer be pulled, so the MinIO-specific part (counting old versions with ListObjectVersions) is
 * exercised only in the rehearsal on the server, against the real MinIO (runbook §4).
 *
 * Needs TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY, TEST_S3_REGION. Refuses to run
 * without them; it never pretends to pass.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateBucketCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.TEST_S3_SECRET_KEY?.trim();
const region = process.env.TEST_S3_REGION?.trim();
if (!endpoint || !accessKey || !secretKey || !region) {
  console.error("TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY / TEST_S3_REGION are required (an S3-compatible test server).");
  process.exit(1);
}
const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});
const suffix = randomBytes(3).toString("hex");
const SOURCE = `mfx-migrate-src-${suffix}`;
const DEST = `mfx-migrate-dst-${suffix}`;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const env = {
  ...process.env,
  MIGRATE_SOURCE_S3_ENDPOINT: endpoint,
  MIGRATE_SOURCE_S3_REGION: region,
  MIGRATE_SOURCE_S3_ACCESS_KEY: accessKey,
  MIGRATE_SOURCE_S3_SECRET_KEY: secretKey,
  MIGRATE_SOURCE_S3_BUCKET: SOURCE,
  MIGRATE_SOURCE_S3_FORCE_PATH_STYLE: "true",
  S3_ENDPOINT: endpoint,
  S3_REGION: region,
  S3_ACCESS_KEY: accessKey,
  S3_SECRET_KEY: secretKey,
  S3_BUCKET: DEST,
  S3_FORCE_PATH_STYLE: "true",
  DEPLOYMENT_ENV: "ci",
};

function tool(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, ["dist/tools/object-store-migrate.js", ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const last = r.stdout.trim().split("\n").pop();
  return { status: r.status, stderr: r.stderr, json: last ? JSON.parse(last).result : undefined };
}

const put = (bucket, key, body, contentType) =>
  s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ...(contentType ? { ContentType: contentType } : {}) }));

const work = mkdtempSync(join(tmpdir(), "mfx-migrate-test-"));
try {
  // A missing source setting is refused before anything is read.
  const refused = tool(["inventory"], { MIGRATE_SOURCE_S3_BUCKET: "" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /MIGRATE_SOURCE_S3_BUCKET is required/);

  await s3.send(new CreateBucketCommand({ Bucket: SOURCE }));
  await s3.send(new CreateBucketCommand({ Bucket: DEST }));
  const objects = {
    [`prod/media/t1/work_order/wo-1/${sha256(Buffer.from("a"))}`]: { body: randomBytes(300 * 1024), type: "image/jpeg" },
    "prod/media/t2/asset/as 9/file": { body: randomBytes(10), type: undefined },
    "prod/support/t1/bundle_abc": { body: randomBytes(64 * 1024 + 3), type: "application/json" },
  };
  for (const [key, o] of Object.entries(objects)) await put(SOURCE, key, o.body, o.type);
  const totalBytes = Object.values(objects).reduce((n, o) => n + o.body.length, 0);

  // Inventory: three objects on the source, none on the destination.
  let r = tool(["inventory"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.source.objects, 3);
  assert.equal(r.json.source.bytes, totalBytes);
  assert.equal(r.json.destination.objects, 0);
  assert.equal(typeof r.json.source.versioning, "string");

  // Copy, then copy again: nothing more to do.
  r = tool(["copy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.copied, 3);
  assert.equal(r.json.copied_bytes, totalBytes);
  r = tool(["copy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.copied, 0);
  assert.equal(r.json.already_identical, 3);
  const head = await s3.send(new HeadObjectCommand({ Bucket: DEST, Key: Object.keys(objects)[0] }));
  assert.equal(head.ContentType, "image/jpeg", "content type kept");

  // Verify: every object identical, the report lists each one with its SHA-256.
  const report = join(work, "report.json");
  r = tool(["verify", "--report", report]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.identical, 3);
  const saved = JSON.parse(readFileSync(report, "utf8"));
  for (const [key, o] of Object.entries(objects)) {
    const entry = saved.objects.find((e) => e.key === key);
    assert.deepEqual(entry, { key, size: o.body.length, sha256: sha256(o.body), status: "identical" });
  }

  // A destination object with other bytes (same size) and a missing one: verify fails.
  const [changedKey, missingKey] = Object.keys(objects);
  await put(DEST, changedKey, randomBytes(objects[changedKey].body.length));
  await s3.send(new DeleteObjectCommand({ Bucket: DEST, Key: missingKey }));
  await put(DEST, "prod/media/extra/only-here", Buffer.from("x"));
  r = tool(["verify", "--report", report]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verification FAILED/);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.different, 1);
  assert.equal(r.json.missing_on_destination, 1);
  assert.deepEqual(r.json.only_on_destination, ["prod/media/extra/only-here"]);

  // A second copy repairs both (the changed object has another ETag); the extra object is reported,
  // never deleted.
  r = tool(["copy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.copied, 2);
  assert.deepEqual(r.json.only_on_destination, ["prod/media/extra/only-here"]);
  r = tool(["verify", "--report", report]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.identical, 3);

  console.log(JSON.stringify({ ok: true, test: "object-store-migrate", objects: 3, bytes: totalBytes }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

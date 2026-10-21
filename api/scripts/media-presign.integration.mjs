/**
 * Tenant media upload and download end to end, exactly as the desktop does it
 * (deploy/SYNC_EXCHANGE.md): POST /api/v1/sync/media/presign-put -> PUT the bytes to the presigned
 * URL -> POST /api/v1/sync/media/presign-get -> GET the presigned URL returns the exact bytes.
 * Also: one tenant can neither read nor write another tenant's keys, a tampered URL is refused by
 * the object store, a missing bucket is reported, never created by the API, and the pre-start
 * check (api/src/tools/object-store-check.ts) passes only with a working store and settings.
 *
 * Needs an S3-compatible server: TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY,
 * TEST_S3_REGION (CI: the Garage image pinned in docker-compose.yml). The test creates its bucket
 * with those credentials. Refuses to run without them; it never pretends to pass.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { startControlApi } from "./lib/control-api.mjs";

const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.TEST_S3_SECRET_KEY?.trim();
const region = process.env.TEST_S3_REGION?.trim();
if (!endpoint || !accessKey || !secretKey || !region) {
  console.error("TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY / TEST_S3_REGION are required (an S3-compatible test server).");
  process.exit(1);
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const md5 = (buf) => createHash("md5").update(buf).digest("hex");

const bucket = `mfx-media-${randomBytes(3).toString("hex")}`;
const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const apiEnv = {
  S3_ENDPOINT: endpoint,
  S3_ACCESS_KEY: accessKey,
  S3_SECRET_KEY: secretKey,
  S3_REGION: region,
  S3_BUCKET: bucket,
  S3_FORCE_PATH_STYLE: "true",
  DEPLOYMENT_ENV: "ci",
};

// 1. The bucket does not exist yet: the API reports it and does not create it.
{
  const api = await startControlApi({ port: 33197, extraEnv: apiEnv });
  try {
    const admin = await api.adminToken();
    const t = await api.call("POST", "/api/v1/tenants", admin, { slug: "media-nobucket", display_name: "Media no bucket" });
    const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: t.json.id, max_machines: 1 });
    const device = await api.claimDevice(l.json.license_key, "media-nobucket-1");
    const r = await api.call("POST", "/api/v1/sync/media/presign-put", device, {
      parent_entity_type: "work_order",
      parent_entity_sync_id: "wo-1",
      content_sha256: sha256(Buffer.from("x")),
    });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, "object_storage_bucket_missing");
  } catch (err) {
    console.error(api.output());
    throw err;
  } finally {
    await api.stop();
  }
}

// 2. The pre-start check (compose service object-store-check) refuses a missing bucket ...
const check = (extra = {}) =>
  spawnSync(process.execPath, ["dist/tools/object-store-check.js"], { env: { ...process.env, ...apiEnv, ...extra }, encoding: "utf8" });
let checked = check();
assert.equal(checked.status, 1, checked.stdout);
assert.match(checked.stderr, new RegExp(`object-store-check FAILED: bucket '${bucket}' .*does not exist`));

await s3.send(new CreateBucketCommand({ Bucket: bucket }));

// ... passes once it exists (presigned PUT + GET round trip, probe deleted) ...
checked = check();
assert.equal(checked.status, 0, checked.stderr);
assert.deepEqual(JSON.parse(checked.stdout).checked, ["bucket", "presigned_put", "presigned_get", "delete"]);
const leftovers = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "_maintafox-check/" }));
assert.equal(leftovers.KeyCount ?? 0, 0, "probe object deleted");
// ... and refuses a wrong region, a wrong secret and partial settings, each with one readable line.
for (const [extra, why] of [
  [{ S3_REGION: "not-the-store-region" }, /object-store-check FAILED: bucket/],
  [{ S3_SECRET_KEY: "wrong-secret-0123456789" }, /object-store-check FAILED: bucket/],
  [{ S3_BUCKET: "" }, /object-store-check FAILED: object storage is partly configured: missing S3_BUCKET/],
]) {
  checked = check(extra);
  assert.equal(checked.status, 1, `${JSON.stringify(extra)}: ${checked.stdout}`);
  assert.match(checked.stderr, why);
}

const api = await startControlApi({ port: 33198, extraEnv: apiEnv });
try {
  const admin = await api.adminToken();
  const devices = {};
  for (const name of ["alpha", "beta"]) {
    const t = await api.call("POST", "/api/v1/tenants", admin, { slug: `media-${name}`, display_name: `Media ${name}` });
    const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: t.json.id, max_machines: 1 });
    devices[name] = { tenantId: t.json.id, token: await api.claimDevice(l.json.license_key, `media-${name}-1`) };
  }

  // A photo-sized binary payload (not text: proves no transcoding on either side).
  const photo = randomBytes(256 * 1024 + 17);
  const put = await api.call("POST", "/api/v1/sync/media/presign-put", devices.alpha.token, {
    parent_entity_type: "work_order",
    parent_entity_sync_id: "wo-0001",
    content_sha256: sha256(photo),
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.method, "PUT");
  assert.equal(put.json.bucket, bucket);
  assert.equal(put.json.object_key, `ci/media/${devices.alpha.tenantId}/work_order/wo-0001/${sha256(photo)}`);
  assert.ok(put.json.expires_in_seconds > 0);
  // Path-style URL on the configured endpoint (the desktop calls it as is).
  assert.ok(put.json.url.startsWith(`${endpoint.replace(/\/$/, "")}/${bucket}/`), put.json.url);

  const putRes = await fetch(put.json.url, { method: "PUT", body: photo, headers: { "Content-Type": "application/octet-stream" } });
  assert.ok(putRes.ok, `presigned PUT failed: ${putRes.status} ${await putRes.text()}`);
  // ETag of a single PUT is the MD5 of the bytes (desktops may compare it).
  assert.equal(putRes.headers.get("etag")?.replace(/"/g, ""), md5(photo));

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: put.json.object_key }));
  assert.equal(head.ContentLength, photo.length);

  const get = await api.call("POST", "/api/v1/sync/media/presign-get", devices.alpha.token, { object_key: put.json.object_key });
  assert.equal(get.status, 200, JSON.stringify(get.json));
  assert.equal(get.json.method, "GET");
  const getRes = await fetch(get.json.url);
  assert.equal(getRes.status, 200);
  const downloaded = Buffer.from(await getRes.arrayBuffer());
  assert.equal(downloaded.length, photo.length);
  assert.equal(sha256(downloaded), sha256(photo));

  // Tenant isolation: beta cannot get a URL for alpha's object, nor write under alpha's prefix.
  const crossGet = await api.call("POST", "/api/v1/sync/media/presign-get", devices.beta.token, { object_key: put.json.object_key });
  assert.equal(crossGet.status, 403);
  assert.equal(crossGet.json.error, "object_key_tenant_mismatch");
  const crossPut = await api.call("POST", "/api/v1/sync/media/presign-put", devices.beta.token, {
    parent_entity_type: "work_order",
    parent_entity_sync_id: "wo-0001",
    content_sha256: sha256(photo),
    object_key: put.json.object_key,
  });
  assert.equal(crossPut.status, 403);
  // No device token: refused before any URL is signed.
  assert.equal((await api.call("POST", "/api/v1/sync/media/presign-get", null, { object_key: put.json.object_key })).status, 401);

  // The object store checks the signature: a tampered URL (other key, same signature) is refused.
  const tampered = get.json.url.replace(sha256(photo), sha256(Buffer.from("other")));
  const tamperedRes = await fetch(tampered);
  assert.equal(tamperedRes.status, 403, `tampered URL must be refused, got ${tamperedRes.status}`);
  await tamperedRes.arrayBuffer();

  // A retried upload to the same URL (the desktop retries after a network error) succeeds and
  // leaves the same content.
  const retry = await fetch(put.json.url, { method: "PUT", body: photo });
  assert.ok(retry.ok, `second presigned PUT failed: ${retry.status}`);
  await retry.arrayBuffer();
  const again = Buffer.from(await (await fetch(get.json.url)).arrayBuffer());
  assert.equal(sha256(again), sha256(photo));

  console.log(JSON.stringify({ ok: true, test: "media-presign", bucket, bytes: photo.length }));
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

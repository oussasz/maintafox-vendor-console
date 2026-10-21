/**
 * Tenant media upload and download end to end, exactly as the desktop does it
 * (deploy/SYNC_EXCHANGE.md): POST /api/v1/sync/media/presign-put -> PUT the bytes to the presigned
 * URL -> POST /api/v1/sync/media/presign-get -> GET the presigned URL returns the exact bytes.
 * Also: one tenant can neither read nor write another tenant's keys, a tampered URL is refused by
 * the object store, a missing bucket is reported, never created by the API, and the pre-start
 * check (api/src/tools/object-store-check.ts) passes only with a working store and settings.
 *
 * Public route: desktops never reach the store directly. Every URL is signed for
 * TEST_S3_PUBLIC_ENDPOINT, the nginx media route (deploy/nginx-media-proxy.conf, the same rules as
 * production; CI: deploy/object-storage/ci-start-media-proxy.sh) in front of TEST_S3_ENDPOINT. The
 * test proves the round trip through it (also with a file past nginx's default body limit), that the
 * signature binds the public Host (the same URL sent straight to the store is refused), and that
 * the route lets through nothing but presigned GET/PUT.
 *
 * Needs an S3-compatible server: TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY,
 * TEST_S3_REGION (CI: the Garage image pinned in docker-compose.yml), and TEST_S3_PUBLIC_ENDPOINT
 * (the proxy, another origin). The test creates its bucket with those credentials. Refuses to run
 * without them; it never pretends to pass.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { startControlApi } from "./lib/control-api.mjs";

const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.TEST_S3_SECRET_KEY?.trim();
const region = process.env.TEST_S3_REGION?.trim();
const publicEndpoint = process.env.TEST_S3_PUBLIC_ENDPOINT?.trim().replace(/\/$/, "");
if (!endpoint || !accessKey || !secretKey || !region || !publicEndpoint) {
  console.error(
    "TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY / TEST_S3_REGION / TEST_S3_PUBLIC_ENDPOINT are required (an S3-compatible test server and the nginx media route in front of it).",
  );
  process.exit(1);
}
const internalOrigin = new URL(endpoint).origin;
const publicOrigin = new URL(publicEndpoint).origin;
if (internalOrigin === publicOrigin) {
  console.error("TEST_S3_PUBLIC_ENDPOINT must be the proxy, another origin than TEST_S3_ENDPOINT (otherwise nothing about the public route is tested).");
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
  S3_PUBLIC_ENDPOINT: publicEndpoint,
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
const check = (extra = {}, via = "internal") =>
  spawnSync(process.execPath, ["dist/tools/object-store-check.js", ...(via ? ["--via", via] : [])], {
    env: { ...process.env, ...apiEnv, ...extra },
    encoding: "utf8",
  });
let checked = check({}, null);
assert.equal(checked.status, 1, checked.stdout);
assert.match(checked.stderr, /object-store-check FAILED: usage: object-store-check --via internal\|public/);
checked = check();
assert.equal(checked.status, 1, checked.stdout);
assert.match(checked.stderr, new RegExp(`object-store-check FAILED: bucket '${bucket}' .*does not exist`));

await s3.send(new CreateBucketCommand({ Bucket: bucket }));

// ... passes once it exists (presigned PUT + GET round trip, probe deleted), straight to the store
// (the pre-start check) and through the public route (the post-deploy check) ...
checked = check();
assert.equal(checked.status, 0, checked.stderr);
assert.deepEqual(JSON.parse(checked.stdout).checked, ["bucket", "presigned_put", "presigned_get", "delete"]);
assert.equal(JSON.parse(checked.stdout).presigned_url_origin, internalOrigin);
checked = check({}, "public");
assert.equal(checked.status, 0, checked.stderr);
assert.equal(JSON.parse(checked.stdout).via, "public");
assert.equal(JSON.parse(checked.stdout).presigned_url_origin, publicOrigin);
const leftovers = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "_maintafox-check/" }));
assert.equal(leftovers.KeyCount ?? 0, 0, "probe object deleted");
// ... and refuses a wrong region, a wrong secret and partial settings, each with one readable line.
for (const [extra, why] of [
  [{ S3_REGION: "not-the-store-region" }, /object-store-check FAILED: bucket/],
  [{ S3_SECRET_KEY: "wrong-secret-0123456789" }, /object-store-check FAILED: bucket/],
  [{ S3_BUCKET: "" }, /object-store-check FAILED: object storage is partly configured: missing S3_BUCKET/],
  [{ S3_PUBLIC_ENDPOINT: "" }, /object-store-check FAILED: object storage is partly configured: missing S3_PUBLIC_ENDPOINT/],
  [{ S3_PUBLIC_ENDPOINT: "https://media.example.test/s3" }, /object-store-check FAILED: S3_PUBLIC_ENDPOINT must be an http\(s\) origin/],
  [{ S3_PUBLIC_ENDPOINT: "https://user:pass@media.example.test" }, /object-store-check FAILED: S3_PUBLIC_ENDPOINT must be an http\(s\) origin/],
  [{ S3_PUBLIC_ENDPOINT: "https://media.example.test?x=1" }, /object-store-check FAILED: S3_PUBLIC_ENDPOINT must be an http\(s\) origin/],
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
  // Path-style URL on the PUBLIC endpoint (the desktop calls it as is), never the internal one.
  assert.ok(put.json.url.startsWith(`${publicEndpoint}/${bucket}/`), put.json.url);

  // The signature binds the Host: the same URL sent straight to the store (another Host) is refused.
  // This is why the proxy must pass the client's Host unchanged.
  const direct = await fetch(put.json.url.replace(publicOrigin, internalOrigin), { method: "PUT", body: Buffer.from("x") });
  assert.equal(direct.status, 403, `URL signed for ${publicOrigin} must be refused at ${internalOrigin}, got ${direct.status}`);
  await direct.arrayBuffer();

  const putRes = await fetch(put.json.url, { method: "PUT", body: photo, headers: { "Content-Type": "application/octet-stream" } });
  assert.ok(putRes.ok, `presigned PUT failed: ${putRes.status} ${await putRes.text()}`);
  // ETag of a single PUT is the MD5 of the bytes (desktops may compare it).
  assert.equal(putRes.headers.get("etag")?.replace(/"/g, ""), md5(photo));

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: put.json.object_key }));
  assert.equal(head.ContentLength, photo.length);

  const get = await api.call("POST", "/api/v1/sync/media/presign-get", devices.alpha.token, { object_key: put.json.object_key });
  assert.equal(get.status, 200, JSON.stringify(get.json));
  assert.equal(get.json.method, "GET");
  assert.ok(get.json.url.startsWith(`${publicEndpoint}/${bucket}/`), get.json.url);
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

  // A file past nginx's 1 MiB default body limit, as large as the desktop's largest synced file
  // (25 MB work order attachments), goes up and comes back intact through the route.
  const attachment = randomBytes(25 * 1000 * 1000);
  const bigPut = await api.call("POST", "/api/v1/sync/media/presign-put", devices.alpha.token, {
    parent_entity_type: "work_order",
    parent_entity_sync_id: "wo-0002",
    content_sha256: sha256(attachment),
  });
  assert.equal(bigPut.status, 200, JSON.stringify(bigPut.json));
  const bigPutRes = await fetch(bigPut.json.url, { method: "PUT", body: attachment });
  assert.ok(bigPutRes.ok, `25 MB presigned PUT through the route failed: ${bigPutRes.status} ${await bigPutRes.text()}`);
  const bigGet = await api.call("POST", "/api/v1/sync/media/presign-get", devices.alpha.token, { object_key: bigPut.json.object_key });
  assert.equal(bigGet.status, 200, JSON.stringify(bigGet.json));
  const bigBack = Buffer.from(await (await fetch(bigGet.json.url)).arrayBuffer());
  assert.equal(sha256(bigBack), sha256(attachment));

  // The route's upload limit (32 MiB) ... refuses a larger media upload before the store ...
  const publicSigner = new S3Client({
    region,
    endpoint: publicEndpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const oversized = randomBytes(33 * 1024 * 1024);
  const tooBig = await api.call("POST", "/api/v1/sync/media/presign-put", devices.alpha.token, {
    parent_entity_type: "work_order",
    parent_entity_sync_id: "wo-0003",
    content_sha256: sha256(oversized),
  });
  assert.equal(tooBig.status, 200, JSON.stringify(tooBig.json));
  const tooBigRes = await fetch(tooBig.json.url, { method: "PUT", body: oversized });
  assert.equal(tooBigRes.status, 413, `33 MiB media PUT through the route: ${tooBigRes.status}`);
  await tooBigRes.arrayBuffer();
  // ... but not a release installer (release catalog uploads, <env>/releases/..., up to 1 GiB).
  const releaseKey = "ci/releases/9.9.9/rel_route/windows-x86_64/Maintafox_9.9.9_x64-setup.exe";
  const releaseUrl = await getSignedUrl(publicSigner, new PutObjectCommand({ Bucket: bucket, Key: releaseKey }), { expiresIn: 60 });
  const releaseRes = await fetch(releaseUrl, { method: "PUT", body: oversized });
  assert.ok(releaseRes.ok, `33 MiB release upload through the route failed: ${releaseRes.status} ${await releaseRes.text()}`);
  assert.equal((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: releaseKey }))).ContentLength, oversized.length);

  // The route lets through presigned GET/PUT only. Refused by nginx, before the store:
  // an unsigned GET of an existing object ...
  const unsigned = await fetch(`${publicEndpoint}/${bucket}/${put.json.object_key}`);
  assert.equal(unsigned.status, 403, `unsigned GET through the route: ${unsigned.status}`);
  await unsigned.arrayBuffer();
  // ... a correctly signed DELETE URL (another method), also under the release prefix ...
  const releaseDeleteUrl = await getSignedUrl(publicSigner, new DeleteObjectCommand({ Bucket: bucket, Key: releaseKey }), { expiresIn: 60 });
  const releaseDeleted = await fetch(releaseDeleteUrl, { method: "DELETE" });
  assert.equal(releaseDeleted.status, 403, `presigned DELETE of a release upload through the route: ${releaseDeleted.status}`);
  await releaseDeleted.arrayBuffer();
  const deleteUrl = await getSignedUrl(publicSigner, new DeleteObjectCommand({ Bucket: bucket, Key: put.json.object_key }), { expiresIn: 60 });
  const deleted = await fetch(deleteUrl, { method: "DELETE" });
  assert.equal(deleted.status, 403, `presigned DELETE through the route: ${deleted.status}`);
  await deleted.arrayBuffer();
  // ... and a request signed with the store's key in the Authorization header (listing the bucket).
  await assert.rejects(
    publicSigner.send(new ListObjectsV2Command({ Bucket: bucket })),
    // nginx answers with an HTML page, so the SDK reports an unparsed error: check the status only.
    (err) => (err?.$metadata?.httpStatusCode ?? err?.$response?.statusCode) === 403,
    "credentialed request through the route must be refused",
  );
  // ... also when the header-signed request carries presigned-looking query parameters: nginx
  // clears the Authorization header, so the store never sees the key's signature.
  for (const query of [{ "X-Amz-Signature": "x" }, { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Signature": "x" }]) {
    const disguised = new S3Client({
      region,
      endpoint: publicEndpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    disguised.middlewareStack.add(
      (next) => (args) => {
        Object.assign(args.request.query, query);
        return next(args);
      },
      { step: "build", name: "disguiseAsPresigned" },
    );
    await assert.rejects(
      disguised.send(new ListObjectsV2Command({ Bucket: bucket })),
      (err) => [400, 403].includes(err?.$metadata?.httpStatusCode ?? err?.$response?.statusCode),
      `header-signed listing disguised with ${Object.keys(query).join("+")} must be refused`,
    );
  }

  // Raw paths that nginx would route differently from the key the store keeps ("..", ".", "//",
  // encoded "/" or ".") are refused before any location (sent raw: fetch would normalise them).
  const rawStatus = (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(publicEndpoint);
      const req = httpRequest({ host: u.hostname, port: u.port, method: "PUT", path, headers: { "Content-Length": "1" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end("x");
    });
  const presignedQuery = "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=x";
  for (const path of [
    `/${bucket}/ci/media/${devices.alpha.tenantId}/../../../ci/releases/a`,
    `/${bucket}/ci/media/${devices.alpha.tenantId}/./x`,
    `/${bucket}/ci/media//x`,
    `/${bucket}/ci%2Freleases/a`,
    `/${bucket}/ci/media/%2e%2e/releases/a`,
  ]) {
    assert.equal(await rawStatus(`${path}${presignedQuery}`), 400, `raw path ${path} through the route`);
  }
  // The API never signs such a key, nor one outside its environment, for a desktop.
  for (const objectKey of [
    `ci/media/${devices.alpha.tenantId}/../../../ci/releases/a`,
    `x/media/${devices.alpha.tenantId}/../../../ci/releases/a`,
    `ci/media/${devices.alpha.tenantId}/./x/y`,
    `ci/media/${devices.alpha.tenantId}//x`,
  ]) {
    const asPut = await api.call("POST", "/api/v1/sync/media/presign-put", devices.alpha.token, {
      parent_entity_type: "work_order",
      parent_entity_sync_id: "wo-0001",
      content_sha256: sha256(photo),
      object_key: objectKey,
    });
    assert.equal(asPut.status, 403, `presign-put of ${objectKey}: ${JSON.stringify(asPut.json)}`);
    const asGet = await api.call("POST", "/api/v1/sync/media/presign-get", devices.alpha.token, { object_key: objectKey });
    assert.equal(asGet.status, 403, `presign-get of ${objectKey}: ${JSON.stringify(asGet.json)}`);
  }

  // Desktops build their keys with their own environment (MAINTAFOX_DEPLOYMENT_ENV, default "dev"),
  // not the server's DEPLOYMENT_ENV ("ci" here): such keys keep working, both ways.
  const desktopKey = `dev/media/${devices.alpha.tenantId}/work_order/wo-0009/${sha256(photo)}`;
  const desktopPut = await api.call("POST", "/api/v1/sync/media/presign-put", devices.alpha.token, {
    parent_entity_type: "work_order",
    parent_entity_sync_id: "wo-0009",
    content_sha256: sha256(photo),
    object_key: desktopKey,
  });
  assert.equal(desktopPut.status, 200, JSON.stringify(desktopPut.json));
  assert.equal(desktopPut.json.object_key, desktopKey);
  const desktopPutRes = await fetch(desktopPut.json.url, { method: "PUT", body: photo });
  assert.ok(desktopPutRes.ok, `desktop-key PUT through the route: ${desktopPutRes.status} ${await desktopPutRes.text()}`);
  const desktopGet = await api.call("POST", "/api/v1/sync/media/presign-get", devices.alpha.token, { object_key: desktopKey });
  assert.equal(desktopGet.status, 200, JSON.stringify(desktopGet.json));
  assert.equal(sha256(Buffer.from(await (await fetch(desktopGet.json.url)).arrayBuffer())), sha256(photo));

  // A bucket listing presigned with the store key (as a leaked key would allow) is refused by the
  // route; so is a presigned list of all buckets.
  const presignedList = await getSignedUrl(publicSigner, new ListObjectsV2Command({ Bucket: bucket }), { expiresIn: 60 });
  const listed = await fetch(presignedList);
  assert.equal(listed.status, 403, `presigned bucket listing through the route: ${listed.status}`);
  await listed.arrayBuffer();
  assert.equal(await rawStatus(`/${presignedQuery}`), 403, "bucket-level request at / through the route");

  // The object is still there.
  assert.equal((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: put.json.object_key }))).ContentLength, photo.length);

  console.log(JSON.stringify({ ok: true, test: "media-presign", bucket, public_endpoint: publicEndpoint, bytes: photo.length }));
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

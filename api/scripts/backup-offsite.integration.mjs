/**
 * Off-site backup copy against a real S3-compatible server (CI: the Garage image pinned in
 * docker-compose.yml) with the real `age` tool (api/src/tools/backup-offsite.ts,
 * deploy/BACKUP_AND_RESTORE.md).
 *
 * Required environment (the test refuses to run without it, it never pretends to pass):
 *   OFFSITE_TEST_S3_ENDPOINT, OFFSITE_TEST_S3_ACCESS_KEY, OFFSITE_TEST_S3_SECRET_KEY,
 *   OFFSITE_TEST_S3_REGION
 * and `age` + `age-keygen` on PATH. Buckets `mfx-offsite-test` (off-site) and `mfx-media-test`
 * (stand-in for the tenant media bucket) are created when missing.
 *
 * Checks: push-file / push-dir / push-media upload age-encrypted objects only (the plaintext
 * never appears off-site), a second run uploads nothing new, fetch + age decrypt returns the exact
 * bytes, and a missing or malformed setting is refused.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.OFFSITE_TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.OFFSITE_TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.OFFSITE_TEST_S3_SECRET_KEY?.trim();
const region = process.env.OFFSITE_TEST_S3_REGION?.trim();
if (!endpoint || !accessKey || !secretKey || !region) {
  console.error("OFFSITE_TEST_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION are required (an S3-compatible test server).");
  process.exit(1);
}
const OFFSITE_BUCKET = "mfx-offsite-test";
const MEDIA_BUCKET = "mfx-media-test";

const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

async function ensureBucket(name) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
  }
}

async function listKeys(bucket, prefix) {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (out.Contents ?? []).map((o) => o.Key).sort();
}

async function readObject(bucket, key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

function tool(args, env) {
  return spawnSync(process.execPath, ["dist/tools/backup-offsite.js", ...args], { env, encoding: "utf8" });
}

async function main() {
  for (const bin of ["age", "age-keygen"]) {
    if (spawnSync(bin, ["--version"]).status !== 0) throw new Error(`${bin} is required on PATH`);
  }
  await ensureBucket(OFFSITE_BUCKET);
  await ensureBucket(MEDIA_BUCKET);
  const work = mkdtempSync(join(tmpdir(), "mfx-offsite-test-"));
  try {
    const identity = join(work, "owner.key");
    assert.equal(spawnSync("age-keygen", ["-o", identity]).status, 0);
    const recipient = /public key: (age1[0-9a-z]+)/.exec(readFileSync(identity, "utf8"))[1];
    const prefix = `ci-${randomBytes(4).toString("hex")}`;
    const env = {
      ...process.env,
      BACKUP_OFFSITE_S3_ENDPOINT: endpoint,
      BACKUP_OFFSITE_S3_REGION: region,
      BACKUP_OFFSITE_S3_BUCKET: OFFSITE_BUCKET,
      BACKUP_OFFSITE_S3_ACCESS_KEY: accessKey,
      BACKUP_OFFSITE_S3_SECRET_KEY: secretKey,
      BACKUP_OFFSITE_S3_PREFIX: prefix,
      BACKUP_OFFSITE_S3_FORCE_PATH_STYLE: "true",
      BACKUP_AGE_RECIPIENT: recipient,
      S3_ENDPOINT: endpoint,
      // Signs no URL; required by the shared settings loader (api/src/storage/object-store.ts).
      S3_PUBLIC_ENDPOINT: endpoint,
      S3_ACCESS_KEY: accessKey,
      S3_SECRET_KEY: secretKey,
      S3_REGION: region,
      S3_BUCKET: MEDIA_BUCKET,
      S3_FORCE_PATH_STYLE: "true",
      DEPLOYMENT_ENV: "ci",
    };

    // push-file: encrypted, plaintext not visible off-site.
    const marker = `MFX-PLAINTEXT-${randomBytes(8).toString("hex")}`;
    const dump = join(work, "maintafox-20261012T000000Z.dump");
    writeFileSync(dump, `${marker}\n${randomBytes(4096).toString("hex")}`);
    let r = tool(["push-file", "--file", dump, "--key", "pg_dump/maintafox-20261012T000000Z.dump"], env);
    assert.equal(r.status, 0, r.stderr);
    const dumpKey = `${prefix}/pg_dump/maintafox-20261012T000000Z.dump.age`;
    const stored = await readObject(OFFSITE_BUCKET, dumpKey);
    assert.ok(stored.subarray(0, 21).toString() === "age-encryption.org/v1", "object is an age file");
    assert.ok(!stored.toString("latin1").includes(marker), "plaintext must not appear off-site");

    // fetch + decrypt with the owner's private key returns the exact bytes.
    const fetched = join(work, "fetched.age");
    r = tool(["fetch", "--key", "pg_dump/maintafox-20261012T000000Z.dump", "--out", fetched], env);
    assert.equal(r.status, 0, r.stderr);
    const decrypted = join(work, "decrypted.dump");
    assert.equal(spawnSync("age", ["--decrypt", "--identity", identity, "--output", decrypted, fetched]).status, 0);
    assert.deepEqual(readFileSync(decrypted), readFileSync(dump));

    // push-dir: only new files, .tmp/.partial skipped.
    const wal = join(work, "wal");
    mkdirSync(wal);
    writeFileSync(join(wal, "000000010000000000000001.gz"), "seg1");
    writeFileSync(join(wal, "000000010000000000000002.gz"), "seg2");
    writeFileSync(join(wal, "000000010000000000000003.gz.tmp"), "in progress");
    r = tool(["push-dir", "--dir", wal, "--key-prefix", "wal"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).result, { uploaded: 2, already: 0 });
    writeFileSync(join(wal, "000000010000000000000003.gz"), "seg3");
    r = tool(["push-dir", "--dir", wal, "--key-prefix", "wal"], env);
    assert.deepEqual(JSON.parse(r.stdout).result, { uploaded: 1, already: 2 });
    assert.deepEqual(await listKeys(OFFSITE_BUCKET, `${prefix}/wal/`), [
      `${prefix}/wal/000000010000000000000001.gz.age`,
      `${prefix}/wal/000000010000000000000002.gz.age`,
      `${prefix}/wal/000000010000000000000003.gz.age`,
    ]);

    // push-media: every media object copied once, encrypted.
    const mediaKey = `prod/media/tenant_ci/work_orders/wo-1/${"a".repeat(64)}`;
    await s3.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: mediaKey, Body: `${marker}-photo` }));
    r = tool(["push-media"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).result.uploaded >= 1);
    r = tool(["push-media"], env);
    assert.equal(JSON.parse(r.stdout).result.uploaded, 0, "second run uploads nothing new");
    const mediaStored = await readObject(OFFSITE_BUCKET, `${prefix}/media/${mediaKey}.age`);
    assert.ok(!mediaStored.toString("latin1").includes(marker));

    // Files already encrypted locally (BACKUP_LOCAL_ENCRYPTION=required) go up as they are, under
    // the same remote names as in plaintext mode; a fake .age file is refused.
    const sealed = join(work, "maintafox-20261013T000000Z.dump.age");
    assert.equal(spawnSync("age", ["--encrypt", "--recipient", recipient, "--output", sealed, dump]).status, 0);
    r = tool(["push-file", "--file", sealed, "--key", "pg_dump/maintafox-20261013T000000Z.dump"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      await readObject(OFFSITE_BUCKET, `${prefix}/pg_dump/maintafox-20261013T000000Z.dump.age`),
      readFileSync(sealed),
      "an already encrypted file is uploaded byte for byte (not encrypted twice)",
    );
    const sealedWal = join(work, "wal-sealed");
    mkdirSync(sealedWal);
    const segPlain = join(work, "000000010000000000000009.gz");
    writeFileSync(segPlain, "seg9");
    const segSealed = join(sealedWal, "000000010000000000000009.gz.age");
    assert.equal(spawnSync("age", ["--encrypt", "--recipient", recipient, "--output", segSealed, segPlain]).status, 0);
    r = tool(["push-dir", "--dir", sealedWal, "--key-prefix", "wal"], env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).result, { uploaded: 1, already: 0 });
    assert.ok((await listKeys(OFFSITE_BUCKET, `${prefix}/wal/`)).includes(`${prefix}/wal/000000010000000000000009.gz.age`));
    const fake = join(work, "fake.dump.age");
    writeFileSync(fake, `${marker} not encrypted`);
    r = tool(["push-file", "--file", fake, "--key", "pg_dump/fake.dump"], env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is named \.age but is not an age-encrypted file/);

    // Refusals: missing setting, malformed recipient, path traversal.
    r = tool(["list", "--key-prefix", "wal"], { ...env, BACKUP_OFFSITE_S3_BUCKET: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BACKUP_OFFSITE_S3_BUCKET is required/);
    r = tool(["list", "--key-prefix", "wal"], { ...env, BACKUP_AGE_RECIPIENT: "not-a-key" });
    assert.match(r.stderr, /BACKUP_AGE_RECIPIENT must be an age public key/);
    r = tool(["push-file", "--file", dump, "--key", "../escape"], env);
    assert.match(r.stderr, /invalid off-site key/);

    console.log("backup-offsite: OK (encrypted upload, fetch + decrypt, incremental dir and media copy, refusals)");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

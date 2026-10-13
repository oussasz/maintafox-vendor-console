/**
 * Backup and restore drill against a real PostgreSQL 16 cluster (deploy/BACKUP_AND_RESTORE.md).
 *
 * Needs the PostgreSQL 16 server and client programs on PATH (initdb, pg_ctl, postgres, pg_dump,
 * pg_restore, pg_basebackup, pg_archivecleanup, psql, createdb, dropdb), `age` + `age-keygen`, and
 * a POSIX `sh` with gzip (Linux, or Git Bash on Windows). It refuses to run without them; it never
 * pretends to pass.
 *
 * The cluster runs with the production WAL settings (archive_command = deploy/backup/wal-archive.sh,
 * hba_file = deploy/backup/pg_hba.conf). The real control API writes data into it, then:
 *   A. BACKUP_LOCAL_ENCRYPTION=disabled (the previous release): backup.sh writes plaintext dump,
 *      base backup and WAL; the dump is restore-verified before it is stored.
 *   B. The server is switched to required (as on deploy) and backup.sh runs again:
 *      - refuses without a recipient (and so does wal-archive.sh)
 *      - encrypts the plaintext left by A, deletes it; every artifact is *.age, files 600,
 *        directories 700 (Linux), SHA256SUMS matches, the work directory is emptied (a stale
 *        plaintext file left there by a "crash" is gone)
 *   C. restore-drill.sh: fresh dump, scratch restore, verified, discarded, recorded
 *   D. restore.sh with the owner's key restores an encrypted dump (new one and a migrated one);
 *      without the key / with the wrong key: a clear error
 *   E. corrupted dump (checksum) and existing target database refused; tampered audit ledger
 *      detected
 *   F. point-in-time recovery from the encrypted base backup + encrypted WAL archive with the key
 *      mounted for the restore: full replay contains the rows written after the base backup, a
 *      target time before them does not; without the key the base backup is refused and the
 *      server stops recovery (it never promotes a database missing data)
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";
import { loginAccessToken } from "./lib/vendor-session.mjs";

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_SCRIPTS = resolve(API_DIR, "../deploy/backup");
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";
const PG_USER = "mfx_drill";
const PG_PASSWORD = "drill-password-not-secret";
const DB_NAME = "maintafox";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** The current uid:gid as the scripts' `id` sees it (BACKUP_FILES_OWNER). */
const FILES_OWNER = spawnSync("sh", ["-c", 'printf "%s:%s" "$(id -u)" "$(id -g)"'], { encoding: "utf8" }).stdout;
const IS_WINDOWS = process.platform === "win32";
/** Forward slashes: valid on Windows and inside postgresql.conf strings. */
const fwd = (p) => p.replace(/\\/g, "/");

function requireTools() {
  const tools = ["initdb", "pg_ctl", "postgres", "pg_dump", "pg_restore", "pg_basebackup", "pg_archivecleanup", "psql", "createdb", "dropdb"];
  for (const tool of tools) {
    const r = spawnSync(tool, ["--version"], { encoding: "utf8" });
    if (r.status !== 0 || !/\(PostgreSQL\) 16\./.test(r.stdout)) {
      throw new Error(
        `${tool} (PostgreSQL 16) is not on PATH: the backup drill needs the real PostgreSQL 16 programs. ` +
          `Install them (CI: /usr/lib/postgresql/16/bin) and put their bin directory on PATH.`,
      );
    }
  }
  const sh = spawnSync("sh", ["-c", "command -v gzip && command -v awk && command -v sha256sum"], { encoding: "utf8" });
  if (sh.status !== 0) throw new Error("a POSIX sh with gzip, awk and sha256sum is required on PATH");
  for (const tool of ["age", "age-keygen"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status !== 0) {
      throw new Error(`${tool} is not on PATH: the encrypted backups need it (CI: apt-get install age)`);
    }
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

function run(cmd, args, env, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!allowFail && r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return r;
}

/** A Postgres cluster with the production WAL archiving settings, managed with pg_ctl. */
class Cluster {
  /** serverEnv: the encryption settings of the postgres service (BACKUP_LOCAL_ENCRYPTION, ...). */
  constructor(dataDir, port, walArchiveDir, serverEnv) {
    this.dataDir = dataDir;
    this.port = port;
    this.walArchiveDir = walArchiveDir;
    this.serverEnv = serverEnv;
  }
  env() {
    return { ...process.env, ...this.serverEnv, MFX_WAL_ARCHIVE_DIR: fwd(this.walArchiveDir), PGPASSWORD: PG_PASSWORD };
  }
  start() {
    // stdio ignored: the server inherits pg_ctl's handles, so captured pipes would never close
    // (the server writes to the -l log file instead).
    const r = spawnSync(
      "pg_ctl",
      ["start", "-D", this.dataDir, "-w", "-t", "120", "-l", join(this.dataDir, "server.log"), "-o", `-p ${this.port}`],
      { env: this.env(), stdio: "ignore" },
    );
    if (r.status !== 0) {
      const logPath = join(this.dataDir, "server.log");
      throw new Error(`pg_ctl start failed (${r.status}):\n${existsSync(logPath) ? readFileSync(logPath, "utf8") : "no server log"}`);
    }
  }
  stop() {
    run("pg_ctl", ["stop", "-D", this.dataDir, "-m", "fast", "-w"], this.env(), { allowFail: true });
  }
  url(db = DB_NAME) {
    return `postgres://${PG_USER}:${encodeURIComponent(PG_PASSWORD)}@127.0.0.1:${this.port}/${db}`;
  }
  async query(text, params = [], db = DB_NAME) {
    const client = new pg.Client({ connectionString: this.url(db) });
    await client.connect();
    try {
      return (await client.query(text, params)).rows;
    } finally {
      await client.end();
    }
  }
}

function initCluster(root, port, walArchiveDir, serverEnv) {
  const dataDir = join(root, `data-${port}`);
  const pwfile = join(root, "pwfile");
  writeFileSync(pwfile, `${PG_PASSWORD}\n`);
  run("initdb", ["-D", dataDir, "-U", PG_USER, "--pwfile", pwfile, "--auth-local=trust", "--auth-host=scram-sha-256", "-E", "UTF8", "--locale=C"], process.env);
  // Same settings as the postgres service in docker-compose.yml (archive_timeout is irrelevant
  // here: the test forces WAL switches).
  appendFileSync(
    join(dataDir, "postgresql.conf"),
    [
      "",
      "listen_addresses = '127.0.0.1'",
      // TCP only: the default Unix socket directory (/var/run/postgresql) is not writable for a
      // normal user on Linux; every client here connects to 127.0.0.1.
      "unix_socket_directories = ''",
      "wal_level = replica",
      "archive_mode = on",
      `archive_command = 'sh "${fwd(join(BACKUP_SCRIPTS, "wal-archive.sh"))}" "%p" "%f"'`,
      `hba_file = '${fwd(join(BACKUP_SCRIPTS, "pg_hba.conf"))}'`,
      "",
    ].join("\n"),
  );
  return new Cluster(dataDir, port, walArchiveDir, serverEnv);
}

/**
 * The tenant media bucket the nightly backup copies (api/src/tools/media-backup.ts): a real
 * S3-compatible server (CI: the Garage image pinned in docker-compose.yml), one bucket per run.
 */
function mediaBucketEnv() {
  const env = {
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT?.trim(),
    S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY?.trim(),
    S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY?.trim(),
    S3_REGION: process.env.TEST_S3_REGION?.trim(),
  };
  if (Object.values(env).some((v) => !v)) {
    throw new Error("TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY / TEST_S3_REGION are required: the nightly backup copies the media bucket");
  }
  // The backup signs no URL; S3_PUBLIC_ENDPOINT is required by the shared settings loader.
  return { ...env, S3_PUBLIC_ENDPOINT: env.S3_ENDPOINT, S3_BUCKET: `mfx-drill-${randomBytes(3).toString("hex")}`, S3_FORCE_PATH_STYLE: "true", DEPLOYMENT_ENV: "ci" };
}
const MEDIA = mediaBucketEnv();
const mediaS3 = new S3Client({
  region: MEDIA.S3_REGION,
  endpoint: MEDIA.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: MEDIA.S3_ACCESS_KEY, secretAccessKey: MEDIA.S3_SECRET_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

function backupEnv(cluster, backupDir, workDir) {
  return {
    ...process.env,
    ...cluster.serverEnv,
    ...MEDIA,
    MEDIA_BACKUP_REMOVED_RETENTION_DAYS: "30",
    BACKUP_DIR: fwd(backupDir),
    BACKUP_WORK_DIR: fwd(workDir),
    BACKUP_FILES_OWNER: FILES_OWNER,
    MFX_WAL_ARCHIVE_DIR: fwd(cluster.walArchiveDir),
    MFX_API_DIR: fwd(API_DIR),
    BACKUP_LOCAL_RETENTION_DAYS: "7",
    BACKUP_OFFSITE_MODE: "disabled",
    PGHOST: "127.0.0.1",
    PGPORT: String(cluster.port),
    PGUSER: PG_USER,
    PGPASSWORD: PG_PASSWORD,
    PGDATABASE: DB_NAME,
  };
}

async function waitArchived(cluster) {
  const [{ wal }] = await cluster.query("SELECT pg_walfile_name(pg_switch_wal()) AS wal");
  for (let i = 0; i < 120; i += 1) {
    const [s] = await cluster.query("SELECT last_archived_wal FROM pg_stat_archiver");
    if (s.last_archived_wal && s.last_archived_wal >= wal) return;
    await delay(250);
  }
  throw new Error(`WAL ${wal} was not archived in time (see the server log for archive_command errors)`);
}

async function waitPromoted(cluster) {
  for (let i = 0; i < 240; i += 1) {
    try {
      const [{ r }] = await cluster.query("SELECT pg_is_in_recovery() AS r");
      if (!r) return;
    } catch {
      // still starting
    }
    await delay(250);
  }
  throw new Error(`recovered cluster on port ${cluster.port} did not finish recovery`);
}

async function startApi(cluster, port) {
  let output = "";
  const proc = spawn(process.execPath, ["dist/index.js"], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: cluster.url(),
      ...TEST_SYNC_ENV,
      JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
      SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
      SEED_ADMIN_EMAIL: ADMIN_EMAIL,
      ...TEST_ENTITLEMENT_SIGNING_ENV,
      SEED_BEHAVIOR: "safe",
      NODE_ENV: "production",
      CORS_ORIGIN: "http://localhost:5174",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => (output += String(b)));
  proc.stderr.on("data", (b) => (output += String(b)));
  // Up to 2 minutes: the migrations run against a cluster that archives every WAL segment.
  for (let i = 0; i < 480; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {
      // keep polling
    }
    if (proc.exitCode !== null) break;
    await delay(250);
  }
  proc.kill();
  throw new Error(`API did not start:\n${output}`);
}

async function seedThroughApi(port) {
  const base = `http://127.0.0.1:${port}`;
  const access_token = await loginAccessToken(base, ADMIN_EMAIL, ADMIN_PASSWORD);
  const admin = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };
  for (const slug of ["drill-alpha", "drill-beta"]) {
    const t = await fetch(`${base}/api/v1/tenants`, { method: "POST", headers: admin, body: JSON.stringify({ slug, display_name: `Drill ${slug}` }) });
    assert.equal(t.status, 201);
    const tenant = await t.json();
    // Each licence issue appends an audit record (hash chain).
    const l = await fetch(`${base}/api/v1/licenses`, { method: "POST", headers: admin, body: JSON.stringify({ tenant_id: tenant.id, max_machines: 2 }) });
    assert.equal(l.status, 201);
    const license = await l.json();
    const claim = await fetch(`${base}/api/v1/activation/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: license.license_key, machine_fingerprint: `${slug}-machine-1`, app_version: "1.0.0" }),
    });
    assert.equal(claim.status, 200);
  }
}

/** Every file under `dir`, relative, with forward slashes. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function putMedia(key, body) {
  await mediaS3.send(new PutObjectCommand({ Bucket: MEDIA.S3_BUCKET, Key: key, Body: body, ContentLength: body.length }));
}

async function getMedia(key) {
  const out = await mediaS3.send(new GetObjectCommand({ Bucket: MEDIA.S3_BUCKET, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

/** Files 600 and directories 700 (POSIX permissions do not exist on Windows). */
function assertPrivate(dir) {
  if (IS_WINDOWS) return;
  assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} must be mode 700`);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) assertPrivate(full);
    else assert.equal(statSync(full).mode & 0o777, 0o600, `${full} must be mode 600`);
  }
}

function restore(env, dump, target, extra = {}) {
  return run("sh", [join(BACKUP_SCRIPTS, "restore.sh"), fwd(dump), target], { ...env, ...extra }, { allowFail: true });
}

async function main() {
  requireTools();
  const root = mkdtempSync(join(tmpdir(), "mfx-backup-drill-"));
  const walArchive = join(root, "wal-archive");
  const backupDir = join(root, "backups");
  const workDir = join(root, "backup-work");
  mkdirSync(walArchive);
  mkdirSync(backupDir);
  // The owner's key pair: the private key stays with the "owner" (this test), never in the
  // environment of the backup scripts.
  const ownerKey = join(root, "owner.key");
  run("age-keygen", ["-o", ownerKey], process.env);
  const recipient = run("age-keygen", ["-y", ownerKey], process.env).stdout.trim();
  const wrongKey = join(root, "wrong.key");
  run("age-keygen", ["-o", wrongKey], process.env);
  const plaintextMode = { BACKUP_LOCAL_ENCRYPTION: "disabled", BACKUP_AGE_RECIPIENT: "" };
  const encryptedMode = { BACKUP_LOCAL_ENCRYPTION: "required", BACKUP_AGE_RECIPIENT: recipient };
  const clusters = [];
  let api = null;
  try {
    const cluster = initCluster(root, await freePort(), walArchive, plaintextMode);
    clusters.push(cluster);
    cluster.start();
    run("createdb", ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", PG_USER, DB_NAME], cluster.env());

    const apiPort = await freePort();
    api = await startApi(cluster, apiPort);
    await seedThroughApi(apiPort);
    api.kill();
    await once(api, "exit").catch(() => undefined);
    api = null;

    const auditBefore = (await cluster.query("SELECT COUNT(*)::int AS c FROM audit_records"))[0].c;
    assert.ok(auditBefore >= 2, "seed must have written audit records");

    // Tenant media: a photo (content-addressed key) and a support bundle whose key has characters
    // that must be encoded in a file name (space, '+').
    await mediaS3.send(new CreateBucketCommand({ Bucket: MEDIA.S3_BUCKET }));
    const photo = randomBytes(70 * 1024);
    const photoKey = `ci/media/tenant_1/work_order/wo-1/${createHash("sha256").update(photo).digest("hex")}`;
    const bundle = randomBytes(5000);
    const bundleKey = "ci/support/tenant_1/bundle x+y";
    await putMedia(photoKey, photo);
    await putMedia(bundleKey, bundle);

    // A. The previous release: plaintext backups (the dump is restore-verified before it is stored).
    let env = backupEnv(cluster, backupDir, workDir);
    let backup = run("sh", [join(BACKUP_SCRIPTS, "backup.sh")], env);
    assert.match(backup.stderr, /off-site copy is disabled/);
    await waitArchived(cluster);
    const legacyDumps = readdirSync(join(backupDir, "pg_dump")).filter((f) => f.endsWith(".dump"));
    assert.equal(legacyDumps.length, 1, "one plaintext dump");
    assert.ok(existsSync(join(backupDir, "pg_dump", `${legacyDumps[0]}.sha256`)), "dump checksum file");
    const legacyBases = readdirSync(join(backupDir, "base"));
    assert.equal(legacyBases.length, 1, "one base backup");
    assert.ok(existsSync(join(backupDir, "base", legacyBases[0], "base.tar.gz")));
    assert.ok(readdirSync(walArchive).some((f) => /^[0-9A-F]{24}\.gz$/.test(f)), "plaintext WAL archived");
    const [legacyRun] = await cluster.query("SELECT status, offsite_status, dump_file, detail FROM backup_runs WHERE kind = 'nightly'");
    assert.equal(legacyRun.status, "succeeded", legacyRun.detail);
    assert.equal(legacyRun.offsite_status, "disabled");
    assert.equal(legacyRun.dump_file, legacyDumps[0]);
    assert.match(legacyRun.detail, /restored into a scratch database and verified \(\d+ tables\) before it was stored/);
    assert.match(legacyRun.detail, /NOT ENCRYPTED at rest/);
    assert.match(legacyRun.detail, /OFF-SITE COPY DISABLED/);
    const verifyLeft = await cluster.query("SELECT datname FROM pg_database WHERE datname LIKE 'mfx_nightly_verify_%'", [], "postgres");
    assert.equal(verifyLeft.length, 0, "nightly scratch database dropped");
    // Media copied in plaintext (encryption still disabled), one file per object.
    const legacyMedia = listFiles(join(backupDir, "media"));
    assert.equal(legacyMedia.length, 2, `two media copies: ${legacyMedia.join(", ")}`);
    assert.ok(legacyMedia.every((f) => f.startsWith("current/ci/") && f.endsWith(".bin")), legacyMedia.join(", "));
    assert.ok(legacyMedia.some((f) => f.startsWith("current/ci/support/tenant_1/bundle%20x%2By+")), "key characters encoded");
    assert.match(legacyRun.detail, /Media: 2 objects \(\d+ bytes\) in the bucket, 2 newly copied into the backups/);

    // Between the nights: the photo is overwritten, the bundle deleted.
    const photo2 = randomBytes(71 * 1024);
    await putMedia(photoKey, photo2);
    await mediaS3.send(new DeleteObjectCommand({ Bucket: MEDIA.S3_BUCKET, Key: bundleKey }));

    // B. Deploy: the server and the backup switch to BACKUP_LOCAL_ENCRYPTION=required.
    const refused = run("sh", [join(BACKUP_SCRIPTS, "backup.sh")], { ...env, BACKUP_LOCAL_ENCRYPTION: "required", BACKUP_AGE_RECIPIENT: "" }, { allowFail: true });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /BACKUP_AGE_RECIPIENT is empty: run keygen\.sh first.*refusing to write unencrypted backups/);
    const segment = join(root, "segment");
    writeFileSync(segment, "not a real WAL segment");
    const walRefused = run(
      "sh",
      [join(BACKUP_SCRIPTS, "wal-archive.sh"), fwd(segment), "000000010000000000000099"],
      { ...cluster.env(), BACKUP_LOCAL_ENCRYPTION: "required", BACKUP_AGE_RECIPIENT: "" },
      { allowFail: true },
    );
    assert.notEqual(walRefused.status, 0);
    assert.match(walRefused.stderr, /refusing to archive unencrypted WAL/);
    assert.ok(!existsSync(join(walArchive, "000000010000000000000099.gz")), "nothing archived without a recipient");

    cluster.stop();
    cluster.serverEnv = encryptedMode;
    cluster.start();
    env = backupEnv(cluster, backupDir, workDir);
    // A run that "crashed" earlier left plaintext in the work directory.
    mkdirSync(join(workDir, "nightly-crashed"), { recursive: true });
    writeFileSync(join(workDir, "nightly-crashed", "maintafox-crashed.dump"), "PLAINTEXT LEFT BY A CRASH");
    backup = run("sh", [join(BACKUP_SCRIPTS, "backup.sh")], env);
    await waitArchived(cluster);
    assert.deepEqual(readdirSync(workDir), [], "work directory emptied (stale plaintext removed, own files deleted)");
    const files = listFiles(backupDir);
    const walFiles = readdirSync(walArchive).sort();
    for (const f of files) {
      assert.ok(f.endsWith(".age") || f.endsWith("/start-wal") || f === "SHA256SUMS", `unexpected file in the backup volume: ${f}`);
    }
    for (const f of walFiles) {
      assert.ok(/\.gz\.age(\.sha256)?$/.test(f), `unexpected file in the WAL archive: ${f}`);
    }
    const sealedFiles = [
      ...files.filter((f) => f.endsWith(".age")).map((f) => join(backupDir, f)),
      ...walFiles.filter((f) => f.endsWith(".age")).map((f) => join(walArchive, f)),
    ];
    for (const full of sealedFiles) {
      assert.equal(readFileSync(full).subarray(0, 21).toString(), "age-encryption.org/v1", `${full} is an age file`);
    }
    assert.ok(files.includes(`pg_dump/${legacyDumps[0]}.age`) && files.includes(`pg_dump/${legacyDumps[0]}.sha256.age`), "legacy dump migrated");
    assert.ok(files.includes(`base/${legacyBases[0]}/base.tar.gz.age`) && files.includes(`base/${legacyBases[0]}/start-wal`), "legacy base backup migrated");
    assertPrivate(backupDir);
    assertPrivate(walArchive);
    const dumps = files
      .filter((f) => /^pg_dump\/.*\.dump\.age$/.test(f) && f !== `pg_dump/${legacyDumps[0]}.age`)
      .map((f) => f.slice("pg_dump/".length));
    assert.equal(dumps.length, 1, "one new encrypted dump");
    const bases = readdirSync(join(backupDir, "base")).sort();
    assert.equal(bases.length, 2, "legacy + new base backup");
    const newBase = bases[1];
    assert.ok(existsSync(join(backupDir, "base", newBase, "base.tar.gz.age")));
    assert.match(readFileSync(join(backupDir, "base", newBase, "start-wal"), "utf8"), /^[0-9A-F]{24}\n$/);
    // SHA256SUMS: every encrypted file present at the end of the run, as the pull client sees it.
    // (WAL archived after the run is listed by the next run.)
    const sums = readFileSync(join(backupDir, "SHA256SUMS"), "utf8").trim().split("\n");
    const listed = sums.map((line) => {
      const m = /^([0-9a-f]{64}) {2}((?:backups|wal)\/\S+\.age)$/.exec(line);
      assert.ok(m, `SHA256SUMS line: ${JSON.stringify(line)}`);
      const [, hash, rel] = m;
      const full = rel.startsWith("wal/") ? join(walArchive, rel.slice(4)) : join(backupDir, rel.slice("backups/".length));
      assert.equal(sha256File(full), hash, `SHA256SUMS hash of ${rel}`);
      return rel;
    });
    assert.deepEqual(
      listed.filter((rel) => rel.startsWith("backups/")).sort(),
      files.filter((f) => f.endsWith(".age")).map((f) => `backups/${f}`).sort(),
    );
    assert.ok(listed.some((rel) => rel.startsWith("wal/")), "WAL files listed");
    const [encRun] = await cluster.query("SELECT status, dump_file, detail FROM backup_runs WHERE kind = 'nightly' ORDER BY started_at DESC LIMIT 1");
    assert.equal(encRun.status, "succeeded", encRun.detail);
    assert.equal(encRun.dump_file, dumps[0]);
    assert.match(encRun.detail, /^Encrypted \d+ plaintext backup files left by an earlier release and deleted the plaintext\./);
    assert.match(encRun.detail, /encrypted at rest \(age\)/);

    // Media after the encrypted run: the current photo, and the overwritten photo + the deleted
    // bundle kept aside (both encrypted on the way, the plaintext copies are gone).
    assert.match(encRun.detail, /Media: 1 objects \(\d+ bytes\) in the bucket, 1 newly copied into the backups; 1 deleted and 1 overwritten objects kept 30 days\./);
    const mediaCurrent = files.filter((f) => f.startsWith("media/current/"));
    const mediaRemoved = files.filter((f) => f.startsWith("media/removed/"));
    assert.equal(mediaCurrent.length, 1, mediaCurrent.join(", "));
    assert.equal(mediaRemoved.length, 2, mediaRemoved.join(", "));
    const decryptedPhoto = join(root, "photo.dec");
    run("age", ["--decrypt", "--identity", ownerKey, "--output", decryptedPhoto, join(backupDir, mediaCurrent[0])], process.env);
    assert.ok(readFileSync(decryptedPhoto).equals(photo2), "current media copy = the overwritten photo's new content");
    // Restore the set-aside copies with the owner's key: the deleted bundle comes back with its
    // exact bytes; the photo still in the bucket is left alone.
    const removedRun = join(backupDir, "media", "removed", mediaRemoved[0].split("/")[2]);
    const restored = run("node", [join(API_DIR, "dist/tools/media-backup.js"), "restore", "--source", fwd(removedRun), "--identity", fwd(ownerKey)], env);
    assert.deepEqual(JSON.parse(restored.stdout).result, { restored: 1, skipped_present: 1 });
    assert.ok((await getMedia(bundleKey)).equals(bundle), "deleted bundle restored from the encrypted copy");
    assert.ok((await getMedia(photoKey)).equals(photo2), "photo in the bucket untouched by the restore");
    const mediaNoKey = run("node", [join(API_DIR, "dist/tools/media-backup.js"), "restore", "--source", fwd(removedRun), "--replace"], env, { allowFail: true });
    assert.notEqual(mediaNoKey.status, 0);
    assert.match(mediaNoKey.stderr, /is encrypted: --identity <owner's age key file> is required/);

    // Rows written after the encrypted base backup (only recoverable through the encrypted WAL).
    await delay(1100);
    const [{ t: targetBeforeInsert }] = await cluster.query("SELECT now()::text AS t");
    await delay(1100);
    await cluster.query("INSERT INTO users (email, password_hash) VALUES ('after-base@maintafox.systems', 'x')");
    await waitArchived(cluster);
    assert.ok(readdirSync(walArchive).every((f) => !/\.gz$/.test(f)), "new WAL is archived encrypted only");

    // C. Restore drill: fresh dump, scratch restore, verified, discarded, recorded.
    const drill = run("sh", [join(BACKUP_SCRIPTS, "restore-drill.sh")], env);
    const report = JSON.parse(drill.stdout);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.audit_chain.status, "ok");
    assert.equal(report.audit_chain.checked_count, auditBefore);
    const tenantsRow = report.tables.find((t) => t.table === "public.tenants");
    assert.deepEqual([tenantsRow.expected, tenantsRow.restored], [2, 2]);
    assert.ok(report.tables.some((t) => t.table === "public.machine_activations" && t.restored === 2));
    const [drillRun] = await cluster.query("SELECT status, offsite_status, detail FROM backup_runs WHERE kind = 'restore_drill'");
    assert.equal(drillRun.status, "succeeded", drillRun.detail);
    assert.equal(drillRun.offsite_status, "not_applicable");
    assert.match(drillRun.detail, /took a fresh dump .* then discarded both/);
    const scratch = await cluster.query("SELECT datname FROM pg_database WHERE datname LIKE 'mfx_restore_drill_%'", [], "postgres");
    assert.equal(scratch.length, 0, "scratch database dropped");
    assert.deepEqual(readdirSync(workDir), [], "drill plaintext discarded");

    // D. Restoring an encrypted dump needs the owner's key.
    const encDump = join(backupDir, "pg_dump", dumps[0]);
    const noKey = restore(env, encDump, "mfx_nokey");
    assert.notEqual(noKey.status, 0);
    assert.match(noKey.stderr, /is encrypted: set AGE_IDENTITY_FILE to the file holding the owner's private key/);
    const badKey = restore(env, encDump, "mfx_badkey", { AGE_IDENTITY_FILE: fwd(wrongKey) });
    assert.notEqual(badKey.status, 0);
    assert.match(badKey.stderr, /it is not the private key these backups were encrypted to/);
    const withKey = restore(env, encDump, "mfx_withkey", { AGE_IDENTITY_FILE: fwd(ownerKey) });
    assert.equal(withKey.status, 0, withKey.stderr);
    assert.match(withKey.stderr, /checksum ok/);
    assert.equal(JSON.parse(withKey.stdout).ok, true);
    const migrated = restore(env, join(backupDir, "pg_dump", `${legacyDumps[0]}.age`), "mfx_migrated", { AGE_IDENTITY_FILE: fwd(ownerKey) });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(JSON.parse(migrated.stdout).ok, true, "a migrated legacy dump decrypts and restores");
    assert.deepEqual(readdirSync(workDir), [], "decrypted dumps removed after the restore");

    // E. Refusals: corrupted dump, existing target database; tampered audit ledger detected.
    const plainDump = join(root, "decrypted.dump");
    run("age", ["--decrypt", "--identity", ownerKey, "--output", plainDump, encDump], process.env);
    run("age", ["--decrypt", "--identity", ownerKey, "--output", `${plainDump}.sha256`, `${encDump.slice(0, -".dump.age".length)}.dump.sha256.age`], process.env);
    const corrupt = join(root, "corrupt.dump");
    const bytes = readFileSync(plainDump);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(corrupt, bytes);
    copyFileSync(`${plainDump}.sha256`, `${corrupt}.sha256`);
    const bad = restore(env, corrupt, "mfx_corrupt");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /checksum mismatch/);
    const exists = restore(env, plainDump, DB_NAME);
    assert.notEqual(exists.status, 0);
    assert.match(exists.stderr, /already exists/);
    const tamperSrc = restore(env, plainDump, "mfx_tamper_src");
    assert.equal(tamperSrc.status, 0, tamperSrc.stderr);
    await cluster.query("UPDATE audit_records SET actor_id = 'forged' WHERE sequence = 1", [], "mfx_tamper_src");
    const tamperedDump = join(root, "tampered.dump");
    run("pg_dump", ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", PG_USER, "--format=custom", `--file=${tamperedDump}`, "mfx_tamper_src"], cluster.env());
    const tampered = restore(env, tamperedDump, "mfx_tamper_check");
    assert.equal(tampered.status, 1);
    assert.match(tampered.stdout, /audit chain integrity_mismatch at sequence 1/);

    // F. Point-in-time recovery from the encrypted base backup + encrypted WAL archive.
    const baseDir = join(backupDir, "base", newBase);
    const walRestore = fwd(join(BACKUP_SCRIPTS, "wal-restore.sh"));
    const refusedBase = run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(join(root, "pitr-nokey")), walRestore], env, { allowFail: true });
    assert.notEqual(refusedBase.status, 0);
    assert.match(refusedBase.stderr, /is encrypted: set AGE_IDENTITY_FILE/);
    // The key is mounted only for the restore: in the restore script's and the server's environment.
    const restoreKey = { AGE_IDENTITY_FILE: fwd(ownerKey) };
    const full = new Cluster(join(root, "pitr-full"), await freePort(), walArchive, { ...encryptedMode, ...restoreKey });
    run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(full.dataDir), walRestore], { ...env, ...restoreKey });
    clusters.push(full);
    full.start();
    await waitPromoted(full);
    const afterRows = await full.query("SELECT email FROM users WHERE email = 'after-base@maintafox.systems'");
    assert.equal(afterRows.length, 1, "full WAL replay must contain the row written after the base backup");
    assert.equal((await full.query("SELECT COUNT(*)::int AS c FROM tenants"))[0].c, 2);
    full.stop();

    const pit = new Cluster(join(root, "pitr-target"), await freePort(), walArchive, { ...encryptedMode, ...restoreKey });
    run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(pit.dataDir), walRestore, targetBeforeInsert], { ...env, ...restoreKey });
    clusters.push(pit);
    pit.start();
    await waitPromoted(pit);
    const notYet = await pit.query("SELECT email FROM users WHERE email = 'after-base@maintafox.systems'");
    assert.equal(notYet.length, 0, "recovery to a time before the insert must not contain it");
    assert.equal((await pit.query("SELECT COUNT(*)::int AS c FROM tenants"))[0].c, 2);
    pit.stop();

    // The server without the key: recovery stops with a clear error instead of promoting early.
    const keyless = new Cluster(join(root, "pitr-keyless"), await freePort(), walArchive, encryptedMode);
    run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(keyless.dataDir), walRestore], { ...env, ...restoreKey });
    clusters.push(keyless);
    assert.throws(() => keyless.start(), /is encrypted: set AGE_IDENTITY_FILE \(the owner's private key file\) in the server environment/);

    console.log(
      "backup-restore-drill: OK (plaintext -> encrypted migration, verify-before-store, encrypted at rest, " +
        "restore drill, restore with/without key, refusals, audit tamper, encrypted point-in-time recovery)",
    );
  } finally {
    if (api) api.kill();
    for (const c of clusters) c.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

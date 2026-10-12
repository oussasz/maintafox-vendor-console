/**
 * Backup and restore drill against a real PostgreSQL 16 cluster (deploy/BACKUP_AND_RESTORE.md).
 *
 * Needs the PostgreSQL 16 server and client programs on PATH (initdb, pg_ctl, postgres, pg_dump,
 * pg_restore, pg_basebackup, pg_archivecleanup, psql, createdb, dropdb) and a POSIX `sh` with gzip
 * (Linux, or Git Bash on Windows). It refuses to run without them; it never pretends to pass.
 *
 * The cluster runs with the production WAL settings (archive_command = deploy/backup/wal-archive.sh,
 * hba_file = deploy/backup/pg_hba.conf). The real control API writes data into it, then:
 *   1. deploy/backup/backup.sh            -> dump + base backup + backup_runs row (off-site disabled)
 *   2. deploy/backup/restore-drill.sh     -> restore into a scratch DB, counts + migrations + audit
 *                                            chain verified, scratch DB dropped, drill recorded
 *   3. restore.sh refuses a corrupted dump (checksum) and an existing target database
 *   4. restore.sh detects a tampered audit ledger (chain broken -> exit 1)
 *   5. point-in-time recovery: base backup + archived WAL replayed into a new cluster contains the
 *      rows written AFTER the base backup; with a recovery target time before them it does not.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { TEST_SYNC_ENV } from "./lib/test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./lib/test-signing-key.mjs";

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_SCRIPTS = resolve(API_DIR, "../deploy/backup");
const ADMIN_EMAIL = "admin@maintafox.systems";
const ADMIN_PASSWORD = "AdminPassw0rd!";
const PG_USER = "mfx_drill";
const PG_PASSWORD = "drill-password-not-secret";
const DB_NAME = "maintafox";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
  constructor(dataDir, port, walArchiveDir) {
    this.dataDir = dataDir;
    this.port = port;
    this.walArchiveDir = walArchiveDir;
  }
  env() {
    return { ...process.env, MFX_WAL_ARCHIVE_DIR: fwd(this.walArchiveDir), PGPASSWORD: PG_PASSWORD };
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

function initCluster(root, port, walArchiveDir) {
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
  return new Cluster(dataDir, port, walArchiveDir);
}

function backupEnv(cluster, backupDir) {
  return {
    ...process.env,
    BACKUP_DIR: fwd(backupDir),
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
  for (let i = 0; i < 160; i += 1) {
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
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { access_token } = await login.json();
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

async function main() {
  requireTools();
  const root = mkdtempSync(join(tmpdir(), "mfx-backup-drill-"));
  const walArchive = join(root, "wal-archive");
  const backupDir = join(root, "backups");
  mkdirSync(walArchive);
  mkdirSync(backupDir);
  const clusters = [];
  let api = null;
  try {
    const cluster = initCluster(root, await freePort(), walArchive);
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

    // 1. Nightly backup, off-site disabled.
    const env = backupEnv(cluster, backupDir);
    const backup = run("sh", [join(BACKUP_SCRIPTS, "backup.sh")], env);
    assert.match(backup.stderr, /off-site copy is disabled/);
    const dumps = readdirSync(join(backupDir, "pg_dump")).filter((f) => f.endsWith(".dump"));
    assert.equal(dumps.length, 1, "one dump file");
    assert.ok(existsSync(join(backupDir, "pg_dump", `${dumps[0]}.sha256`)), "dump checksum file");
    const bases = readdirSync(join(backupDir, "base"));
    assert.equal(bases.length, 1, "one base backup");
    assert.ok(existsSync(join(backupDir, "base", bases[0], "base.tar.gz")));
    const [nightly] = await cluster.query("SELECT status, offsite_status, dump_file, detail FROM backup_runs WHERE kind = 'nightly'");
    assert.equal(nightly.status, "succeeded", nightly.detail);
    assert.equal(nightly.offsite_status, "disabled");
    assert.equal(nightly.dump_file, dumps[0]);
    assert.match(nightly.detail, /OFF-SITE COPY DISABLED/);

    // Rows written after the base backup (only recoverable through the WAL archive).
    await delay(1100);
    const [{ t: targetBeforeInsert }] = await cluster.query("SELECT now()::text AS t");
    await delay(1100);
    await cluster.query("INSERT INTO users (email, password_hash) VALUES ('after-base@maintafox.systems', 'x')");
    await waitArchived(cluster);

    // 2. Restore drill (scratch DB, verified, dropped, recorded).
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
    const scratch = await cluster.query("SELECT datname FROM pg_database WHERE datname LIKE 'mfx_restore_drill_%'", [], "postgres");
    assert.equal(scratch.length, 0, "scratch database dropped");

    // 3. Refusals: corrupted dump, existing target database.
    const dumpPath = join(backupDir, "pg_dump", dumps[0]);
    const corrupt = join(root, "corrupt.dump");
    const bytes = readFileSync(dumpPath);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(corrupt, bytes);
    copyFileSync(`${dumpPath}.sha256`, `${corrupt}.sha256`);
    const bad = run("sh", [join(BACKUP_SCRIPTS, "restore.sh"), corrupt, "mfx_corrupt"], env, { allowFail: true });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /checksum mismatch/);
    const exists = run("sh", [join(BACKUP_SCRIPTS, "restore.sh"), dumpPath, DB_NAME], env, { allowFail: true });
    assert.notEqual(exists.status, 0);
    assert.match(exists.stderr, /already exists/);

    // 4. A tampered audit ledger is detected.
    run("sh", [join(BACKUP_SCRIPTS, "restore.sh"), dumpPath, "mfx_tamper_src"], env);
    await cluster.query("UPDATE audit_records SET actor_id = 'forged' WHERE sequence = 1", [], "mfx_tamper_src");
    const tamperedDump = join(root, "tampered.dump");
    run("pg_dump", ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", PG_USER, "--format=custom", `--file=${tamperedDump}`, "mfx_tamper_src"], cluster.env());
    const tampered = run("sh", [join(BACKUP_SCRIPTS, "restore.sh"), tamperedDump, "mfx_tamper_check"], env, { allowFail: true });
    assert.equal(tampered.status, 1);
    assert.match(tampered.stdout, /audit chain integrity_mismatch at sequence 1/);

    // 5. Point-in-time recovery from the base backup + WAL archive.
    const baseDir = join(backupDir, "base", bases[0]);
    const walRestore = fwd(join(BACKUP_SCRIPTS, "wal-restore.sh"));
    const full = new Cluster(join(root, "pitr-full"), await freePort(), walArchive);
    run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(full.dataDir), walRestore], env);
    clusters.push(full);
    full.start();
    await waitPromoted(full);
    const afterRows = await full.query("SELECT email FROM users WHERE email = 'after-base@maintafox.systems'");
    assert.equal(afterRows.length, 1, "full WAL replay must contain the row written after the base backup");
    assert.equal((await full.query("SELECT COUNT(*)::int AS c FROM tenants"))[0].c, 2);
    full.stop();

    const pit = new Cluster(join(root, "pitr-target"), await freePort(), walArchive);
    run("sh", [join(BACKUP_SCRIPTS, "restore-physical.sh"), fwd(baseDir), fwd(pit.dataDir), walRestore, targetBeforeInsert], env);
    clusters.push(pit);
    pit.start();
    await waitPromoted(pit);
    const notYet = await pit.query("SELECT email FROM users WHERE email = 'after-base@maintafox.systems'");
    assert.equal(notYet.length, 0, "recovery to a time before the insert must not contain it");
    assert.equal((await pit.query("SELECT COUNT(*)::int AS c FROM tenants"))[0].c, 2);
    pit.stop();

    console.log("backup-restore-drill: OK (backup, restore drill, refusals, audit tamper, point-in-time recovery)");
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

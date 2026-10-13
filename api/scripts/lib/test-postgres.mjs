/**
 * Real Postgres for the integration scripts (no mocks). Each script gets its own fresh database.
 *
 * - TEST_DATABASE_ADMIN_URL set (e.g. a docker postgres in CI:
 *   postgres://postgres:postgres@127.0.0.1:5432/postgres): databases are created on that server.
 * - Otherwise an embedded PostgreSQL 16 server (npm `embedded-postgres`, dev dependency) is started
 *   in a temporary directory on a free port and removed again by stop().
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

/** Sync settings every spawned API needs (all required by the API, see .env.example). */
export const TEST_SYNC_ENV = {
  SYNC_CHECKPOINT_SECRET: "integration_test_sync_checkpoint_secret_min_32_chars",
  SYNC_INGRESS_RETENTION_DAYS: "30",
  SYNC_IDEMPOTENCY_RETENTION_DAYS: "7",
  SYNC_RETENTION_INTERVAL_MINUTES: "60",
  // TEST-ONLY key (32 bytes, base64): encryption at rest of sensitive sync payloads.
  SYNC_PAYLOAD_ENCRYPTION_KEY: Buffer.from("maintafox-TEST-ONLY-payload-key!").toString("base64"),
  OPERATOR_ACCESS_LOG_RETENTION_DAYS: "365",
  // Notification email: off unless a test configures its own SMTP server.
  EMAIL_DELIVERY_MODE: "disabled",
  // SlickPay: off unless a test runs its own SlickPay stand-in (billing.integration.mjs).
  SLICKPAY_MODE: "disabled",
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * @returns {Promise<{ createDatabase: () => Promise<string>, adminUrl: string, stop: () => Promise<void> }>}
 */
export async function startTestPostgres() {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL?.trim();
  let embedded = null;
  let dataDir = null;
  if (!adminUrl) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    dataDir = mkdtempSync(join(tmpdir(), "mfx-test-pg-"));
    const port = await freePort();
    const password = randomBytes(12).toString("hex");
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "data"),
      user: "mfx_test",
      password,
      port,
      // Deleted by stop() below with retries: on Windows the server can still hold its files for a
      // moment after it stops, and the library's own non-retrying delete then fails with EBUSY.
      persistent: true,
      onLog: () => {},
      onError: (msg) => process.stderr.write(`[embedded-postgres] ${String(msg)}\n`),
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgres://mfx_test:${password}@127.0.0.1:${port}/postgres`;
  }

  const created = [];
  return {
    adminUrl,
    async createDatabase() {
      const name = `mfx_test_${randomBytes(6).toString("hex")}`;
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`CREATE DATABASE ${name}`);
      } finally {
        await client.end();
      }
      created.push(name);
      return withDatabase(adminUrl, name);
    },
    async stop() {
      if (embedded) {
        // On Windows an auxiliary process forked during shutdown can outlive the postmaster and
        // keep the data directory open (EPERM on delete, and a leaked process). End the stopped
        // server's remaining children by parent PID before deleting.
        const pidFile = join(dataDir, "data", "postmaster.pid");
        const postmasterPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").split(/\r?\n/)[0]) : NaN;
        await embedded.stop();
        if (process.platform === "win32" && Number.isSafeInteger(postmasterPid) && postmasterPid > 0) {
          const r = spawnSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `Get-CimInstance Win32_Process -Filter "ParentProcessId=${postmasterPid} and Name='postgres.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
            ],
            { encoding: "utf8" },
          );
          if (r.status !== 0) process.stderr.write(`[embedded-postgres] could not end leftover children of ${postmasterPid}: ${r.stderr}\n`);
        }
        if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        return;
      }
      // Shared server: drop the databases this script created.
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        for (const name of created) {
          await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        }
      } finally {
        await client.end();
      }
    },
  };
}

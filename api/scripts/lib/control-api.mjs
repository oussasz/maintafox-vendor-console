/**
 * Starts the real control API (dist/index.js) on a fresh test database, for integration scripts.
 * `extraEnv` adds settings (e.g. the S3_* media bucket); nothing is stubbed.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

import pg from "pg";

import { startTestPostgres, TEST_SYNC_ENV } from "./test-postgres.mjs";
import { TEST_ENTITLEMENT_SIGNING_ENV } from "./test-signing-key.mjs";
import { loginOperator } from "./vendor-session.mjs";

export const TEST_ADMIN_EMAIL = "admin@maintafox.systems";
export const TEST_ADMIN_PASSWORD = "AdminPassw0rd!";

export async function startControlApi({ port, extraEnv = {} }) {
  const testPg = await startTestPostgres();
  const databaseUrl = await testPg.createDatabase();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const env = {
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    ...TEST_SYNC_ENV,
    JWT_SECRET: "integration_test_jwt_secret_value_with_minimum_length_12345",
    SEED_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
    SEED_ADMIN_EMAIL: TEST_ADMIN_EMAIL,
    ...TEST_ENTITLEMENT_SIGNING_ENV,
    SEED_BEHAVIOR: "safe",
    NODE_ENV: "production",
    CORS_ORIGIN: "http://localhost:5174",
    ...extraEnv,
  };
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (b) => (output += String(b)));
  server.stderr.on("data", (b) => (output += String(b)));

  const stop = async () => {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await once(server, "exit").catch(() => undefined);
    }
    await testPg.stop();
  };

  let healthy = false;
  for (let i = 0; i < 160 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      // keep polling
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 250));
  }
  if (!healthy) {
    await stop();
    throw new Error(`control API did not start:\n${output}`);
  }

  async function call(method, path, token, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }

  /** Sessions by access token, so `stepUpToken(adminToken, kind)` uses that session's authenticator. */
  const sessions = new Map();

  return {
    baseUrl,
    /** The API's environment (tools run against the same database, e.g. dist/tools/*.js). */
    env,
    call,
    output: () => output,
    stop,
    /** Signs the seeded operator in (password + TOTP, enrolling on first use); returns the access token. */
    async adminToken() {
      const session = await loginOperator(baseUrl, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
      sessions.set(session.accessToken, session);
      return session.accessToken;
    },
    /** A step-up token of `actionKind` (shared/step-up-actions.v1.json) for the session of `adminToken`. */
    stepUpToken(adminToken, actionKind) {
      const session = sessions.get(adminToken);
      if (!session) throw new Error("stepUpToken: unknown access token (use adminToken() first)");
      return session.stepUp(actionKind);
    },
    /** Claims a device on the licence key; returns its activation token. */
    async claimDevice(licenseKey, fingerprint) {
      const r = await call("POST", "/api/v1/activation/claim", null, {
        license_key: licenseKey,
        machine_fingerprint: fingerprint,
        app_version: "1.2.3",
      });
      if (r.status !== 200) throw new Error(`claim failed: ${r.text}`);
      return r.json.activation_token;
    },
    /** Superuser query (bypasses row-level security): ground truth for assertions. */
    async su(text, params = []) {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return (await client.query(text, params)).rows;
      } finally {
        await client.end();
      }
    },
  };
}

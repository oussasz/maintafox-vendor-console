/**
 * The real control API for the browser tests (playwright.config.ts starts it): a fresh database
 * (embedded PostgreSQL 16, or TEST_DATABASE_ADMIN_URL in CI) with the seeded owner who has not
 * enrolled an authenticator yet, exactly as after a first deploy. Needs `api/dist` (pnpm api:build).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_API_PORT } from "./ports.mjs";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
// startControlApi runs api/dist/index.js from the current directory.
process.chdir(apiDir);
const { startControlApi } = await import("../api/scripts/lib/control-api.mjs");

const api = await startControlApi({ port: E2E_API_PORT });
console.log(`control API for e2e on ${api.baseUrl}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await api.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * Browser tests of the vendor console against the real control API and a real PostgreSQL
 * (e2e/serve-api.mjs), with the console served by Vite. `pnpm test:e2e`; CI job `e2e`.
 * Needs the API built (`pnpm api:build`) and Chromium (`pnpm exec playwright install chromium`).
 */
import { defineConfig, devices } from "@playwright/test";

import { E2E_API_PORT, E2E_CONSOLE_PORT } from "./e2e/ports.mjs";

export default defineConfig({
  testDir: "e2e",
  // Each TOTP code is single use: a test may wait for the next 30-second step.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  outputDir: "e2e-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${E2E_CONSOLE_PORT}`,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/serve-api.mjs",
      url: `http://127.0.0.1:${E2E_API_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${E2E_CONSOLE_PORT} --strictPort`,
      url: `http://localhost:${E2E_CONSOLE_PORT}`,
      env: { VITE_ADMIN_API_BASE_URL: `http://localhost:${E2E_API_PORT}` },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});

/**
 * The vendor console end to end, against the real API and Postgres (e2e/serve-api.mjs):
 * first sign-in of the seeded owner (password, authenticator enrolment from the on-screen key,
 * recovery codes acknowledged); every section of the navigation; a customer created and suspended
 * with a reason and a fresh authenticator code (step-up), found in its history; an API failure shown
 * as a sentence with a retry; French. Codes are computed from RFC 6238 by
 * api/scripts/lib/vendor-session.mjs (written independently of the API TOTP).
 */
import { expect, test, type Page } from "@playwright/test";

import { freshCode } from "../api/scripts/lib/vendor-session.mjs";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "../api/scripts/lib/control-api.mjs";

const CODE_LABEL = "6-digit code from your authenticator app";

test.describe.configure({ mode: "serial" });

let page: Page;
let secret = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test("first sign-in enrols the authenticator and shows the recovery codes once", async () => {
  await page.goto("/vendor-console");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(TEST_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel(CODE_LABEL).fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm and finish" }).click();

  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I have saved these codes somewhere safe.").check();
  await proceed.click();
  await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
});

test("every section of the navigation opens", async () => {
  const nav = page.getByRole("navigation", { name: "Vendor console sections" });
  for (const [link, heading] of [
    ["Customers", "Customers"],
    ["Licences & editions", "Licences & editions"],
    ["Devices", "Devices"],
    ["Updates", "Updates"],
    ["Support", "Support"],
    ["System health", "System health"],
    ["Settings & team", "Settings & team"],
    ["Overview", /Good (morning|afternoon|evening)/],
  ] as const) {
    await nav.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  // Addresses from before the redesign still lead somewhere.
  await page.goto("/vendor-console/machines");
  await expect(page.getByRole("heading", { level: 1, name: "Devices" })).toBeVisible();
});

test("a customer is created, suspended with a reason and a code, and the history records it", async () => {
  await page.goto("/vendor-console/customers");
  await page.getByRole("button", { name: "+ New customer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Company name").fill("E2E Industries");
  await dialog.getByLabel("Tenant slug").fill("e2e-industries");
  await dialog.getByRole("button", { name: "Add customer/company" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "E2E Industries" })).toBeVisible();

  // Dangerous action: suspend, with a reason and a fresh authenticator code (step-up).
  await page.getByRole("button", { name: "Suspend customer" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByLabel("Reason (kept in the audit log)").fill("e2e: unpaid invoice");
  await confirm.getByRole("button", { name: "Suspend" }).click();
  await page.getByLabel(CODE_LABEL).fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/is suspended: its devices are refused/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Lift suspension" })).toBeVisible();

  await page.getByRole("tab", { name: "History" }).click();
  const row = page.getByRole("row", { name: /tenant_suspend/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("dialog").getByText(/e2e: unpaid invoice/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("an API failure reads as a sentence with a retry, never raw data", async () => {
  await page.route("**/api/v1/console/overview", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error", message: "stack trace here" }) }),
  );
  await page.goto("/vendor-console");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The server failed to process the request (HTTP 500).");
  await expect(alert).not.toContainText("internal_error");
  await page.unroute("**/api/v1/console/overview");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
});

test("French is selectable", async () => {
  await page.getByRole("combobox", { name: "Language" }).selectOption("fr");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Bonjour|Bon après-midi|Bonsoir/ })).toBeVisible();
});

/**
 * First sign-in of the seeded owner (password, authenticator enrolment from the on-screen key,
 * recovery codes acknowledged), then one dangerous action end to end: suspend a customer with a
 * reason and a fresh authenticator code, and find it in the audit ledger. Codes are computed from
 * RFC 6238 by api/scripts/lib/vendor-session.mjs (written independently of the API's TOTP).
 */
import { expect, test } from "@playwright/test";

import { freshCode } from "../api/scripts/lib/vendor-session.mjs";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "../api/scripts/lib/control-api.mjs";

const CODE_LABEL = "6-digit code from your authenticator app";

test("owner enrols TOTP on first sign-in, suspends a customer with step-up, and the ledger records it", async ({ page }) => {
  await page.goto("/vendor-console");
  await expect(page).toHaveURL(/\/login/);

  // Password.
  await page.getByLabel("Email").fill(TEST_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  // First sign-in: enrol the authenticator from the key shown under the QR code.
  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel(CODE_LABEL).fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm and finish" }).click();

  // Recovery codes are shown once; continuing needs the acknowledgement.
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I have saved these codes somewhere safe.").check();
  await proceed.click();
  await expect(page).toHaveURL(/\/vendor-console/);

  // A customer to act on.
  await page.goto("/vendor-console/customers");
  await page.getByRole("button", { name: "Add customer/company" }).first().click();
  const addDialog = page.getByRole("dialog");
  await addDialog.getByLabel("Company name").fill("E2E Industries");
  await addDialog.getByLabel("Tenant slug").fill("e2e-industries");
  await addDialog.getByRole("button", { name: "Add customer/company" }).click();
  const row = page.getByRole("row", { name: /e2e-industries/ });
  await expect(row).toBeVisible();

  // Dangerous action: suspend, with a reason and a fresh authenticator code (step-up).
  await row.getByRole("button", { name: "Suspend customer" }).click();
  const confirmDialog = page.getByRole("dialog");
  await confirmDialog.getByLabel("Reason (kept in the audit log)").fill("e2e: unpaid invoice");
  await confirmDialog.getByRole("button", { name: "Suspend" }).click();
  await page.getByLabel(CODE_LABEL).fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByText("Suspended")).toBeVisible();

  // The audit ledger has it, with the reason.
  await page.goto("/vendor-console/audit");
  const auditRow = page.getByRole("row", { name: /tenant_suspend/ });
  await expect(auditRow).toBeVisible();
  await auditRow.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("dialog").getByText(/e2e: unpaid invoice/)).toBeVisible();
  await page.keyboard.press("Escape");

  // French is selectable.
  await page.getByRole("combobox", { name: "Language" }).selectOption("fr");
  await expect(page.getByRole("link", { name: "Clients" })).toBeVisible();
});

/**
 * The vendor console end to end, against the real API and Postgres (e2e/serve-api.mjs):
 * first sign-in of the seeded owner (password, authenticator enrolment from the on-screen key,
 * recovery codes acknowledged); every section of the navigation; a customer created and suspended
 * with a reason and a fresh authenticator code (step-up), found in its history; an API failure shown
 * as a sentence with a retry; every page, tab, dialog and error state checked for WCAG AA colour
 * contrast (axe-core) in the light and the dark theme, and the theme kept per browser and applied
 * before the console starts; French. Codes are computed from RFC 6238 by
 * api/scripts/lib/vendor-session.mjs (written independently of the API TOTP).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { freshCode } from "../api/scripts/lib/vendor-session.mjs";
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "../api/scripts/lib/control-api.mjs";

const CODE_LABEL = "6-digit code from your authenticator app";
const THEMES = ["light", "dark"] as const;

test.describe.configure({ mode: "serial" });

let page: Page;
let secret = "";
let customerUrl = "";

/** Switches with the visible Light/Dark button (top bar, sign-in page). */
async function setTheme(theme: (typeof THEMES)[number]) {
  const html = page.locator("html");
  if (!((await html.getAttribute("class")) ?? "").split(/\s+/).includes(theme)) {
    await page.getByRole("button", { name: theme === "dark" ? "Switch to the dark theme" : "Switch to the light theme" }).click();
  }
  await expect(html).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

/** WCAG AA colour contrast of everything on screen (axe-core), once data and animations have settled. */
async function expectReadable(where: string) {
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
  const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  const problems = violations.flatMap((v) => v.nodes.map((n) => `${where}: ${n.target.join(" ")} ${n.any.map((c) => c.message).join(" ")}`));
  expect(problems).toEqual([]);
}

/** The current screen, readable in both themes; leaves the light theme on. */
async function expectReadableInBothThemes(where: string) {
  for (const theme of THEMES) {
    await setTheme(theme);
    await expectReadable(`${where} (${theme})`);
  }
  await setTheme("light");
}

test.beforeAll(async ({ browser }) => {
  // An explicit context (not browser.newPage()): axe-core runs in it.
  page = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

test("first sign-in enrols the authenticator and shows the recovery codes once", async () => {
  await page.goto("/vendor-console");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
  await expect(page.getByTestId("maintafox-mark-color")).toBeVisible();
  await expectReadableInBothThemes("sign-in");
  await page.getByLabel("Email").fill(TEST_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(TEST_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expectReadableInBothThemes("authenticator enrolment");
  await page.getByLabel(CODE_LABEL).fill(await freshCode(secret));
  await page.getByRole("button", { name: "Confirm and finish" }).click();

  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  await expectReadableInBothThemes("recovery codes");
  const proceed = page.getByRole("button", { name: "Continue" });
  await expect(proceed).toBeDisabled();
  await page.getByLabel("I have saved these codes somewhere safe.").check();
  await proceed.click();
  await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
  await expect(page.getByTestId("maintafox-mark-white")).toBeVisible();
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
  customerUrl = new URL(page.url()).pathname;

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

test("every page, tab, dialog and error state is readable in the light and the dark theme", async () => {
  // Nine pages and their tabs, three dialogs and an error state, twice.
  test.setTimeout(600_000);
  // The customer page of the (suspended) customer created above.
  expect(customerUrl).toMatch(/^\/vendor-console\/customers\/./);
  const pages: [string, string | RegExp][] = [
    ["/vendor-console", /Good (morning|afternoon|evening)/],
    ["/vendor-console/customers", "Customers"],
    [customerUrl, "E2E Industries"],
    ["/vendor-console/licences", "Licences & editions"],
    ["/vendor-console/devices", "Devices"],
    ["/vendor-console/updates", "Updates"],
    ["/vendor-console/support", "Support"],
    ["/vendor-console/health", "System health"],
    ["/vendor-console/settings", "Settings & team"],
  ];
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const [path, heading] of pages) {
      await page.goto(path);
      // A full page load per page and theme: the dev server may take a while to serve a lazy page.
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({ timeout: 60_000 });
      const tabs = page.getByRole("tab");
      const count = await tabs.count();
      if (count === 0) await expectReadable(`${path} (${theme})`);
      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        await tab.click();
        await expectReadable(`${path} > ${await tab.innerText()} (${theme})`);
      }
    }

    // Dialogs: a form, a confirmation with a reason, then the authenticator code (step-up), cancelled.
    await page.goto("/vendor-console/customers");
    await page.getByRole("button", { name: "+ New customer" }).click();
    await expectReadable(`new customer dialog (${theme})`);
    await page.keyboard.press("Escape");
    await page.goto(customerUrl);
    await page.getByRole("button", { name: "Lift suspension" }).click();
    const confirm = page.getByRole("dialog");
    await confirm.getByLabel("Reason (kept in the audit log)").fill("e2e: theme check, cancelled");
    await expectReadable(`confirmation dialog (${theme})`);
    await confirm.getByRole("button", { name: "Lift suspension" }).click();
    await expect(page.getByLabel(CODE_LABEL)).toBeVisible();
    await expectReadable(`step-up dialog (${theme})`);
    await page.keyboard.press("Escape");
    await expect(page.getByLabel(CODE_LABEL)).toBeHidden();

    // An error state.
    await page.route("**/api/v1/console/overview", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal_error" }) }),
    );
    await page.goto("/vendor-console");
    await expect(page.getByRole("alert")).toBeVisible();
    await expectReadable(`error state (${theme})`);
    await page.unroute("**/api/v1/console/overview");
  }
  await setTheme("light");
});

test("the theme choice is kept per browser and applied before the console starts", async ({ browser }) => {
  await page.goto("/vendor-console/settings?tab=display");
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  // Same browser, the console code blocked: public/theme-init.js alone sets the theme (no flash).
  const probe = await page.context().newPage();
  await probe.route("**/src/main.tsx", (route) => route.abort());
  await probe.goto("/login");
  await expect(probe.locator("html")).toHaveClass(/\bdark\b/);
  await probe.close();

  // Another browser that only has the old key from before the redesign opens in the light theme.
  const fresh = await browser.newContext();
  await fresh.addInitScript(() => window.localStorage.setItem("maintafox:theme:v2", "dark"));
  const other = await fresh.newPage();
  await other.goto("/login");
  await expect(other.locator("html")).toHaveClass(/\blight\b/);
  await expect(other.getByRole("button", { name: "Switch to the dark theme" })).toBeVisible();
  await fresh.close();

  await page.getByRole("radio", { name: "Light" }).check();
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
});

test("French is selectable", async () => {
  await page.goto("/vendor-console");
  await expect(page.getByRole("region", { name: "Key figures" })).toBeVisible();
  await page.getByRole("combobox", { name: "Language" }).selectOption("fr");
  await expect(page.getByRole("navigation").getByRole("link", { name: "Clients" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Bonjour|Bon après-midi|Bonsoir/ })).toBeVisible();
});

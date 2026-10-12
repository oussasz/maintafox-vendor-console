import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createInterface } from "node:readline/promises";

import { postAuth } from "./lib/vendor-session.mjs";

const BASE_URL = (process.env.BASE_URL ?? "https://api.maintafox.systems").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const OPERATOR_REASON = process.env.OPERATOR_REASON ?? "RC-UAT-S10";
const OUTPUT_DIR =
  process.env.OUTPUT_DIR ?? `./sprint10-uat-${new Date().toISOString().replace(/[:.]/g, "")}`;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Missing ADMIN_EMAIL or ADMIN_PASSWORD.");
  console.error(
    "Usage example: BASE_URL=https://api.maintafox.systems ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/sprint10-uat-real-infra.mjs",
  );
  process.exit(1);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const result = {
  generated_at_rfc3339: new Date().toISOString(),
  base_url: BASE_URL,
  checks: [],
  failures: [],
};

function record(name, ok, details = {}) {
  result.checks.push({ name, ok, ...details });
  if (!ok) result.failures.push({ name, ...details });
}

async function expectJson(name, path, token, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // noop
  }
  return { res, json, text };
}

const terminal = createInterface({ input: process.stdin, output: process.stderr });

/** Asks the operator for the current 6-digit authenticator code. */
async function askCode(purpose) {
  const code = (await terminal.question(`Authenticator code for ${purpose}: `)).trim();
  if (!/^\d{6}$/.test(code)) throw new Error("a 6-digit code is required");
  return code;
}

/** Step-up of one kind (shared/step-up-actions.v1.json) with a fresh code; a code is never accepted twice. */
async function stepUp(token, actionKind) {
  const res = await postAuth(BASE_URL, "/api/v1/auth/step-up", {
    bearer: token,
    body: { action_kind: actionKind, code: await askCode(`step-up ${actionKind} (wait for a new code)`) },
  });
  if (res.status !== 200) throw new Error(`step-up ${actionKind} failed (${res.status}): ${res.text}`);
  return res.json.step_up_token;
}

async function main() {
  // 0) Health
  {
    const { res } = await expectJson("health", "/health");
    record("health endpoint", res.ok, { status: res.status });
  }

  // 1) Auth
  // Password, then a code from the operator's authenticator app (typed here: the script never
  // holds the TOTP secret). The operator must already be enrolled (first console sign-in).
  const login = await expectJson("auth login", "/api/v1/auth/login", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (login.json?.status !== "mfa_required") {
    throw new Error(`login did not ask for the second factor (status ${login.res.status}): sign in once in the console to enrol.`);
  }
  const mfa = await postAuth(BASE_URL, "/api/v1/auth/mfa/verify", {
    bearer: login.json.mfa_token,
    body: { code: await askCode("sign-in") },
  });
  const token = mfa.json?.access_token;
  record("auth login success", mfa.status === 200 && typeof token === "string", { status: mfa.status });
  if (!token) {
    throw new Error("Cannot continue UAT without access token.");
  }

  // 2) Permissions
  {
    const { res, json } = await expectJson("permissions", "/api/v1/me/permissions", token);
    record("permissions endpoint", res.ok && Array.isArray(json), {
      status: res.status,
      count: Array.isArray(json) ? json.length : null,
    });
  }

  // 3) Tenant/license lifecycle
  const slug = `rc-uat-${Date.now().toString().slice(-8)}`;
  let tenantId = null;
  {
    const { res, json } = await expectJson("create tenant", "/api/v1/tenants", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        display_name: `RC UAT ${slug}`,
        rollout_cohort: "stable-main",
        update_channel: "stable",
      }),
    });
    tenantId = json?.id ?? null;
    record("tenant create", res.status === 201 && !!tenantId, { status: res.status, tenant_id: tenantId });
  }
  if (!tenantId) throw new Error("Cannot continue UAT without tenant_id");

  let licenseKey = null;
  let licenseId = null;
  {
    const { res, json } = await expectJson("issue license", "/api/v1/licenses", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: tenantId, max_machines: 1 }),
    });
    licenseKey = json?.license_key ?? null;
    licenseId = json?.id ?? null;
    record("license issue", res.status === 201 && !!licenseKey && !!licenseId, { status: res.status, license_id: licenseId });
  }
  if (!licenseKey || !licenseId) throw new Error("Cannot continue UAT without license");

  // 4) Force-update policy and activation
  {
    const { res } = await expectJson("set cohort update policy", "/api/v1/cohorts/stable/stable-main/update-policy", token, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Operator-Reason": OPERATOR_REASON,
        "X-Step-Up-Token": await stepUp(token, "rollout_publish"),
      },
      body: JSON.stringify({
        force_min_app_version: "9.9.9",
        force_update_mode: "required",
        force_update_reason: "RC UAT force-update validation",
      }),
    });
    record("cohort policy set", res.ok, { status: res.status });
  }

  {
    const { res, json } = await expectJson("activation claim force-update", "/api/v1/activation/claim", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        machine_fingerprint: `machine-${slug}-1`,
        app_version: "1.0.0",
      }),
    });
    record("activation claim accepted with force-update required", res.status === 200 && json?.force_update_required === true, {
      status: res.status,
      force_update_required: json?.force_update_required ?? null,
      policy_source: json?.force_update_policy_source ?? null,
    });
  }

  // 5) License revoke + deny state
  {
    const { res } = await expectJson("revoke license", `/api/v1/licenses/${encodeURIComponent(licenseId)}/revoke`, token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operator-Reason": OPERATOR_REASON,
        "X-Step-Up-Token": await stepUp(token, "entitlement_suspension"),
      },
      body: JSON.stringify({ reason: "RC UAT revoke validation" }),
    });
    record("license revoke", res.ok, { status: res.status });
  }
  {
    const { res, json } = await expectJson("activation denied after revoke", "/api/v1/activation/claim", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        machine_fingerprint: `machine-${slug}-2`,
        app_version: "10.0.0",
      }),
    });
    record("activation denied revoked", res.status === 403 && json?.error === "license_revoked", {
      status: res.status,
      error: json?.error ?? null,
    });
  }

  // 6) Ops telemetry surfaces
  for (const path of [
    "/api/v1/ops/sync-overview",
    "/api/v1/ops/rollout-overview",
    "/api/v1/ops/platform-overview",
    "/api/v1/ops/observability/slo",
  ]) {
    const { res } = await expectJson(path, path, token);
    record(`ops endpoint ${path}`, res.ok, { status: res.status });
  }

  // 7) Audit/support exports and diagnostics visibility
  {
    const { res } = await expectJson("audit ledger", "/api/v1/audit/ledger?limit=20", token);
    record("audit ledger list", res.ok, { status: res.status });
  }
  {
    const { res } = await expectJson("audit verify chain", "/api/v1/audit/ledger/verify-chain", token);
    record("audit ledger verify-chain", res.ok, { status: res.status });
  }
  {
    const res = await fetch(`${BASE_URL}/api/v1/audit/ledger/export`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/csv" },
    });
    const text = await res.text();
    record("audit ledger export csv", res.ok && text.includes("record_id"), {
      status: res.status,
      bytes: text.length,
    });
  }
  {
    const { res } = await expectJson("support tickets list", "/api/v1/support/tickets?limit=20", token);
    record("support tickets list", res.ok, { status: res.status });
  }
  {
    const res = await fetch(`${BASE_URL}/api/v1/support/tickets/export`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/csv" },
    });
    const text = await res.text();
    record("support tickets export csv", res.ok && text.includes("ticket_id"), {
      status: res.status,
      bytes: text.length,
    });
  }
  {
    const { res } = await expectJson("diagnostic bundle latest", "/api/v1/support/diagnostic-bundles/latest", token);
    record("diagnostic bundle visibility endpoint", res.status === 200 || res.status === 404, {
      status: res.status,
      note: "404 accepted when no bundles are seeded in production.",
    });
  }

  // 8) Roll back cohort policy to avoid leaving test constraint active
  {
    const { res } = await expectJson(
      "rollback cohort update policy",
      "/api/v1/cohorts/stable/stable-main/update-policy/rollback",
      token,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Operator-Reason": `${OPERATOR_REASON}-rollback`,
          "X-Step-Up-Token": await stepUp(token, "forced_rollback"),
        },
        body: JSON.stringify({}),
      },
    );
    record("cohort policy rollback", res.ok, { status: res.status });
  }

  const passed = result.failures.length === 0;
  const summary = {
    ...result,
    checks_total: result.checks.length,
    checks_passed: result.checks.filter((c) => c.ok).length,
    checks_failed: result.failures.length,
    rc_recommendation: passed ? "GO_CANDIDATE_PENDING_HUMAN_SIGNOFF" : "NO_GO",
  };

  writeFileSync(join(OUTPUT_DIR, "uat-results.json"), JSON.stringify(summary, null, 2), "utf8");
  const md = [
    "# Sprint 10 UAT Results",
    "",
    `- Generated: ${summary.generated_at_rfc3339}`,
    `- Base URL: ${summary.base_url}`,
    `- Total checks: ${summary.checks_total}`,
    `- Passed: ${summary.checks_passed}`,
    `- Failed: ${summary.checks_failed}`,
    `- RC recommendation: ${summary.rc_recommendation}`,
    "",
    "## Detailed checks",
    ...summary.checks.map(
      (c) => `- ${c.ok ? "PASS" : "FAIL"} - ${c.name} (status: ${c.status ?? "n/a"})`,
    ),
    "",
    summary.failures.length > 0 ? "## Failures" : "## Failures\n- none",
    ...summary.failures.map((f) => `- ${f.name} :: ${JSON.stringify(f)}`),
  ].join("\n");
  writeFileSync(join(OUTPUT_DIR, "uat-results.md"), md, "utf8");
  console.log(`Wrote Sprint 10 UAT evidence to ${OUTPUT_DIR}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => terminal.close());

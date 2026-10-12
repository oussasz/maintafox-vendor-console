/**
 * Vendor-console operator authentication (master plan Phase 4.1) against a real Postgres and the
 * real API: TOTP (RFC 6238 vectors), mandatory enrolment, no session without the second factor,
 * code replay refused, refresh-cookie rotation and reuse detection, logout and logout everywhere,
 * step-up bound to operator + session + action kind, recovery codes, and the lost-authenticator
 * CLI reset. Every security outcome must leave an audit row.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { startControlApi, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from "./lib/control-api.mjs";
import { currentStep, freshCode, postAuth, refreshCookieOf, totpAt } from "./lib/vendor-session.mjs";

// --- TOTP against RFC 6238 Appendix B (SHA-1, 8 digits) -------------------------------------
const { hotp, verifyTotp, base32Encode, base32Decode, TOTP_STEP_SECONDS } = await import("../dist/vendor-auth/totp.js");
const rfcSecret = Buffer.from("12345678901234567890", "ascii");
for (const [time, expected] of [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
]) {
  assert.equal(hotp(rfcSecret, Math.floor(time / TOTP_STEP_SECONDS), 8), expected, `RFC 6238 vector T=${time}`);
}
assert.deepEqual(base32Decode(base32Encode(rfcSecret)), rfcSecret, "base32 round trip");
// The test helper's independent implementation agrees with the server's.
assert.equal(totpAt(base32Encode(rfcSecret), 1), hotp(rfcSecret, 1));
// Drift window ±1 step, replay refused, malformed refused.
const t0 = 1_700_000_000;
const s0 = Math.floor(t0 / TOTP_STEP_SECONDS);
assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, s0 - 1), t0, null), s0 - 1);
assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, s0 + 1), t0, null), s0 + 1);
assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, s0 - 2), t0, null), null, "two steps old is refused");
assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, s0), t0, s0), null, "an accepted step is never accepted again");
assert.equal(verifyTotp(rfcSecret, "12345", t0, null), null);

const api = await startControlApi({ port: 33201 });
const ledger = async (token, code) => (await api.call("GET", `/api/v1/audit/ledger?q=${code}`, token)).json;
const passwordLogin = () =>
  postAuth(api.baseUrl, "/api/v1/auth/login", { body: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD } });

/** Runs the MFA reset CLI with the API's environment; returns exit code and output. */
async function runResetCli(reason) {
  const cli = spawn(process.execPath, ["dist/tools/vendor-mfa-reset.js", "--email", TEST_ADMIN_EMAIL, "--reason", reason], {
    cwd: process.cwd(),
    env: { ...process.env, ...api.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  cli.stdout.on("data", (b) => (out += String(b)));
  cli.stderr.on("data", (b) => (out += String(b)));
  const [code] = await once(cli, "exit");
  return { code, out };
}

try {
  // --- First login: password alone gives no session, only enrolment ---------------------------
  const wrong = await postAuth(api.baseUrl, "/api/v1/auth/login", { body: { email: TEST_ADMIN_EMAIL, password: "nope-nope" } });
  assert.equal(wrong.status, 401);
  const unknown = await postAuth(api.baseUrl, "/api/v1/auth/login", { body: { email: "nobody@example.com", password: "nope-nope" } });
  assert.deepEqual([unknown.status, unknown.json], [401, { error: "invalid_credentials" }], "unknown and known accounts look alike");
  const first = await passwordLogin();
  assert.equal(first.status, 200);
  assert.equal(first.json.status, "mfa_enrollment_required");
  assert.equal(first.json.access_token, undefined, "no access token before the second factor");
  const mfaToken = first.json.mfa_token;
  assert.equal((await api.call("GET", "/api/v1/tenants", mfaToken)).status, 401, "MFA-pending token is not an access token");
  assert.equal((await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", { bearer: mfaToken, body: { code: "123456" } })).status, 409);

  const start = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/start", { bearer: mfaToken });
  assert.equal(start.status, 200);
  assert.match(start.json.otpauth_uri, /^otpauth:\/\/totp\/Maintafox%20Vendor%20Console:/);
  const secret = start.json.secret_base32;
  const stored = await api.su("SELECT totp_pending_sealed, totp_secret_sealed FROM users WHERE lower(email) = lower($1)", [
    TEST_ADMIN_EMAIL,
  ]);
  assert.match(stored[0].totp_pending_sealed, /^mfxenc:v1:/, "TOTP secret is sealed at rest");
  assert.ok(!stored[0].totp_pending_sealed.includes(secret));
  assert.equal(stored[0].totp_secret_sealed, null, "not active before confirmation");

  const badConfirm = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/confirm", {
    bearer: mfaToken,
    body: { code: totpAt(secret, currentStep() + 5) },
  });
  assert.equal(badConfirm.status, 401);
  assert.equal(badConfirm.json.error, "invalid_mfa_code");

  const confirmCode = await freshCode(secret);
  const confirmed = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/confirm", { bearer: mfaToken, body: { code: confirmCode } });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.json.expires_in, 15 * 60, "access token lives 15 minutes");
  assert.equal(confirmed.json.recovery_codes.length, 10);
  const recoveryCodes = confirmed.json.recovery_codes;
  const setCookie = confirmed.headers.getSetCookie().find((c) => c.startsWith("mfx_vendor_refresh="));
  assert.ok(setCookie, "refresh cookie set");
  for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=Strict/i, /Path=\/api\/v1\/auth/i]) assert.match(setCookie, attr);
  const firstCookie = refreshCookieOf(confirmed.headers);
  const firstAccess = confirmed.json.access_token;
  assert.equal((await api.call("GET", "/api/v1/tenants", firstAccess)).status, 200);
  assert.equal(
    (await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/start", { bearer: mfaToken })).status,
    409,
    "enrolment cannot be restarted once active",
  );
  const codesAtRest = await api.su("SELECT code_sha256 FROM vendor_recovery_codes");
  assert.equal(codesAtRest.length, 10);
  assert.ok(codesAtRest.every((r) => /^[0-9a-f]{64}$/.test(r.code_sha256)), "recovery codes stored hashed");

  // --- Second login: TOTP required, replay refused --------------------------------------------
  const second = await passwordLogin();
  assert.equal(second.json.status, "mfa_required");
  const replay = await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", { bearer: second.json.mfa_token, body: { code: confirmCode } });
  assert.equal(replay.status, 401, "the code used for enrolment cannot be used again");
  const verified = await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", {
    bearer: second.json.mfa_token,
    body: { code: await freshCode(secret) },
  });
  assert.equal(verified.status, 200, verified.text);
  const access = verified.json.access_token;
  const cookie = refreshCookieOf(verified.headers);

  // --- Session info ---------------------------------------------------------------------------
  const info = await api.call("GET", "/api/v1/auth/session", firstAccess);
  assert.equal(info.status, 200);
  assert.equal(info.json.user.email, TEST_ADMIN_EMAIL);
  assert.equal(info.json.mfa.recovery_codes_remaining, 10);

  // --- Refresh: rotation, origin check, reuse detection -----------------------------------------
  const noOrigin = await fetch(`${api.baseUrl}/api/v1/auth/refresh`, { method: "POST", headers: { Cookie: firstCookie } });
  assert.equal(noOrigin.status, 403, "cookie routes require the console origin");
  const foreign = await fetch(`${api.baseUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { Cookie: firstCookie, Origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  const rotated = await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie: firstCookie });
  assert.equal(rotated.status, 200, rotated.text);
  const newCookie = refreshCookieOf(rotated.headers);
  assert.ok(newCookie && newCookie !== firstCookie, "refresh rotates the cookie");
  assert.equal((await api.call("GET", "/api/v1/tenants", rotated.json.access_token)).status, 200);
  // Presented again at once while its successor is unused: a lost response, refused but not a theft.
  const lost = await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie: firstCookie });
  assert.equal(lost.status, 401);
  assert.equal((await api.call("GET", "/api/v1/tenants", firstAccess)).status, 200, "a lost response does not end the session");
  // Once the successor is used, the old token is a stolen copy.
  const rotatedAgain = await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie: newCookie });
  assert.equal(rotatedAgain.status, 200, rotatedAgain.text);
  const newestCookie = refreshCookieOf(rotatedAgain.headers);
  const reused = await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie: firstCookie });
  assert.equal(reused.status, 401, "an exchanged refresh token is reuse");
  assert.equal((await api.call("GET", "/api/v1/tenants", firstAccess)).status, 401, "reuse revokes the session's access tokens");
  assert.equal((await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie: newestCookie })).status, 401, "and its newest refresh token");
  assert.equal((await api.call("GET", "/api/v1/tenants", access)).status, 200, "other sessions are untouched");
  assert.ok((await ledger(access, "refresh_token_reuse_detected")).length >= 1, "reuse is audited");

  // --- Step-up: bound to kind, operator session, fresh code ---------------------------------
  const tenant = await api.call("POST", "/api/v1/tenants", access, { slug: "auth-t", display_name: "Auth T" });
  assert.equal(tenant.status, 201, tenant.text);
  const lic = await api.call("POST", "/api/v1/licenses", access, { tenant_id: tenant.json.id, max_machines: 2 });
  assert.equal(lic.status, 201, lic.text);
  const unknownKind = await postAuth(api.baseUrl, "/api/v1/auth/step-up", {
    bearer: access,
    body: { action_kind: "launch_missiles", code: await freshCode(secret) },
  });
  assert.equal(unknownKind.status, 400);
  const badCode = await postAuth(api.baseUrl, "/api/v1/auth/step-up", {
    bearer: access,
    body: { action_kind: "rollout_publish", code: totpAt(secret, currentStep() + 7) },
  });
  assert.equal(badCode.status, 401);
  const publish = await postAuth(api.baseUrl, "/api/v1/auth/step-up", {
    bearer: access,
    body: { action_kind: "rollout_publish", code: await freshCode(secret) },
  });
  assert.equal(publish.status, 200, publish.text);
  assert.equal(publish.json.action_kind, "rollout_publish");
  const revokeWith = (token, bearer = access) =>
    api.call(
      "POST",
      `/api/v1/licenses/${lic.json.id}/revoke`,
      bearer,
      { reason: "auth test" },
      { "X-Operator-Reason": "AUTH-TEST", "X-Step-Up-Token": token },
    );
  const mismatch = await revokeWith(publish.json.step_up_token);
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.reason, "step_up_action_kind_mismatch", "a rollout_publish proof cannot revoke a licence");
  assert.ok((await ledger(access, "privileged_action_denied")).length >= 1, "refused proof is audited");
  const suspension = await postAuth(api.baseUrl, "/api/v1/auth/step-up", {
    bearer: access,
    body: { action_kind: "entitlement_suspension", code: await freshCode(secret) },
  });
  assert.equal(suspension.status, 200);
  const otherSession = rotated.json.access_token; // revoked above by reuse; a live one follows
  assert.equal((await revokeWith(suspension.json.step_up_token, otherSession)).status, 401);
  const revoked = await revokeWith(suspension.json.step_up_token);
  assert.equal(revoked.status, 200, revoked.text);
  assert.ok((await ledger(access, "license_revoke")).length >= 1, "privileged action audited");

  // --- Recovery codes: login once each, regenerate needs own_mfa_change ------------------------
  const third = await passwordLogin();
  const viaRecovery = await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", {
    bearer: third.json.mfa_token,
    body: { recovery_code: recoveryCodes[0].toLowerCase() },
  });
  assert.equal(viaRecovery.status, 200, viaRecovery.text);
  assert.equal(viaRecovery.json.recovery_codes_remaining, 9);
  const recoveryAccess = viaRecovery.json.access_token;
  // A step-up token is bound to the session it was issued in.
  assert.equal(
    (await revokeWith(suspension.json.step_up_token, recoveryAccess)).json.reason,
    "invalid_or_expired_step_up_token",
    "another session cannot spend this session's proof",
  );
  const fourth = await passwordLogin();
  const spent = await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", {
    bearer: fourth.json.mfa_token,
    body: { recovery_code: recoveryCodes[0] },
  });
  assert.equal(spent.status, 401, "a recovery code works once");
  const regenWrongKind = await api.call("POST", "/api/v1/auth/mfa/recovery-codes", access, undefined, {
    "X-Operator-Reason": "lost paper",
    "X-Step-Up-Token": suspension.json.step_up_token,
  });
  assert.equal(regenWrongKind.status, 403);
  const own = await postAuth(api.baseUrl, "/api/v1/auth/step-up", {
    bearer: access,
    body: { action_kind: "own_mfa_change", code: await freshCode(secret) },
  });
  const regen = await api.call("POST", "/api/v1/auth/mfa/recovery-codes", access, undefined, {
    "X-Operator-Reason": "lost paper",
    "X-Step-Up-Token": own.json.step_up_token,
  });
  assert.equal(regen.status, 200, regen.text);
  assert.equal(regen.json.recovery_codes.length, 10);
  const fifth = await passwordLogin();
  const oldCode = await postAuth(api.baseUrl, "/api/v1/auth/mfa/verify", {
    bearer: fifth.json.mfa_token,
    body: { recovery_code: recoveryCodes[1] },
  });
  assert.equal(oldCode.status, 401, "regeneration invalidates the old codes");

  // --- Logout (this browser) and logout everywhere ----------------------------------------------
  const loggedOut = await postAuth(api.baseUrl, "/api/v1/auth/logout", { cookie });
  assert.equal(loggedOut.status, 204);
  assert.equal((await api.call("GET", "/api/v1/tenants", access)).status, 401, "logout ends the access token");
  assert.equal((await postAuth(api.baseUrl, "/api/v1/auth/refresh", { cookie })).status, 401);
  assert.equal((await api.call("GET", "/api/v1/tenants", recoveryAccess)).status, 200);
  const all = await api.call("POST", "/api/v1/auth/logout-all", recoveryAccess);
  assert.equal(all.status, 200);
  assert.ok(all.json.sessions_revoked >= 1);
  assert.equal((await api.call("GET", "/api/v1/tenants", recoveryAccess)).status, 401, "logout everywhere ends every session");
  const openSessions = await api.su("SELECT count(*)::int AS n FROM vendor_sessions WHERE revoked_at IS NULL");
  assert.equal(openSessions[0].n, 0);

  // --- Lost authenticator: CLI reset on the server ---------------------------------------------
  assert.notEqual((await runResetCli("x")).code, 0, "the CLI refuses a reason under 10 characters");
  const reset = await runResetCli("phone lost, ticket OPS-1");
  assert.equal(reset.code, 0, reset.out);
  const resetReport = JSON.parse(reset.out.trim().split("\n").pop());
  assert.equal(resetReport.ok, true);
  assert.match(resetReport.reset_code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
  const ledgerText = JSON.stringify(await api.su("SELECT * FROM audit_records WHERE action_code = 'mfa_reset'"));
  assert.ok(!ledgerText.includes(resetReport.reset_code), "the reset code is never written to the ledger");
  const afterReset = await api.su("SELECT totp_secret_sealed FROM users WHERE lower(email) = lower($1)", [TEST_ADMIN_EMAIL]);
  assert.equal(afterReset[0].totp_secret_sealed, null);
  const resetAudit = await api.su("SELECT actor_id, reason_code FROM audit_records WHERE action_code = 'mfa_reset'");
  assert.equal(resetAudit.length, 1);
  assert.equal(resetAudit[0].actor_id, "system:cli-vendor-mfa-reset");
  assert.equal(resetAudit[0].reason_code, "phone lost, ticket OPS-1");
  const relogin = await passwordLogin();
  assert.equal(relogin.json.status, "mfa_enrollment_required", "after the reset the next login enrols again");
  assert.equal(relogin.json.reset_code_required, true);
  // The password alone cannot claim the account: enrolment needs the printed reset code.
  const noCode = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/start", { bearer: relogin.json.mfa_token });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.error, "invalid_reset_code");
  const wrongCode = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/start", {
    bearer: relogin.json.mfa_token,
    body: { reset_code: "ZZZZZ-ZZZZZ" },
  });
  assert.equal(wrongCode.status, 401);
  const reEnrol = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/start", {
    bearer: relogin.json.mfa_token,
    body: { reset_code: resetReport.reset_code.toLowerCase() },
  });
  assert.equal(reEnrol.status, 200, reEnrol.text);
  const reConfirm = await postAuth(api.baseUrl, "/api/v1/auth/mfa/enroll/confirm", {
    bearer: relogin.json.mfa_token,
    body: { code: await freshCode(reEnrol.json.secret_base32) },
  });
  assert.equal(reConfirm.status, 200, reConfirm.text);
  const afterReEnrol = await api.su("SELECT mfa_reset_code_sha256 FROM users WHERE lower(email) = lower($1)", [TEST_ADMIN_EMAIL]);
  assert.equal(afterReEnrol[0].mfa_reset_code_sha256, null, "the reset code is spent by the new enrolment");

  // --- Every security outcome is in the ledger --------------------------------------------------
  const codes = new Set(
    (await api.su("SELECT action_code FROM audit_records WHERE action_category = 'vendor_auth'")).map((r) => r.action_code),
  );
  for (const expected of [
    "login_failure",
    "login_password_accepted",
    "mfa_enrollment_started",
    "mfa_failure",
    "mfa_enrolled",
    "login_success",
    "refresh_rotated",
    "refresh_token_reuse_detected",
    "step_up_granted",
    "step_up_failure",
    "privileged_action_denied",
    "logout",
    "logout_all",
    "mfa_reset",
    "mfa_recovery_codes_regenerated",
  ]) {
    assert.ok(codes.has(expected), `audit ledger has ${expected}`);
  }
  console.log("vendor auth integration: OK");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

/**
 * Vendor-operator login for integration scripts (master plan Phase 4.1): password, then TOTP —
 * enrolling the authenticator on first login exactly as the console does — then step-up tokens
 * per action kind. The TOTP code generator below is written independently of the API's
 * (api/src/vendor-auth/totp.ts), from RFC 6238, so the tests check the server against the RFC.
 *
 * TOTP secrets are kept per (baseUrl, email) for the life of the process, so a script that logs
 * in twice reuses the enrolled authenticator like a person would.
 */
import { createHmac } from "node:crypto";

/** Origin the API accepts on cookie routes (CORS_ORIGIN of the test servers). */
export const TEST_CONSOLE_ORIGIN = "http://localhost:5174";
const STEP_SECONDS = 30;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text.replace(/=+$/, "").toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`bad base32 character '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits) for one 30-second step. */
export function totpAt(secretBase32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export function currentStep() {
  return Math.floor(Date.now() / 1000 / STEP_SECONDS);
}

const enrolled = new Map();
const lastStepBySecret = new Map();

/**
 * A code the server has not accepted yet: the server accepts one step either side of now and never
 * the same step twice, so take the earliest unused step in that window (waiting if all are used).
 */
export async function freshCode(secretBase32) {
  for (;;) {
    const now = currentStep();
    const last = lastStepBySecret.get(secretBase32) ?? -Infinity;
    const step = Math.max(now - 1, last + 1);
    if (step <= now + 1) {
      lastStepBySecret.set(secretBase32, step);
      return totpAt(secretBase32, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function post(baseUrl, path, { bearer, body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: TEST_CONSOLE_ORIGIN,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** `name=value` of the refresh cookie set by a response (null when none or cleared). */
export function refreshCookieOf(headers) {
  const setCookie = headers.getSetCookie?.() ?? [];
  const cookie = setCookie.find((c) => c.startsWith("mfx_vendor_refresh="));
  if (!cookie) return null;
  const pair = cookie.split(";")[0];
  return pair === "mfx_vendor_refresh=" ? null : pair;
}

/**
 * Logs in (enrolling TOTP on first login). Returns the session: access token, refresh cookie,
 * TOTP secret, recovery codes (first login only) and `stepUp(kind)` (cached per kind for its TTL).
 */
export async function loginOperator(baseUrl, email, password) {
  const login = await post(baseUrl, "/api/v1/auth/login", { body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed (${login.status}): ${login.text}`);
  const key = `${baseUrl}|${email.toLowerCase()}`;
  let done;
  let secret = enrolled.get(key);
  let recoveryCodes = null;
  if (login.json.status === "mfa_enrollment_required") {
    const start = await post(baseUrl, "/api/v1/auth/mfa/enroll/start", { bearer: login.json.mfa_token });
    if (start.status !== 200) throw new Error(`enroll/start failed (${start.status}): ${start.text}`);
    secret = start.json.secret_base32;
    done = await post(baseUrl, "/api/v1/auth/mfa/enroll/confirm", {
      bearer: login.json.mfa_token,
      body: { code: await freshCode(secret) },
    });
    if (done.status !== 200) throw new Error(`enroll/confirm failed (${done.status}): ${done.text}`);
    enrolled.set(key, secret);
    recoveryCodes = done.json.recovery_codes;
  } else if (login.json.status === "mfa_required") {
    if (!secret) throw new Error(`${email} is enrolled, but this process does not know its TOTP secret`);
    done = await post(baseUrl, "/api/v1/auth/mfa/verify", {
      bearer: login.json.mfa_token,
      body: { code: await freshCode(secret) },
    });
    if (done.status !== 200) throw new Error(`mfa/verify failed (${done.status}): ${done.text}`);
  } else {
    throw new Error(`unexpected login status: ${login.text}`);
  }
  const session = {
    accessToken: done.json.access_token,
    refreshCookie: refreshCookieOf(done.headers),
    totpSecret: secret,
    recoveryCodes,
    stepUps: new Map(),
    /** A step-up token for `actionKind`, reused while it has more than 30 s left. */
    async stepUp(actionKind) {
      const cached = session.stepUps.get(actionKind);
      if (cached && cached.expiresAt - Date.now() > 30_000) return cached.token;
      const res = await post(baseUrl, "/api/v1/auth/step-up", {
        bearer: session.accessToken,
        body: { action_kind: actionKind, code: await freshCode(secret) },
      });
      if (res.status !== 200) throw new Error(`step-up ${actionKind} failed (${res.status}): ${res.text}`);
      session.stepUps.set(actionKind, { token: res.json.step_up_token, expiresAt: Date.now() + res.json.expires_in * 1000 });
      return res.json.step_up_token;
    },
  };
  return session;
}

/** Access token only (scripts that never need step-up). */
export async function loginAccessToken(baseUrl, email, password) {
  return (await loginOperator(baseUrl, email, password)).accessToken;
}

export { post as postAuth };

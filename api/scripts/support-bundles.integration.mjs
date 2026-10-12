/**
 * Diagnostic bundle upload (master plan Phase 3.4) end to end, exactly as the desktop does it:
 * declare -> PUT to the presigned URL -> complete (the server reads the object back and checks
 * size + SHA-256) -> the console lists it and downloads it through a presigned URL (audited).
 *
 * Needs an S3-compatible server: TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY
 * (CI: Adobe S3Mock). Refuses to run without them; it never pretends to pass.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { startControlApi } from "./lib/control-api.mjs";

const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.TEST_S3_SECRET_KEY?.trim();
if (!endpoint || !accessKey || !secretKey) {
  console.error("TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY are required (an S3-compatible test server).");
  process.exit(1);
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const api = await startControlApi({
  port: 33193,
  extraEnv: {
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: accessKey,
    S3_SECRET_KEY: secretKey,
    S3_BUCKET: `mfx-support-${randomBytes(3).toString("hex")}`,
    S3_FORCE_PATH_STYLE: "true",
    DEPLOYMENT_ENV: "ci",
  },
});
try {
  const admin = await api.adminToken();
  const devices = {};
  for (const name of ["alpha", "beta"]) {
    const t = await api.call("POST", "/api/v1/tenants", admin, { slug: `bundle-${name}`, display_name: `Bundle ${name}` });
    const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: t.json.id, max_machines: 2 });
    devices[name] = {
      tenantId: t.json.id,
      one: await api.claimDevice(l.json.license_key, `${name}-device-1`),
      two: await api.claimDevice(l.json.license_key, `${name}-device-2`),
    };
  }
  const bundleBytes = Buffer.from(JSON.stringify({ generated_at: new Date().toISOString(), log_lines: ["line 1", "line 2"] }));
  const declare = (token, bytes = bundleBytes, extra = {}) =>
    api.call("POST", "/api/v1/sync/diagnostic-bundles", token, {
      content_sha256: sha256(bytes),
      byte_size: bytes.length,
      redaction_profile: "desktop_log_sanitizer_v1",
      app_version: "1.2.3",
      artifacts: [{ logical_path: "support-bundle.json", sha256: sha256(bytes), kind: "support_bundle_json" }],
      ...extra,
    });
  const put = async (url, bytes) => {
    const res = await fetch(url, { method: "PUT", body: bytes });
    assert.ok(res.ok, `presigned PUT failed: ${res.status} ${await res.text()}`);
  };

  // Validation: oversize and malformed declarations are refused.
  assert.equal((await declare(devices.alpha.one, bundleBytes, { byte_size: 6 * 1024 * 1024 })).status, 400);
  assert.equal((await declare(devices.alpha.one, bundleBytes, { content_sha256: "nope" })).status, 400);
  assert.equal((await api.call("POST", "/api/v1/sync/diagnostic-bundles", null, {})).status, 401);

  // Happy path with a ticket request.
  const d = await declare(devices.alpha.one, bundleBytes, {
    ticket: { summary: "Sync shows errors since this morning", affected_module: "sync", severity: "warn" },
  });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.equal(d.json.upload.method, "PUT");
  const bundleId = d.json.bundle_id;
  // Completing before the upload: nothing to verify.
  assert.equal((await api.call("POST", `/api/v1/sync/diagnostic-bundles/${bundleId}/complete`, devices.alpha.one)).status, 409);
  await put(d.json.upload.url, bundleBytes);
  // Another device (even of the same tenant) cannot complete it; another tenant cannot see it.
  assert.equal((await api.call("POST", `/api/v1/sync/diagnostic-bundles/${bundleId}/complete`, devices.alpha.two)).status, 404);
  assert.equal((await api.call("POST", `/api/v1/sync/diagnostic-bundles/${bundleId}/complete`, devices.beta.one)).status, 404);
  const done = await api.call("POST", `/api/v1/sync/diagnostic-bundles/${bundleId}/complete`, devices.alpha.one);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, "uploaded");
  assert.match(done.json.ticket_id, /^sup_/);
  // Completing again is idempotent.
  assert.deepEqual((await api.call("POST", `/api/v1/sync/diagnostic-bundles/${bundleId}/complete`, devices.alpha.one)).json, done.json);

  // The ticket opened by the device.
  const tickets = (await api.call("GET", "/api/v1/support/tickets", admin)).json;
  const ticket = tickets.find((t) => t.ticket_id === done.json.ticket_id);
  assert.equal(ticket.origin, "device");
  assert.equal(ticket.created_by, "device:alpha-device-1");
  assert.equal(ticket.tenant_id, devices.alpha.tenantId);
  assert.equal(ticket.app_version_reported, "1.2.3");
  assert.deepEqual(ticket.diagnostic_bundle_ids, [bundleId]);

  // A tampered upload (different bytes than declared) is rejected and recorded.
  const t2 = await declare(devices.alpha.two);
  await put(t2.json.upload.url, Buffer.from("something else entirely"));
  const rejected = await api.call("POST", `/api/v1/sync/diagnostic-bundles/${t2.json.bundle_id}/complete`, devices.alpha.two);
  assert.equal(rejected.status, 422);
  assert.equal(rejected.json.error, "bundle_verification_failed");

  // Console: list, latest, download (presigned GET returns the exact bytes; audited).
  const list = (await api.call("GET", "/api/v1/support/diagnostic-bundles", admin)).json;
  assert.deepEqual(list.map((b) => b.status).sort(), ["rejected", "uploaded"]);
  const uploaded = list.find((b) => b.bundle_id === bundleId);
  assert.equal(uploaded.content_sha256, sha256(bundleBytes));
  assert.equal(uploaded.machine_id, "alpha-device-1");
  assert.equal(uploaded.artifacts[0].logical_path, "support-bundle.json");
  assert.equal((await api.call("GET", `/api/v1/support/diagnostic-bundles?tenant_id=${devices.beta.tenantId}`, admin)).json.length, 0);
  assert.equal((await api.call("GET", "/api/v1/support/diagnostic-bundles/latest", admin)).json.bundle_id, bundleId);
  assert.equal((await api.call("GET", `/api/v1/support/diagnostic-bundles/${t2.json.bundle_id}/download`, admin)).status, 409);
  const link = await api.call("GET", `/api/v1/support/diagnostic-bundles/${bundleId}/download`, admin);
  assert.equal(link.status, 200, JSON.stringify(link.json));
  const downloaded = Buffer.from(await (await fetch(link.json.url)).arrayBuffer());
  assert.equal(sha256(downloaded), sha256(bundleBytes));
  const ledger = (await api.call("GET", "/api/v1/audit/ledger?q=diagnostic_bundle_download", admin)).json;
  assert.ok(ledger.some((r) => r.record_id === link.json.audit_record_id));

  // Readiness: an uploaded, verified bundle exists.
  const readiness = (await api.call("GET", "/api/v1/audit/hardening/readiness", admin)).json;
  assert.equal(readiness.find((c) => c.code === "export_redaction").passed, true);

  // Row-level security: the bundle row belongs to alpha.
  const [row] = await api.su("SELECT tenant_id FROM diagnostic_bundles WHERE bundle_id = $1", [bundleId]);
  assert.equal(row.tenant_id, devices.alpha.tenantId);
  console.log("support-bundles: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

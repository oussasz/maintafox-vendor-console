/**
 * Release catalog and desktop update manifest (master plan Phase 5.2-5.4) end to end against a
 * real Postgres, the real API and an S3-compatible server:
 *   CI publisher key -> declare -> presigned PUT -> complete (size, SHA-256, updater signature
 *   checked by the server) -> draft -> publish to rings with a rollout % -> devices ask the
 *   manifest exactly as the Tauri updater does -> floor, pause, recall, rollback -> audit.
 *
 * Needs TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY (CI: Adobe S3Mock). Refuses to
 * run without them; it never pretends to pass.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import { startControlApi } from "./lib/control-api.mjs";
import { TAURI_VECTOR, testUpdaterKey } from "./lib/test-updater-signature.mjs";

const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const accessKey = process.env.TEST_S3_ACCESS_KEY?.trim();
const secretKey = process.env.TEST_S3_SECRET_KEY?.trim();
if (!endpoint || !accessKey || !secretKey) {
  console.error("TEST_S3_ENDPOINT / TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY are required (an S3-compatible test server).");
  process.exit(1);
}

// ── Pure logic: versions and rollout buckets (dist build of api/src/releases) ─────────────────
const manifest = await import("../dist/releases/update-manifest.js");
const minisign = await import("../dist/releases/minisign.js");
{
  const { compareVersions, rolloutBucket } = manifest;
  assert.ok(compareVersions("0.4.0-dev", "0.4.0") < 0, "a pre-release sorts before its release");
  assert.ok(compareVersions("1.10.0", "1.9.3") > 0);
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  // Buckets are stable and spread evenly: about half of 2000 devices fall under 50 %.
  const buckets = Array.from({ length: 2000 }, (_, i) => rolloutBucket("rel_x", "tenant", `fp-${i}`));
  assert.equal(rolloutBucket("rel_x", "tenant", "fp-1"), buckets[1]);
  const underHalf = buckets.filter((b) => b < 50).length;
  assert.ok(underHalf > 900 && underHalf < 1100, `rollout bucket spread: ${underHalf}/2000 under 50`);
  // The installer name carries the declared version as a delimited token (review: no replay of an
  // old signed installer under a new version).
  const { fileNameCarriesVersion } = manifest;
  for (const ok of ["Maintafox_1.2.3_x64-setup.exe", "1.2.3_x64-setup.exe", "Maintafox_1.2.3"]) {
    assert.equal(fileNameCarriesVersion(ok, "1.2.3"), true, ok);
  }
  for (const bad of ["Maintafox_11.2.3_x64-setup.exe", "Maintafox_1.2.30_x64-setup.exe", "Maintafox_1.2.3.1_x64-setup.exe", "Maintafox_1x2x3_x64-setup.exe", "Maintafox_1.0.0_x64-setup.exe", "Maintafox1.2.3_x64-setup.exe", "Maintafox_1.2.3.exe", "Maintafox_1.2.3-dev_x64-setup.exe", "Maintafox-1.2.3-x64.msi"]) {
    assert.equal(fileNameCarriesVersion(bad, "1.2.3"), false, bad);
  }
  // The real `tauri signer` vector verifies; a changed file does not.
  const key = minisign.parseUpdaterPublicKey(TAURI_VECTOR.publicKey);
  assert.deepEqual(minisign.verifyUpdaterSignature(key, TAURI_VECTOR.signature, minisign.blake2b512(TAURI_VECTOR.file), null), { ok: true });
  assert.equal(minisign.verifyUpdaterSignature(key, TAURI_VECTOR.signature, minisign.blake2b512(Buffer.from("x")), null).ok, false);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const updater = testUpdaterKey();
const otherKey = testUpdaterKey();

const api = await startControlApi({
  port: 33247,
  extraEnv: {
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: accessKey,
    S3_SECRET_KEY: secretKey,
    S3_BUCKET: `mfx-releases-${randomBytes(3).toString("hex")}`,
    S3_FORCE_PATH_STYLE: "true",
    DEPLOYMENT_ENV: "ci",
    RELEASE_UPDATER_PUBLIC_KEY: updater.publicKeyBase64,
  },
});
try {
  const admin = await api.adminToken();
  const privileged = async (kind, reason = "release integration check") => ({
    "X-Operator-Reason": reason,
    "X-Step-Up-Token": await api.stepUpToken(admin, kind),
  });
  const audited = async (code) => (await api.su("SELECT count(*)::int AS n FROM audit_records WHERE action_code = $1", [code]))[0].n;

  // ── CI publisher key ───────────────────────────────────────────────────────────────────────
  assert.equal((await api.call("POST", "/api/v1/release-uploads", null, {})).status, 401);
  assert.equal((await api.call("POST", "/api/v1/release-uploads", admin, {})).status, 401, "an operator token is not a publisher key");
  assert.equal((await api.call("POST", "/api/v1/release-publisher-keys", admin, { label: "GitHub Actions" })).status, 403, "step-up required");
  const wrongKindKey = await api.call("POST", "/api/v1/release-publisher-keys", admin, { label: "GitHub Actions" }, await privileged("rollout_publish"));
  assert.equal(wrongKindKey.json.reason, "step_up_action_kind_mismatch");
  const created = await api.call("POST", "/api/v1/release-publisher-keys", admin, { label: "GitHub Actions" }, await privileged("release_publisher_key"));
  assert.equal(created.status, 201, created.text);
  const publisher = created.json.token;
  assert.match(publisher, /^mfxrp_/);
  const [stored] = await api.su("SELECT token_sha256 FROM release_publisher_keys WHERE key_id = $1", [created.json.key_id]);
  assert.equal(stored.token_sha256, sha256(publisher), "only the token's SHA-256 is stored");
  assert.equal((await api.call("GET", "/api/v1/release-publisher-keys", admin)).json[0].token, undefined, "the token is never listed");

  // ── Upload and registration ────────────────────────────────────────────────────────────────
  const installers = {};
  const declare = (version, bytes, { signature, fileName = `Maintafox_${version}_x64-setup.exe` } = {}) =>
    api.call("POST", "/api/v1/release-uploads", publisher, {
      version,
      notes_en: `Maintafox ${version}: fixes and improvements.`,
      notes_fr: `Maintafox ${version} : corrections et améliorations.`,
      git_commit: "0123456789abcdef0123456789abcdef01234567",
      code_signed: false,
      artifacts: [
        {
          target: "windows",
          arch: "x86_64",
          file_name: fileName,
          byte_size: bytes.length,
          sha256: sha256(bytes),
          updater_signature: signature ?? updater.sign(bytes, fileName),
        },
      ],
    });
  const put = async (url, bytes) => {
    const res = await fetch(url, { method: "PUT", body: bytes });
    assert.ok(res.ok, `presigned PUT failed: ${res.status} ${await res.text()}`);
  };
  const complete = (releaseId, token = publisher) => api.call("POST", `/api/v1/release-uploads/${releaseId}/complete`, token, {});
  async function register(version) {
    const bytes = Buffer.concat([Buffer.from(`MZ fake installer ${version} `), randomBytes(2048)]);
    const d = await declare(version, bytes);
    assert.equal(d.status, 201, d.text);
    await put(d.json.uploads[0].url, bytes);
    const c = await complete(d.json.release_id);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.state, "registered");
    assert.equal(c.json.channel, null, "a registered release is a draft");
    assert.equal(d.json.uploads[0].expires_in_seconds, 900, "upload URLs live 15 minutes");
    installers[version] = { bytes, releaseId: d.json.release_id, uploadUrl: d.json.uploads[0].url };
    return d.json.release_id;
  }

  assert.equal((await declare("1.0", Buffer.from("x"))).status, 400, "versions are x.y.z");
  // Replay: an old signed installer (its .sig names Maintafox_1.0.0_...) declared as 9.9.9.
  for (const fileName of ["Maintafox_1.0.0_x64-setup.exe", "Maintafox_19.9.9_x64-setup.exe", "Maintafox_9.9.90_x64-setup.exe", "Maintafox_9.9.9-dev_x64-setup.exe"]) {
    const replay = await declare("9.9.9", Buffer.from("old installer"), { fileName });
    assert.equal(replay.status, 400, `${fileName}: ${replay.text}`);
    assert.equal(replay.json.error, "file_name_version_mismatch");
  }
  // Checked again at complete (a row that does not carry its version never registers).
  {
    const bytes = Buffer.from("installer 0.9.6");
    const d = await declare("0.9.6", bytes, { fileName: "Maintafox_0.9.6_x64-setup.exe" });
    assert.equal(d.status, 201, d.text);
    await put(d.json.uploads[0].url, bytes);
    await api.su("UPDATE app_release_artifacts SET file_name = 'Maintafox_1.0.0_x64-setup.exe' WHERE release_id = $1", [d.json.release_id]);
    const c = await complete(d.json.release_id);
    assert.deepEqual([c.status, c.json.error], [422, "file_name_version_mismatch"], c.text);
  }
  // Declared but never uploaded.
  const pending = await declare("0.9.0", Buffer.from("pending"));
  assert.equal(pending.status, 201, pending.text);
  assert.equal((await complete(pending.json.release_id)).json.error, "artifact_not_uploaded");
  // Uploaded bytes differ from the declaration.
  await put(pending.json.uploads[0].url, Buffer.from("something else"));
  assert.equal((await complete(pending.json.release_id)).json.error, "artifact_verification_failed");
  // Signed with another key: refused before any device could fail on it.
  const foreign = Buffer.from("signed by someone else");
  const bad = await declare("0.9.0", foreign, { signature: otherKey.sign(foreign) });
  assert.equal(bad.status, 201, "a re-run replaces a declaration still uploading");
  assert.equal(bad.json.release_id, pending.json.release_id);
  await put(bad.json.uploads[0].url, foreign);
  const refused = await complete(bad.json.release_id);
  assert.equal(refused.status, 422);
  assert.equal(refused.json.error, "updater_signature_invalid");
  assert.equal(refused.json.reason, "key_mismatch");
  // Signed with the right key but for another file (review S3): the trusted comment's file name
  // must be the declared installer's.
  const renamed = Buffer.from("installer signed under another name");
  const otherName = await declare("0.9.0", renamed, { signature: updater.sign(renamed, "Maintafox_9.9.9_x64-setup.exe") });
  await put(otherName.json.uploads[0].url, renamed);
  const misnamed = await complete(otherName.json.release_id);
  assert.equal(misnamed.status, 422, misnamed.text);
  assert.deepEqual([misnamed.json.error, misnamed.json.signed_file_name], ["updater_signature_file_mismatch", "Maintafox_9.9.9_x64-setup.exe"]);

  // Race (review S1): a re-declaration lands between the verification and the registration. The
  // test holds the version lock the API takes for its final step, changes the declaration the way
  // a re-run of the workflow does, then lets the API go on: nothing may be registered.
  {
    const bytes = Buffer.concat([Buffer.from("MZ race 0.9.5 "), randomBytes(512)]);
    const d = await declare("0.9.5", bytes);
    assert.equal(d.status, 201, d.text);
    await put(d.json.uploads[0].url, bytes);
    const locker = new pg.Client({ connectionString: api.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["release-version:0.9.5"]);
      const completing = complete(d.json.release_id);
      let waiting = false;
      for (let i = 0; i < 400 && !waiting; i += 1) {
        const { rows } = await locker.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        waiting = rows[0].n > 0;
        if (!waiting) await sleep(25);
      }
      assert.ok(waiting, "complete verified the upload and waits for the version lock");
      const other = Buffer.from("re-declared installer");
      await locker.query(
        "UPDATE app_release_artifacts SET byte_size = $1, sha256 = $2, updater_signature = $3 WHERE release_id = $4",
        [other.length, sha256(other), updater.sign(other, "Maintafox_0.9.5_x64-setup.exe"), d.json.release_id],
      );
      await locker.query("COMMIT");
      const raced = await completing;
      assert.equal(raced.status, 409, raced.text);
      assert.equal(raced.json.error, "release_changed_during_verification");
    } finally {
      await locker.end();
    }
    const [row] = await api.su("SELECT r.state, a.verified_at, a.object_key FROM app_releases r JOIN app_release_artifacts a USING (release_id) WHERE r.release_id = $1", [d.json.release_id]);
    assert.deepEqual([row.state, row.verified_at, row.object_key], ["uploading", null, null], "nothing registered from the stale verification");
  }

  const r100 = await register("1.0.0");
  const r110 = await register("1.1.0");
  const r120 = await register("1.2.0");
  assert.equal((await declare("1.0.0", Buffer.from("again"))).json.error, "release_version_exists");
  assert.equal(await audited("release_registered"), 3);

  // ── Devices on three rings ─────────────────────────────────────────────────────────────────
  const tenant = (await api.call("POST", "/api/v1/tenants", admin, { slug: "updates", display_name: "Updates", rollout_cohort: "main", update_channel: "stable" })).json;
  const devices = {};
  for (const channel of ["internal", "pilot", "stable"]) {
    const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: tenant.id, max_machines: 3, update_channel: channel });
    assert.equal(l.status, 201, l.text);
    devices[channel] = await api.claimDevice(l.json.license_key, `fp-${channel}-1`);
  }
  const check = (token, version, headers = {}) => api.call("GET", `/api/v1/updates/windows/x86_64/${version}`, token, undefined, headers);

  assert.equal((await check(null, "1.0.0")).status, 401);
  assert.equal((await check(admin, "1.0.0")).status, 401, "operator tokens are not device tokens");
  assert.equal((await check(devices.stable, "not-a-version")).status, 400);
  assert.equal((await check(devices.internal, "0.4.0-dev")).status, 204, "drafts are offered to nobody");

  // ── Publish to internal ───────────────────────────────────────────────────────────────────
  const publish = (releaseId, body, kind = "rollout_publish") =>
    privileged(kind).then((h) => api.call("POST", `/api/v1/releases/${releaseId}/publish`, admin, body, h));
  assert.equal((await api.call("POST", `/api/v1/releases/${r100}/publish`, admin, { channel: "internal", rollout_percent: 100 })).status, 403);
  const pub = await publish(r100, { channel: "internal", rollout_percent: 100 });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.channel, "internal");
  assert.ok(pub.json.published_at);

  const offer = await check(devices.internal, "0.4.0-dev");
  assert.equal(offer.status, 200, offer.text);
  assert.equal(offer.json.version, "1.0.0");
  assert.equal(offer.json.maintafox.kind, "upgrade");
  assert.equal(offer.json.maintafox.mandatory, false);
  assert.equal(offer.json.maintafox.release_id, r100);
  assert.equal(offer.json.maintafox.mandatory_reason, null);
  assert.equal(offer.json.maintafox.min_version, null);
  assert.equal(offer.json.notes, "Maintafox 1.0.0: fixes and improvements.");
  assert.equal((await check(devices.internal, "0.4.0-dev", { "Accept-Language": "fr-FR" })).json.notes, "Maintafox 1.0.0 : corrections et améliorations.");
  // The download is the exact signed installer, and the manifest signature verifies it.
  const downloaded = Buffer.from(await (await fetch(offer.json.url)).arrayBuffer());
  assert.equal(sha256(downloaded), sha256(installers["1.0.0"].bytes));
  const sigCheck = minisign.verifyUpdaterSignature(
    minisign.parseUpdaterPublicKey(updater.publicKeyBase64),
    offer.json.signature,
    minisign.blake2b512(downloaded),
    null,
  );
  assert.deepEqual(sigCheck, { ok: true }, "the manifest signature verifies the downloaded file");
  // Review S2: devices download the server-only verified copy; a PUT to the (still valid) upload
  // URL after registration changes nothing they get.
  assert.match(new URL(offer.json.url).pathname, /\/ci\/release-artifacts\/1\.0\.0\//, "served from the server-only prefix");
  await put(installers["1.0.0"].uploadUrl, Buffer.from("EVIL replaced after verification"));
  const again = await check(devices.internal, "0.4.0-dev");
  const redownloaded = Buffer.from(await (await fetch(again.json.url)).arrayBuffer());
  assert.equal(sha256(redownloaded), sha256(installers["1.0.0"].bytes), "an overwrite of the upload key is never served");
  assert.equal((await check(devices.pilot, "0.4.0-dev")).status, 204, "pilot does not see an internal release");
  assert.equal((await check(devices.stable, "0.4.0-dev")).status, 204);
  assert.equal((await check(devices.internal, "1.0.0")).status, 204, "up to date");
  assert.equal((await check(devices.internal, "1.0.0", { "X-Maintafox-Rollback-To": "1.x" })).status, 400);

  // ── Widen to stable at 0 %: inner rings get it, stable devices wait ───────────────────────
  assert.equal((await publish(r100, { channel: "stable", rollout_percent: 0 })).status, 200);
  assert.equal((await check(devices.pilot, "0.4.0-dev")).json.version, "1.0.0", "inner rings get a stable release in full");
  assert.equal((await check(devices.stable, "0.4.0-dev")).status, 204, "0 % of the stable ring");
  assert.equal((await publish(r100, { channel: "pilot", rollout_percent: 100 })).json.error, "channel_narrowing_refused");
  assert.equal((await publish(r100, { channel: "stable", rollout_percent: 0 })).json.error, "release_unchanged");

  // ── Floor: a required minimum version makes the offer mandatory and skips the percentage ─
  const floor = await api.call(
    "PUT",
    `/api/v1/tenants/${tenant.id}/update-policy`,
    admin,
    { force_min_app_version: "1.0.0", force_update_mode: "required", force_update_reason: "Security fix" },
    await privileged("rollout_publish"),
  );
  assert.equal(floor.status, 200, floor.text);
  const forced = await check(devices.stable, "0.4.0-dev");
  assert.equal(forced.status, 200, forced.text);
  assert.equal(forced.json.version, "1.0.0");
  assert.equal(forced.json.maintafox.mandatory, true);
  assert.equal(forced.json.maintafox.mandatory_reason, "forced_update_floor");
  assert.equal(forced.json.maintafox.min_version, "1.0.0");
  assert.equal(forced.json.maintafox.mandatory_message, "Security fix", "the operator's wording travels separately");

  // ── R4-S2: the manifest's mandatory flag is policy refresh's force_update_required ────────
  // Same tenant, same version string (URL segment = policy refresh app_version), one device.
  const agreeLicence = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: tenant.id, max_machines: 1, update_channel: "stable" });
  assert.equal(agreeLicence.status, 201, agreeLicence.text);
  let agreeToken = await api.claimDevice(agreeLicence.json.license_key, "fp-stable-agree");
  const setPolicy = async (body) => {
    const res = await api.call("PUT", `/api/v1/tenants/${tenant.id}/update-policy`, admin, body, await privileged("rollout_publish"));
    assert.equal(res.status, 200, res.text);
  };
  async function agree(version, expected) {
    const refresh = await api.call("POST", "/api/v1/activation/policy-refresh", agreeToken, { app_version: version });
    assert.equal(refresh.status, 200, refresh.text);
    agreeToken = refresh.json.activation_token ?? agreeToken;
    const required = refresh.json.force_update_required;
    assert.equal(required, expected.required, `policy refresh force_update_required for ${JSON.stringify(version)}`);
    const m = await check(agreeToken, encodeURIComponent(version));
    const label = `manifest for ${JSON.stringify(version)} (${refresh.json.force_update_mode}, floor ${refresh.json.force_min_app_version})`;
    assert.equal(m.status, expected.status, `${label}: ${m.text}`);
    if (m.status === 400) {
      // A version the shared check cannot read is blocked by policy refresh and refused here:
      // never a 204 "up to date".
      assert.equal(required, true, `${label}: an unreadable version is never fine`);
      return;
    }
    if (m.status === 204) {
      assert.ok(!required || expected.nothingNewer, `${label}: a blocked PC is only told "nothing" when no newer release exists`);
      return;
    }
    const ext = m.json.maintafox;
    assert.equal(typeof ext.release_id, "string", `${label}: release_id on every 200`);
    assert.ok(ext.release_id.length > 0);
    assert.equal(ext.mandatory, required, `${label}: mandatory === force_update_required`);
    assert.equal(ext.mandatory_reason, expected.reason ?? null, label);
    assert.equal(ext.min_version, expected.min ?? null, label);
  }
  // Valid versions against floor 1.0.0 (1.0.0 is on stable at 0 %: only the floor can offer it).
  await agree("0.9.0", { required: true, status: 200, reason: "forced_update_floor", min: "1.0.0" });
  await agree("1.0.0", { required: false, status: 204 });
  await agree("1.0.1", { required: false, status: 204 });
  // Pre-release of the floor is below it (both sides).
  await agree("1.0.0-dev", { required: true, status: 200, reason: "forced_update_floor", min: "1.0.0" });
  await agree("0.4.0-dev", { required: true, status: 200, reason: "forced_update_floor", min: "1.0.0" });
  // Invalid for the strict check: blocked by policy refresh, refused by the manifest.
  for (const bogus of ["1.0", "abc", "v1.0.0", "1.0.0+build.7", "01.0.0", "1.0.0garbage"]) {
    await agree(bogus, { required: true, status: 400 });
  }
  // Operator floor written loosely ("1.0" means 1.0.0) on both sides.
  await setPolicy({ force_min_app_version: "1.0", force_update_mode: "required", force_update_reason: "Security fix" });
  await agree("1.0.0", { required: false, status: 204 });
  await agree("0.9.9", { required: true, status: 200, reason: "forced_update_floor", min: "1.0" });
  // Emergency: always required, whatever the version; offered whenever something newer exists.
  await setPolicy({ force_update_mode: "emergency", force_update_reason: "Incident" });
  await agree("0.9.0", { required: true, status: 200, reason: "emergency", min: "1.0" });
  await agree("1.0.0", { required: true, status: 204, nothingNewer: true });
  // "required" may not lose its floor (#10): the removal route refuses, the PUT keeps it.
  await setPolicy({ force_update_mode: "required" });
  const removeUnderRequired = await api.call(
    "POST",
    `/api/v1/tenants/${tenant.id}/update-policy/clear-min-version`,
    admin,
    { expected_force_min_app_version: "1.0" },
    await privileged("rollout_publish"),
  );
  assert.equal(removeUnderRequired.status, 409, removeUnderRequired.text);
  // No floor: mode off, then the floor removed. Nothing is mandatory; the 0 % rollout applies.
  await setPolicy({ force_update_mode: "off" });
  const removed = await api.call(
    "POST",
    `/api/v1/tenants/${tenant.id}/update-policy/clear-min-version`,
    admin,
    { expected_force_min_app_version: "1.0" },
    await privileged("rollout_publish"),
  );
  assert.equal(removed.status, 200, removed.text);
  await agree("0.9.0", { required: false, status: 204 });
  await agree("0.4.0-dev", { required: false, status: 204 });
  // A legacy row "required" with no floor (cannot be written through the API any more) blocks
  // every PC on both sides; the manifest offers the update as mandatory with min_version null.
  await api.su("UPDATE tenants SET force_update_mode = 'required', force_min_app_version = NULL WHERE id = $1", [tenant.id]);
  await agree("0.9.0", { required: true, status: 200, reason: "forced_update_floor", min: null });
  await agree("5.0.0", { required: true, status: 204, nothingNewer: true });
  await api.su("UPDATE tenants SET force_update_mode = 'off' WHERE id = $1", [tenant.id]);

  assert.equal((await check(devices.stable, "0.4.0-dev")).status, 204, "floor lifted: back to the 0 % rollout");
  assert.equal((await publish(r100, { channel: "stable", rollout_percent: 100 })).status, 200);
  assert.equal((await check(devices.stable, "0.4.0-dev")).json.version, "1.0.0");

  // ── Newer releases on internal; pause; recall; rollback ───────────────────────────────────
  assert.equal((await publish(r110, { channel: "internal", rollout_percent: 100 })).status, 200);
  assert.equal((await check(devices.internal, "1.0.0")).json.version, "1.1.0");
  assert.equal((await check(devices.stable, "1.0.0")).status, 204);

  const pause = await api.call("POST", "/api/v1/rollouts/internal/main/pause", admin, { reason: "crash reports" }, await privileged("rollout_publish"));
  assert.equal(pause.status, 200, pause.text);
  assert.equal((await check(devices.internal, "1.0.0")).status, 204, "a paused cohort is offered nothing");
  // A desktop whose migration failed asks for the version it came from, even while paused.
  const rollbackOffer = await check(devices.internal, "1.1.0", { "X-Maintafox-Rollback-To": "1.0.0" });
  assert.equal(rollbackOffer.status, 200, rollbackOffer.text);
  assert.equal(rollbackOffer.json.version, "1.0.0");
  assert.equal(rollbackOffer.json.maintafox.kind, "rollback");
  assert.equal(rollbackOffer.json.maintafox.release_id, r100);
  assert.equal(rollbackOffer.json.maintafox.mandatory_reason, "rollback_requested");
  assert.equal(rollbackOffer.json.maintafox.min_version, null);
  const forward = await check(devices.internal, "1.1.0", { "X-Maintafox-Rollback-To": "1.2.0" });
  assert.equal(forward.status, 409, "a rollback goes back, never forward");
  assert.equal(forward.json.error, "rollback_target_not_allowed");
  assert.equal(forward.json.allowed_version, "1.0.0");
  await api.call("POST", "/api/v1/rollouts/internal/main/resume", admin, { reason: "fixed" }, await privileged("rollout_publish"));

  // Catalog recall: never offered again; devices running it go back to the previous release.
  const recallWrongKind = await api.call("POST", `/api/v1/releases/${r110}/recall`, admin, { reason: "data loss bug" }, await privileged("rollout_publish"));
  assert.equal(recallWrongKind.json.reason, "step_up_action_kind_mismatch");
  const recall = await api.call("POST", `/api/v1/releases/${r110}/recall`, admin, { reason: "data loss bug" }, await privileged("forced_rollback"));
  assert.equal(recall.status, 200, recall.text);
  assert.ok(recall.json.recalled_at);
  assert.equal((await check(devices.internal, "1.0.0")).status, 204, "a recalled release is not offered");
  const back = await check(devices.internal, "1.1.0");
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.version, "1.0.0");
  assert.equal(back.json.maintafox.kind, "rollback");
  assert.equal(back.json.maintafox.mandatory, true);
  assert.equal(back.json.maintafox.release_id, r100);
  assert.equal(back.json.maintafox.mandatory_reason, "recalled_version");
  assert.equal(back.json.maintafox.min_version, null);
  assert.equal((await publish(r110, { channel: "stable", rollout_percent: 100 })).json.error, "release_recalled");

  // Cohort recall (Phase 4.2) of a version withdraws it for that cohort only.
  assert.equal((await publish(r120, { channel: "internal", rollout_percent: 100 })).status, 200);
  assert.equal((await check(devices.internal, "1.0.0")).json.version, "1.2.0");
  const cohortRecall = await api.call(
    "POST",
    "/api/v1/rollouts/internal/main/recall",
    admin,
    { reason: "bad on this cohort", recalled_version: "1.2.0" },
    await privileged("forced_rollback"),
  );
  assert.equal(cohortRecall.status, 200, cohortRecall.text);
  assert.equal((await check(devices.internal, "1.0.0")).status, 204);
  assert.equal((await check(devices.internal, "1.2.0")).json.version, "1.0.0", "devices on the recalled version go back");

  // ── Console views, notes, audit, rollout overview ─────────────────────────────────────────
  const list = (await api.call("GET", "/api/v1/releases", admin)).json;
  assert.deepEqual(
    list.filter((r) => r.state === "registered").map((r) => r.version).sort(),
    ["1.0.0", "1.1.0", "1.2.0"],
  );
  const listed100 = list.find((r) => r.version === "1.0.0");
  assert.equal(listed100.artifacts[0].byte_size, installers["1.0.0"].bytes.length);
  assert.ok(listed100.artifacts[0].verified_at);
  const notes = await api.call("PATCH", `/api/v1/releases/${r100}/notes`, admin, { notes_en: "Better notes", notes_fr: "Meilleures notes" });
  assert.equal(notes.status, 200, notes.text);
  assert.equal((await check(devices.stable, "0.4.0-dev")).json.notes, "Better notes");
  for (const code of ["release_upload_declared", "release_registered", "release_publish", "release_recall", "release_notes_edited", "release_publisher_key_create"]) {
    assert.ok((await audited(code)) > 0, `audit ${code}`);
  }
  const [publishAudit] = await api.su(
    "SELECT action_category, entity_refs_json FROM audit_records WHERE action_code = 'release_publish' ORDER BY sequence LIMIT 1",
  );
  assert.equal(publishAudit.action_category, "release");
  assert.match(String(publishAudit.entity_refs_json), new RegExp(r100), "the audit row names the real release id");
  // Rollout overview: the newest published release not recalled in the catalog (1.2.0 is only
  // recalled for one cohort).
  const overview = (await api.call("GET", "/api/v1/ops/rollout-overview", admin)).json;
  assert.equal(overview.impact.release_id, r120);
  assert.equal(overview.impact.release_version, "1.2.0");

  // ── Rollback gate (review B1): ring, recall and forced-update floor apply to rollbacks too ──
  // The desktop installs whatever version the server offers, so the server is the only gate.
  // Catalog now: 1.0.0 stable 100 %, 1.1.0 recalled, 1.2.0 internal (recalled for internal/main),
  // + 1.3.0 internal only, + 1.4.0 stable then recalled.
  const r130 = await register("1.3.0");
  assert.equal((await publish(r130, { channel: "internal", rollout_percent: 100 })).status, 200);
  const rollbackTo = (token, current, target) => check(token, current, { "X-Maintafox-Rollback-To": target });
  const setTenantPolicy = async (body) => {
    const res = await api.call("PUT", `/api/v1/tenants/${tenant.id}/update-policy`, admin, body, await privileged("rollout_publish"));
    assert.equal(res.status, 200, res.text);
  };
  {
    // Ring escape: a stable PC may not "roll back" to a build published to internal only.
    const escape = await rollbackTo(devices.stable, "1.4.0", "1.3.0");
    assert.equal(escape.status, 409, escape.text);
    assert.deepEqual([escape.json.error, escape.json.requested_version, escape.json.allowed_version], ["rollback_target_not_allowed", "1.3.0", "1.0.0"]);
    // The previous release the PC may run is allowed.
    const allowed = await rollbackTo(devices.stable, "1.4.0", "1.0.0");
    assert.equal(allowed.status, 200, allowed.text);
    assert.deepEqual([allowed.json.version, allowed.json.maintafox.kind, allowed.json.maintafox.release_id], ["1.0.0", "rollback", r100]);
    // Only the immediately previous eligible release: an older one is refused, never swapped.
    const skip = await rollbackTo(devices.internal, "1.4.0", "1.0.0");
    assert.equal(skip.status, 409, skip.text);
    assert.equal(skip.json.allowed_version, "1.3.0", "1.2.0 (cohort recall) and 1.1.0 (recall) are skipped");
    assert.equal((await rollbackTo(devices.internal, "1.4.0", "1.3.0")).json.version, "1.3.0");
    // Below the floor: policy refresh would block 1.3.0, so the manifest refuses to go there.
    await setTenantPolicy({ force_min_app_version: "1.3.1", force_update_mode: "required", force_update_reason: "Security fix" });
    const belowFloor = await rollbackTo(devices.internal, "1.4.0", "1.3.0");
    assert.equal(belowFloor.status, 409, belowFloor.text);
    assert.equal(belowFloor.json.allowed_version, null);
    assert.equal((await rollbackTo(devices.stable, "1.4.0", "1.0.0")).status, 409);
    // Emergency: every version requires an update, so no rollback at all.
    await setTenantPolicy({ force_update_mode: "emergency" });
    assert.equal((await rollbackTo(devices.internal, "1.4.0", "1.3.0")).status, 409);
    assert.equal((await rollbackTo(devices.stable, "1.4.0", "1.0.0")).status, 409);
    await setTenantPolicy({ force_update_mode: "off" });

    // Recalled-version fallback: same rules.
    const r140 = await register("1.4.0");
    assert.equal((await publish(r140, { channel: "stable", rollout_percent: 100 })).status, 200);
    assert.equal((await api.call("POST", `/api/v1/releases/${r140}/recall`, admin, { reason: "broken build" }, await privileged("forced_rollback"))).status, 200);
    const stableBack = await check(devices.stable, "1.4.0");
    assert.equal(stableBack.status, 200, stableBack.text);
    assert.deepEqual(
      [stableBack.json.version, stableBack.json.maintafox.kind, stableBack.json.maintafox.mandatory_reason],
      ["1.0.0", "rollback", "recalled_version"],
      "a stable PC skips the internal-only 1.3.0",
    );
    assert.equal((await check(devices.internal, "1.4.0")).json.version, "1.3.0");
    await setTenantPolicy({ force_min_app_version: "1.3.1", force_update_mode: "required", force_update_reason: "Security fix" });
    // Everything below the recalled 1.4.0 is under the floor: nothing to go to (stay; policy refresh
    // keeps judging 1.4.0 on its own; the operator must publish a fixed release).
    assert.equal((await check(devices.internal, "1.4.0")).status, 204, "below-floor fallbacks are skipped");
    assert.equal((await check(devices.stable, "1.4.0")).status, 204);
    await setTenantPolicy({ force_min_app_version: "1.0.0", force_update_mode: "required" });
    const aboveFloor = await check(devices.stable, "1.4.0");
    assert.deepEqual([aboveFloor.status, aboveFloor.json?.version], [200, "1.0.0"], "a fallback that meets the floor is offered");
    await setTenantPolicy({ force_update_mode: "emergency" });
    assert.equal((await check(devices.stable, "1.4.0")).status, 204, "no fallback under emergency");
    await setTenantPolicy({ force_update_mode: "off" });
  }

  // ── Device gate (review N4): no manifest for a revoked activation, revoked licence or a
  //    suspended customer ─────────────────────────────────────────────────────────────────────
  {
    const gate = (await api.call("POST", "/api/v1/tenants", admin, { slug: "updates-gate", display_name: "Updates gate", rollout_cohort: "main", update_channel: "stable" })).json;
    const issue = async () => {
      const l = await api.call("POST", "/api/v1/licenses", admin, { tenant_id: gate.id, max_machines: 2, update_channel: "stable" });
      assert.equal(l.status, 201, l.text);
      return l.json;
    };
    const machineLicence = await issue();
    const machineToken = await api.claimDevice(machineLicence.license_key, "fp-gate-machine");
    const licenceLicence = await issue();
    const licenceToken = await api.claimDevice(licenceLicence.license_key, "fp-gate-licence");
    for (const token of [machineToken, licenceToken]) {
      assert.equal((await check(token, "0.4.0-dev")).status, 200, "served before the refusal");
    }
    const machineRevoked = await api.call(
      "POST",
      `/api/v1/tenants/${gate.id}/machines/fp-gate-machine/revoke`,
      admin,
      { reason: "stolen laptop" },
      await privileged("machine_trust_change"),
    );
    assert.equal(machineRevoked.status, 200, machineRevoked.text);
    const afterMachine = await check(machineToken, "0.4.0-dev");
    assert.deepEqual([afterMachine.status, afterMachine.json?.error], [403, "activation_revoked"]);
    const licenceRevoked = await api.call("POST", `/api/v1/licenses/${licenceLicence.id}/revoke`, admin, { reason: "contract ended" }, await privileged("entitlement_suspension"));
    assert.equal(licenceRevoked.status, 200, licenceRevoked.text);
    const afterLicence = await check(licenceToken, "0.4.0-dev");
    assert.deepEqual([afterLicence.status, afterLicence.json?.error], [403, "license_revoked"]);
    const tenantLicence = await issue();
    const tenantToken = await api.claimDevice(tenantLicence.license_key, "fp-gate-tenant");
    assert.equal((await check(tenantToken, "0.4.0-dev")).status, 200);
    const suspended = await api.call("POST", `/api/v1/tenants/${gate.id}/suspend`, admin, { reason: "unpaid invoices" }, await privileged("entitlement_suspension"));
    assert.equal(suspended.status, 200, suspended.text);
    const afterSuspend = await check(tenantToken, "0.4.0-dev");
    assert.deepEqual([afterSuspend.status, afterSuspend.json?.error], [403, "tenant_inactive"]);
  }

  // ── Revoked publisher key ─────────────────────────────────────────────────────────────────
  const revoked = await api.call("POST", `/api/v1/release-publisher-keys/${created.json.key_id}/revoke`, admin, {}, await privileged("release_publisher_key"));
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal((await declare("2.0.0", Buffer.from("x"))).status, 401);

  const [rls] = await api.su("SELECT relrowsecurity FROM pg_class WHERE relname = 'app_releases'");
  assert.equal(rls.relrowsecurity, true, "the catalog is operator-only; devices read it through mfx_update_candidates");
  console.log("update-manifest: all checks passed");
} catch (err) {
  console.error(api.output());
  throw err;
} finally {
  await api.stop();
}

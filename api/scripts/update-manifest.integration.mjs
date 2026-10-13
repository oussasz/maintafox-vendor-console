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
  const declare = (version, bytes, { signature } = {}) =>
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
          file_name: `Maintafox_${version}_x64-setup.exe`,
          byte_size: bytes.length,
          sha256: sha256(bytes),
          updater_signature: signature ?? updater.sign(bytes, `Maintafox_${version}_x64-setup.exe`),
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
    installers[version] = { bytes, releaseId: d.json.release_id };
    return d.json.release_id;
  }

  assert.equal((await declare("1.0", Buffer.from("x"))).status, 400, "versions are x.y.z");
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
  assert.equal(forced.json.maintafox.mandatory_reason, "Security fix");
  assert.equal(forced.json.maintafox.min_version, "1.0.0");
  await api.call("PUT", `/api/v1/tenants/${tenant.id}/update-policy`, admin, { force_update_mode: "off" }, await privileged("rollout_publish"));
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
  assert.equal((await check(devices.internal, "1.1.0", { "X-Maintafox-Rollback-To": "1.2.0" })).status, 204, "a rollback goes back, never forward");
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

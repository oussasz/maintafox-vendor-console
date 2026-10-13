/**
 * Release catalog (master plan Phase 5.2 / 5.4).
 *
 * Release workflow (CI, publisher key `Authorization: Bearer mfxrp_...`):
 *   POST /api/v1/release-uploads                       declare version, notes, artifacts -> presigned PUTs
 *   POST /api/v1/release-uploads/:releaseId/complete   the server reads every object back: size,
 *        SHA-256 and the updater signature (RELEASE_UPDATER_PUBLIC_KEY) must match -> draft release
 * Console (operators):
 *   GET   /api/v1/releases                             catalog with artifacts
 *   PATCH /api/v1/releases/:releaseId/notes            release notes (audited)
 *   POST  /api/v1/releases/:releaseId/publish          ring + rollout % (step-up rollout_publish)
 *   POST  /api/v1/releases/:releaseId/recall           never offered again (step-up forced_rollback)
 *   GET/POST /api/v1/release-publisher-keys, POST .../:keyId/revoke  CI credentials (step-up release_publisher_key)
 * Devices read the published catalog through routes/updates.ts.
 */
import { randomBytes } from "node:crypto";

import type express from "express";
import { z } from "zod";

import type { ApiContext } from "../app/context.js";
import { RELEASE_UPDATER_PUBLIC_KEY } from "../app/config.js";
import { deviceRateLimiter, resolveActorId, sendValidationError } from "../app/http.js";
import { getMediaStore } from "../app/media.js";
import { newId, sha256Hex, structuredLog } from "../app/runtime.js";
import { openOperatorScope, runAsSystem } from "../app/scope.js";
import { verifyUpdaterSignature } from "../releases/minisign.js";
import { channelRank, RELEASE_VERSION_RE, UPDATE_CHANNELS, type UpdateChannel } from "../releases/update-manifest.js";
import { StepUpKinds } from "../vendor-auth/step-up-kinds.js";

/** Largest installer accepted (the NSIS installer is ~100 MB; this bounds the verification read). */
const RELEASE_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;
/** Validity of the presigned PUT handed to the release workflow. */
const RELEASE_UPLOAD_URL_TTL_SECONDS = 3600;
const PUBLISHER_TOKEN_PREFIX = "mfxrp_";

const ArtifactDeclaration = z
  .object({
    target: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    arch: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    file_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/),
    byte_size: z.number().int().positive().max(RELEASE_ARTIFACT_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    updater_signature: z.string().min(16).max(4096),
  })
  .strict();

const ReleaseDeclaration = z
  .object({
    version: z.string().regex(RELEASE_VERSION_RE),
    notes_en: z.string().trim().min(1).max(20000),
    notes_fr: z.string().trim().min(1).max(20000),
    git_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    code_signed: z.boolean(),
    artifacts: z
      .array(ArtifactDeclaration)
      .min(1)
      .max(8)
      .refine((list) => new Set(list.map((a) => `${a.target}/${a.arch}`)).size === list.length, {
        message: "one artifact per target/arch",
      }),
  })
  .strict();

const NotesBody = z.object({ notes_en: z.string().trim().min(1).max(20000), notes_fr: z.string().trim().min(1).max(20000) }).strict();
const PublishBody = z
  .object({ channel: z.enum(UPDATE_CHANNELS), rollout_percent: z.number().int().min(0).max(100) })
  .strict();
const RecallBody = z.object({ reason: z.string().trim().min(4).max(512) }).strict();
const PublisherKeyBody = z.object({ label: z.string().trim().min(2).max(80) }).strict();

type ReleaseRow = {
  release_id: string;
  version: string;
  state: "uploading" | "registered";
  notes_en: string;
  notes_fr: string;
  channel: UpdateChannel | null;
  rollout_percent: number;
  code_signed: boolean;
  git_commit: string;
  registered_by: string;
  registered_at: Date;
  published_at: Date | null;
  updated_at: Date;
  recalled_at: Date | null;
  recalled_reason: string | null;
  recalled_by: string | null;
};
type ArtifactRow = {
  release_id: string;
  target: string;
  arch: string;
  file_name: string;
  object_key: string;
  byte_size: string | number;
  sha256: string;
  updater_signature: string;
  verified_at: Date | null;
};

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function releaseView(r: ReleaseRow, artifacts: ArtifactRow[]) {
  return {
    release_id: r.release_id,
    version: r.version,
    state: r.state,
    notes_en: r.notes_en,
    notes_fr: r.notes_fr,
    channel: r.channel,
    rollout_percent: r.rollout_percent,
    code_signed: r.code_signed,
    git_commit: r.git_commit,
    registered_by: r.registered_by,
    registered_at: iso(r.registered_at),
    published_at: iso(r.published_at),
    updated_at: iso(r.updated_at),
    recalled_at: iso(r.recalled_at),
    recalled_reason: r.recalled_reason,
    recalled_by: r.recalled_by,
    artifacts: artifacts
      .filter((a) => a.release_id === r.release_id)
      .map((a) => ({
        target: a.target,
        arch: a.arch,
        file_name: a.file_name,
        byte_size: Number(a.byte_size),
        sha256: a.sha256,
        verified_at: iso(a.verified_at),
      })),
  };
}

type PublisherRequest = express.Request & { releasePublisherKeyId?: string };

export function registerReleaseCatalogRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, authMiddleware, runIdempotent, requirePrivilegedAction, appendAuditRecord } = ctx;

  /** Release workflow credential: a publisher key, never an operator or device token. */
  async function publisherAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token.startsWith(PUBLISHER_TOKEN_PREFIX)) {
      res.status(401).json({ error: "missing_publisher_token" });
      return;
    }
    const key = await runAsSystem(db, "release-publisher-auth", () =>
      db.get<{ key_id: string }>(
        "SELECT key_id FROM release_publisher_keys WHERE token_sha256 = ? AND revoked_at IS NULL",
        sha256Hex(token),
      ),
    );
    if (!key) {
      structuredLog("release_publisher_denied", { path: req.path });
      res.status(401).json({ error: "invalid_publisher_token" });
      return;
    }
    const scope = await openOperatorScope(db, `release_publisher:${key.key_id}`, { method: req.method, path: req.path });
    await db.runInScope(scope, () => db.run("UPDATE release_publisher_keys SET last_used_at = now() WHERE key_id = ?", key.key_id));
    (req as PublisherRequest).releasePublisherKeyId = key.key_id;
    db.runInScope(scope, next);
  }

  // ── Release workflow ─────────────────────────────────────────────────────────────────────
  app.post("/api/v1/release-uploads", deviceRateLimiter, publisherAuth, async (req, res) => {
    const parsed = ReleaseDeclaration.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    const input = parsed.data;
    const publisher = `release_publisher:${(req as PublisherRequest).releasePublisherKeyId}`;
    const result = await db.tx(async () => {
      await db.lockXact("release-version", input.version);
      const existing = await db.get<{ release_id: string; state: string }>(
        "SELECT release_id, state FROM app_releases WHERE version = ?",
        input.version,
      );
      if (existing?.state === "registered") return { conflict: true as const };
      // A re-run of the workflow for a version still uploading replaces the declaration.
      const releaseId = existing?.release_id ?? newId("rel");
      if (existing) {
        await db.run("DELETE FROM app_release_artifacts WHERE release_id = ?", releaseId);
        await db.run(
          `UPDATE app_releases SET notes_en = ?, notes_fr = ?, git_commit = ?, code_signed = ?, registered_by = ?, updated_at = now()
            WHERE release_id = ?`,
          input.notes_en,
          input.notes_fr,
          input.git_commit,
          input.code_signed,
          publisher,
          releaseId,
        );
      } else {
        await db.run(
          `INSERT INTO app_releases (release_id, version, state, notes_en, notes_fr, code_signed, git_commit, registered_by)
           VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?)`,
          releaseId,
          input.version,
          input.notes_en,
          input.notes_fr,
          input.code_signed,
          input.git_commit,
          publisher,
        );
      }
      const keys: { target: string; arch: string; objectKey: string }[] = [];
      for (const a of input.artifacts) {
        const objectKey = `${media.config.deploymentEnv}/releases/${input.version}/${releaseId}/${a.target}-${a.arch}/${a.file_name}`;
        await db.run(
          `INSERT INTO app_release_artifacts (release_id, target, arch, file_name, object_key, byte_size, sha256, updater_signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          releaseId,
          a.target,
          a.arch,
          a.file_name,
          objectKey,
          a.byte_size,
          a.sha256,
          a.updater_signature,
        );
        keys.push({ target: a.target, arch: a.arch, objectKey });
      }
      const auditRecordId = await appendAuditRecord({
        actor_id: publisher,
        action_code: "release_upload_declared",
        action_category: "release",
        correlation_id: newId("corr"),
        entity_refs: { release_id: releaseId },
        payload: { version: input.version, git_commit: input.git_commit, code_signed: input.code_signed, artifacts: input.artifacts.length },
      });
      return { conflict: false as const, releaseId, keys, auditRecordId };
    });
    if (result.conflict) {
      res.status(409).json({ error: "release_version_exists", message: `Version ${input.version} is already registered.` });
      return;
    }
    const uploads = [];
    for (const k of result.keys) {
      const put = await media.presignPut(k.objectKey, RELEASE_UPLOAD_URL_TTL_SECONDS);
      uploads.push({ target: k.target, arch: k.arch, method: put.method, url: put.url, expires_in_seconds: put.expires_in_seconds });
    }
    res.status(201).json({ release_id: result.releaseId, uploads, audit_record_id: result.auditRecordId });
  });

  app.post("/api/v1/release-uploads/:releaseId/complete", deviceRateLimiter, publisherAuth, async (req, res) => {
    const media = getMediaStore();
    if (!media) {
      res.status(503).json({ error: "object_storage_unavailable" });
      return;
    }
    if (!RELEASE_UPDATER_PUBLIC_KEY) {
      res.status(503).json({
        error: "updater_public_key_not_configured",
        message: "Set RELEASE_UPDATER_PUBLIC_KEY on the server (the desktop's updater public key).",
      });
      return;
    }
    const release = await db.get<ReleaseRow>("SELECT * FROM app_releases WHERE release_id = ?", req.params.releaseId);
    if (!release) {
      res.status(404).json({ error: "release_not_found" });
      return;
    }
    const artifacts = await db.all<ArtifactRow>("SELECT * FROM app_release_artifacts WHERE release_id = ?", release.release_id);
    if (release.state === "registered") {
      res.json(releaseView(release, artifacts));
      return;
    }
    for (const a of artifacts) {
      let digest;
      try {
        digest = await media.readObjectDigests(a.object_key, RELEASE_ARTIFACT_MAX_BYTES);
      } catch (err) {
        if (err instanceof Error && err.message === "object_too_large") {
          res.status(422).json({ error: "artifact_verification_failed", message: `${a.file_name} is larger than declared.` });
          return;
        }
        throw err;
      }
      if (!digest) {
        res.status(409).json({ error: "artifact_not_uploaded", message: `${a.file_name} was not uploaded to its presigned URL.` });
        return;
      }
      if (digest.byteSize !== Number(a.byte_size) || digest.sha256 !== a.sha256) {
        res.status(422).json({
          error: "artifact_verification_failed",
          message: `${a.file_name}: uploaded ${digest.byteSize} bytes / sha256 ${digest.sha256}, declared ${a.byte_size} / ${a.sha256}.`,
        });
        return;
      }
      const check = verifyUpdaterSignature(RELEASE_UPDATER_PUBLIC_KEY, a.updater_signature, digest.blake2b512, null);
      if (!check.ok) {
        structuredLog("release_signature_refused", { release_id: release.release_id, file: a.file_name, reason: check.reason });
        res.status(422).json({
          error: "updater_signature_invalid",
          reason: check.reason,
          message: `${a.file_name}: the updater signature does not verify with the server's updater public key (${check.reason}).`,
        });
        return;
      }
    }
    const publisher = `release_publisher:${(req as PublisherRequest).releasePublisherKeyId}`;
    await db.tx(async () => {
      await db.run("UPDATE app_release_artifacts SET verified_at = now() WHERE release_id = ?", release.release_id);
      await db.run("UPDATE app_releases SET state = 'registered', updated_at = now() WHERE release_id = ?", release.release_id);
      await appendAuditRecord({
        actor_id: publisher,
        action_code: "release_registered",
        action_category: "release",
        correlation_id: newId("corr"),
        entity_refs: { release_id: release.release_id },
        payload: { version: release.version, code_signed: release.code_signed, artifacts: artifacts.map((a) => `${a.target}/${a.arch}`) },
      });
    });
    structuredLog("release_registered", { release_id: release.release_id, version: release.version });
    const fresh = (await db.get<ReleaseRow>("SELECT * FROM app_releases WHERE release_id = ?", release.release_id))!;
    const freshArtifacts = await db.all<ArtifactRow>("SELECT * FROM app_release_artifacts WHERE release_id = ?", release.release_id);
    res.json(releaseView(fresh, freshArtifacts));
  });

  // ── Console ──────────────────────────────────────────────────────────────────────────────
  app.get("/api/v1/releases", authMiddleware, async (_req, res) => {
    const releases = await db.all<ReleaseRow>("SELECT * FROM app_releases ORDER BY registered_at DESC");
    const artifacts = await db.all<ArtifactRow>("SELECT * FROM app_release_artifacts ORDER BY target, arch");
    res.json(releases.map((r) => releaseView(r, artifacts)));
  });

  async function loadForUpdate(releaseId: string): Promise<ReleaseRow | undefined> {
    await db.lockXact("release", releaseId);
    return db.get<ReleaseRow>("SELECT * FROM app_releases WHERE release_id = ?", releaseId);
  }
  async function viewOf(releaseId: string, extra: Record<string, unknown> = {}) {
    const r = (await db.get<ReleaseRow>("SELECT * FROM app_releases WHERE release_id = ?", releaseId))!;
    const artifacts = await db.all<ArtifactRow>("SELECT * FROM app_release_artifacts WHERE release_id = ?", releaseId);
    return { ...releaseView(r, artifacts), ...extra };
  }

  app.patch("/api/v1/releases/:releaseId/notes", authMiddleware, async (req, res) => {
    const parsed = NotesBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const current = await loadForUpdate(req.params.releaseId);
      if (!current) return { status: 404, body: { error: "release_not_found" } };
      await db.run(
        "UPDATE app_releases SET notes_en = ?, notes_fr = ?, updated_at = now() WHERE release_id = ?",
        parsed.data.notes_en,
        parsed.data.notes_fr,
        current.release_id,
      );
      const auditRecordId = await appendAuditRecord({
        actor_id: resolveActorId(req),
        action_code: "release_notes_edited",
        action_category: "release",
        correlation_id: newId("corr"),
        entity_refs: { release_id: current.release_id },
        payload: { version: current.version, previous: { notes_en: current.notes_en, notes_fr: current.notes_fr }, next: parsed.data },
      });
      return { status: 200, body: await viewOf(current.release_id, { audit_record_id: auditRecordId }) };
    });
  });

  app.post("/api/v1/releases/:releaseId/publish", authMiddleware, async (req, res) => {
    const parsed = PublishBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const current = await loadForUpdate(req.params.releaseId);
      if (!current) return { status: 404, body: { error: "release_not_found" } };
      if (current.state !== "registered") return { status: 409, body: { error: "release_not_registered" } };
      if (current.recalled_at) return { status: 409, body: { error: "release_recalled" } };
      const next = parsed.data;
      // A ring is only ever widened: devices of an outer ring may already run the release, and
      // taking it back is a recall, not a narrowing.
      if (current.channel && channelRank(next.channel) < channelRank(current.channel)) {
        return { status: 409, body: { error: "channel_narrowing_refused", channel: current.channel } };
      }
      if (current.channel === next.channel && current.rollout_percent === next.rollout_percent) {
        return { status: 409, body: { error: "release_unchanged" } };
      }
      const guard = await requirePrivilegedAction(req, {
        action_code: "release_publish",
        action_category: "release",
        step_up_kind: StepUpKinds.rolloutPublish,
        entity_refs: { release_id: current.release_id },
        payload: {
          version: current.version,
          code_signed: current.code_signed,
          previous: { channel: current.channel, rollout_percent: current.rollout_percent },
          next,
        },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        `UPDATE app_releases SET channel = ?, rollout_percent = ?, published_at = COALESCE(published_at, now()), updated_at = now()
          WHERE release_id = ?`,
        next.channel,
        next.rollout_percent,
        current.release_id,
      );
      return { status: 200, body: await viewOf(current.release_id, { audit_record_id: guard.auditRecordId }) };
    });
  });

  app.post("/api/v1/releases/:releaseId/recall", authMiddleware, async (req, res) => {
    const parsed = RecallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const current = await loadForUpdate(req.params.releaseId);
      if (!current) return { status: 404, body: { error: "release_not_found" } };
      if (current.state !== "registered") return { status: 409, body: { error: "release_not_registered" } };
      if (current.recalled_at) return { status: 409, body: { error: "release_recalled" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "release_recall",
        action_category: "release",
        step_up_kind: StepUpKinds.forcedRollback,
        entity_refs: { release_id: current.release_id },
        payload: { version: current.version, channel: current.channel, reason: parsed.data.reason },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        "UPDATE app_releases SET recalled_at = now(), recalled_reason = ?, recalled_by = ?, updated_at = now() WHERE release_id = ?",
        parsed.data.reason,
        resolveActorId(req),
        current.release_id,
      );
      return { status: 200, body: await viewOf(current.release_id, { audit_record_id: guard.auditRecordId }) };
    });
  });

  // ── Release workflow credentials ─────────────────────────────────────────────────────────
  type KeyRow = {
    key_id: string;
    label: string;
    created_at: Date;
    created_by: string;
    last_used_at: Date | null;
    revoked_at: Date | null;
    revoked_by: string | null;
  };
  const keyView = (k: KeyRow) => ({
    key_id: k.key_id,
    label: k.label,
    created_at: iso(k.created_at),
    created_by: k.created_by,
    last_used_at: iso(k.last_used_at),
    revoked_at: iso(k.revoked_at),
    revoked_by: k.revoked_by,
  });
  const KEY_COLUMNS = "key_id, label, created_at, created_by, last_used_at, revoked_at, revoked_by";

  app.get("/api/v1/release-publisher-keys", authMiddleware, async (_req, res) => {
    const rows = await db.all<KeyRow>(`SELECT ${KEY_COLUMNS} FROM release_publisher_keys ORDER BY created_at DESC`);
    res.json(rows.map(keyView));
  });

  app.post("/api/v1/release-publisher-keys", authMiddleware, async (req, res) => {
    const parsed = PublisherKeyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    await runIdempotent(req, res, async () => {
      const guard = await requirePrivilegedAction(req, {
        action_code: "release_publisher_key_create",
        action_category: "release",
        step_up_kind: StepUpKinds.releasePublisherKey,
        payload: { label: parsed.data.label },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      const keyId = newId("rpk");
      const token = `${PUBLISHER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      await db.run(
        "INSERT INTO release_publisher_keys (key_id, label, token_sha256, created_by) VALUES (?, ?, ?, ?)",
        keyId,
        parsed.data.label,
        sha256Hex(token),
        resolveActorId(req),
      );
      const row = (await db.get<KeyRow>(`SELECT ${KEY_COLUMNS} FROM release_publisher_keys WHERE key_id = ?`, keyId))!;
      // Shown once: only its SHA-256 is stored.
      return { status: 201, body: { ...keyView(row), token, audit_record_id: guard.auditRecordId } };
    });
  });

  app.post("/api/v1/release-publisher-keys/:keyId/revoke", authMiddleware, async (req, res) => {
    await runIdempotent(req, res, async () => {
      const key = await db.get<KeyRow>(`SELECT ${KEY_COLUMNS} FROM release_publisher_keys WHERE key_id = ?`, req.params.keyId);
      if (!key) return { status: 404, body: { error: "publisher_key_not_found" } };
      if (key.revoked_at) return { status: 409, body: { error: "publisher_key_revoked" } };
      const guard = await requirePrivilegedAction(req, {
        action_code: "release_publisher_key_revoke",
        action_category: "release",
        step_up_kind: StepUpKinds.releasePublisherKey,
        payload: { key_id: key.key_id, label: key.label },
      });
      if (!guard.ok) return { status: guard.status, body: guard.body };
      await db.run(
        "UPDATE release_publisher_keys SET revoked_at = now(), revoked_by = ? WHERE key_id = ?",
        resolveActorId(req),
        key.key_id,
      );
      const row = (await db.get<KeyRow>(`SELECT ${KEY_COLUMNS} FROM release_publisher_keys WHERE key_id = ?`, key.key_id))!;
      return { status: 200, body: { ...keyView(row), audit_record_id: guard.auditRecordId } };
    });
  });
}

-- Release catalog and desktop update manifest (master plan Phase 5.3 / 5.4).
--
-- A release is registered by the release workflow (CI, with a publisher key) as a draft, then an
-- operator publishes it to a ring (internal < pilot < stable) with a rollout percentage, widens it,
-- or recalls it. Devices ask GET /api/v1/updates/... (routes/updates.ts), which resolves their
-- channel, cohort governance (migration 012), force-update floor and rollout bucket.

CREATE TABLE app_releases (
  release_id TEXT PRIMARY KEY,
  -- Strict x.y.z (the desktop's tauri.conf.json version of the build).
  version TEXT NOT NULL UNIQUE CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  -- 'uploading' until CI completes the upload and the server verified every artifact.
  state TEXT NOT NULL CHECK (state IN ('uploading', 'registered')),
  notes_en TEXT NOT NULL,
  notes_fr TEXT NOT NULL,
  -- Widest ring the release is published to; NULL = draft (offered to nobody).
  channel TEXT NULL CHECK (channel IN ('internal', 'pilot', 'stable')),
  -- Share of the devices of the widest ring that are offered the release (inner rings get it all).
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  -- Authenticode-signed by the release workflow (false while no code-signing certificate exists).
  code_signed BOOLEAN NOT NULL,
  git_commit TEXT NOT NULL CHECK (git_commit ~ '^[0-9a-f]{7,40}$'),
  registered_by TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A recalled release is never offered again (devices running it are moved to another release).
  recalled_at TIMESTAMPTZ NULL,
  recalled_reason TEXT NULL,
  recalled_by TEXT NULL,
  CHECK ((recalled_at IS NULL) = (recalled_reason IS NULL)),
  CHECK (channel IS NULL OR state = 'registered')
);

CREATE TABLE app_release_artifacts (
  release_id TEXT NOT NULL REFERENCES app_releases (release_id) ON DELETE CASCADE,
  -- Tauri updater {{target}} / {{arch}} (e.g. windows / x86_64).
  target TEXT NOT NULL CHECK (target ~ '^[a-z0-9_-]{1,32}$'),
  arch TEXT NOT NULL CHECK (arch ~ '^[a-z0-9_-]{1,32}$'),
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Content of the .sig file written by `tauri build` (minisign, verified against the updater
  -- public key before the release is registered).
  updater_signature TEXT NOT NULL,
  verified_at TIMESTAMPTZ NULL,
  PRIMARY KEY (release_id, target, arch)
);

-- Credentials of the release workflow: they can only upload and register drafts. The token is shown
-- once; only its SHA-256 is stored.
CREATE TABLE release_publisher_keys (
  key_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by TEXT NULL
);

-- Vendor-wide records: operators and system tasks only.
ALTER TABLE app_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON app_releases USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator());
ALTER TABLE app_release_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON app_release_artifacts USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator());
ALTER TABLE release_publisher_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON release_publisher_keys USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator());

-- Device manifest requests run in their tenant's scope: they read the published releases that have
-- a verified artifact for their platform through this function only (drafts stay invisible).
CREATE FUNCTION mfx_update_candidates(p_target text, p_arch text)
  RETURNS TABLE (
    release_id text, version text, channel text, rollout_percent integer, recalled boolean,
    notes_en text, notes_fr text, published_at timestamptz,
    object_key text, updater_signature text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT r.release_id, r.version, r.channel, r.rollout_percent, r.recalled_at IS NOT NULL,
               r.notes_en, r.notes_fr, r.published_at, a.object_key, a.updater_signature
        FROM app_releases r
        JOIN app_release_artifacts a ON a.release_id = r.release_id
        WHERE r.state = 'registered' AND r.channel IS NOT NULL
          AND a.target = p_target AND a.arch = p_arch AND a.verified_at IS NOT NULL $$;
REVOKE ALL ON FUNCTION mfx_update_candidates(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mfx_update_candidates(text, text) TO mfx_app;

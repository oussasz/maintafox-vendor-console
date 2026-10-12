-- Vendor-console actions that had no server endpoint (master plan Phase 4.2): slot release, rebind,
-- policy refresh, soft suspend / resume, rollout pause / resume / recall.

-- 'released' = the operator freed the slot: the device is refused, but it may claim again later
-- (unlike 'machine', an operator revocation that re-entering the licence key cannot undo).
ALTER TABLE machine_activations DROP CONSTRAINT machine_activations_revocation_kind_check;
ALTER TABLE machine_activations ADD CONSTRAINT machine_activations_revocation_kind_check
  CHECK (revocation_kind IN ('machine', 'license', 'released'));

-- Set by an operator ("policy refresh") or by a tenant resume: the device's sync requests are
-- refused (401 policy_refresh_required) until it calls POST /activation/policy-refresh, which
-- gives it a new token (the desktop resumes sync only when its token changes) and clears this.
ALTER TABLE machine_activations ADD COLUMN policy_refresh_requested_at TEXT NULL;

-- Soft suspension: tenants.is_active = 0 (devices refused with tenant_inactive, data kept). These
-- say when and why; NULL when the tenant is active.
ALTER TABLE tenants
  ADD COLUMN suspended_at TEXT NULL,
  ADD COLUMN suspended_reason TEXT NULL;

-- Rollout governance per (channel, cohort). No row = active. Delivered to devices with their
-- policy (claim / policy refresh): the desktop updater (master plan Phase 5) acts on it.
CREATE TABLE rollout_cohort_governance (
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'pilot', 'internal')),
  cohort_label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'recalled')),
  -- For 'recalled': the app version withdrawn from this cohort.
  recalled_version TEXT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  audit_record_id TEXT NOT NULL,
  PRIMARY KEY (channel, cohort_label),
  CHECK ((state = 'recalled') = (recalled_version IS NOT NULL))
);

-- Cross-tenant vendor record: operators and system tasks only (as audit_records, migration 007).
-- Device requests read it through their tenant's (channel, cohort) in a SECURITY DEFINER function.
ALTER TABLE rollout_cohort_governance ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON rollout_cohort_governance
  USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator());

CREATE FUNCTION mfx_rollout_governance(p_channel text, p_cohort text)
  RETURNS TABLE (state text, recalled_version text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT state, recalled_version FROM rollout_cohort_governance
        WHERE channel = p_channel AND cohort_label = p_cohort $$;
REVOKE ALL ON FUNCTION mfx_rollout_governance(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mfx_rollout_governance(text, text) TO mfx_app;

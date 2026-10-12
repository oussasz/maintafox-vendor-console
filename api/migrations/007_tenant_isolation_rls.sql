-- Tenant isolation with row-level security (master plan Phase 3.2), in addition to the WHERE
-- clauses in the API code.
--
-- The API keeps its connection user (it runs these migrations), but every transaction it opens
-- switches to the role mfx_app (SET LOCAL ROLE, api/src/db/database.ts). mfx_app is not a
-- superuser, does not own the tables and has no BYPASSRLS, so the policies below apply to it.
-- Each transaction also sets, for itself only:
--   mfx.tenant_id      = the tenant of an authenticated device request, or
--   mfx.operator_actor = the vendor operator or system task acting across tenants (explicit,
--                        recorded in operator_scope_access).
-- With neither set, every tenant-scoped table looks empty.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfx_app') THEN
    CREATE ROLE mfx_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

CREATE FUNCTION mfx_scope_tenant() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('mfx.tenant_id', true), '') $$;

CREATE FUNCTION mfx_scope_operator() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(current_setting('mfx.operator_actor', true), '') <> '' $$;

-- Every cross-tenant (operator or system) scope that the API opens.
CREATE TABLE operator_scope_access (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT NOT NULL,
  method TEXT NULL,
  path TEXT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX operator_scope_access_accessed_idx ON operator_scope_access (accessed_at);

-- Tables keyed by tenant_id: a row is visible / writable for its own tenant or an operator.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'license_keys', 'machine_activations', 'support_tickets', 'tenant_update_policy_history',
    'payment_orders', 'sync_tenant_checkpoint', 'sync_mirror_ingress', 'sync_exchange_idempotency',
    'sync_device_cursor', 'sync_rejection_log', 'sync_entity_state', 'sync_device_checkpoint',
    'sync_device_user', 'sync_exchange_idempotency_v2', 'sync_conflict_log', 'sync_media_manifest'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (mfx_scope_operator() OR tenant_id = mfx_scope_tenant()) '
      'WITH CHECK (mfx_scope_operator() OR tenant_id = mfx_scope_tenant())', t);
  END LOOP;
END
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (mfx_scope_operator() OR id = mfx_scope_tenant())
  WITH CHECK (mfx_scope_operator() OR id = mfx_scope_tenant());

-- Interventions belong to a ticket; the ticket's own policy decides (the subquery is filtered by it).
ALTER TABLE support_ticket_interventions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_ticket_interventions
  USING (mfx_scope_operator() OR EXISTS (
    SELECT 1 FROM support_tickets t WHERE t.ticket_id = support_ticket_interventions.ticket_id))
  WITH CHECK (mfx_scope_operator() OR EXISTS (
    SELECT 1 FROM support_tickets t WHERE t.ticket_id = support_ticket_interventions.ticket_id));

-- Cross-tenant records that no device request ever reads: operators and system tasks only.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_records', 'idempotency_keys', 'diagnostic_bundles', 'diagnostic_bundle_artifacts',
    'offline_ticket_reconciliation', 'legacy_sqlite_archive', 'operator_scope_access'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY operator_only ON %I USING (mfx_scope_operator()) WITH CHECK (mfx_scope_operator())', t);
  END LOOP;
END
$$;

-- Unauthenticated activation (preview / claim) presents only a licence key. This is the single
-- cross-tenant lookup it may do: the tenant of that key. Everything after it runs in that
-- tenant's scope. SECURITY DEFINER runs as the migration owner, which is not subject to RLS.
CREATE FUNCTION mfx_license_key_tenant(key text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT tenant_id FROM license_keys WHERE license_key = key $$;
REVOKE ALL ON FUNCTION mfx_license_key_tenant(text) FROM PUBLIC;

-- Privileges of mfx_app: data only (no DDL), on today's tables and on tables later migrations add.
GRANT USAGE ON SCHEMA public TO mfx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mfx_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO mfx_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM mfx_app;
GRANT EXECUTE ON FUNCTION mfx_license_key_tenant(text) TO mfx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mfx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO mfx_app;

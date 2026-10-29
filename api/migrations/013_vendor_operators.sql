-- Vendor-console operators and roles (master plan Phase 4.3). Roles and their permissions are
-- defined in code (api/src/vendor-auth/roles.ts); the API checks the permission of every console
-- route server-side.

ALTER TABLE users
  ADD COLUMN display_name TEXT,
  -- 'owner' is the role of operators that existed before roles: they had full access (the first
  -- seeded operator, operators imported from the legacy SQLite database). Operators created through
  -- the API always get an explicit role (POST /api/v1/operators).
  ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'operations', 'support', 'auditor')),
  -- A disabled operator cannot sign in and their sessions are ended; the account and its audit
  -- trail are kept.
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN last_login_at TIMESTAMPTZ;

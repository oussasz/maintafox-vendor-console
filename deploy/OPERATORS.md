# Console operators and roles (Phase 4.3)

Code: `api/src/vendor-auth/roles.ts` (roles, permissions, the permission of every route),
`api/src/app/guards.ts` (checked on every request), `api/src/routes/operators.ts`; console
`src/vendor-console/components/OperatorsPanel.tsx` (page **Operators**, owners only). Migration
`013_vendor_operators.sql`. Test: `api/scripts/operators-roles.integration.mjs` (in `test:all`).

**Before 4.3 the API did not check permissions: any signed-in operator could call every route.**
Now every console route has a required permission in one table, checked by the server on every
request; a route missing from the table is refused (and the test fails if any route is missing).

| Role | May |
|---|---|
| Owner | everything, including managing operators |
| Operations | customers, licences, machines, editions, rollouts, sync, support, audit (not operators) |
| Support | support tickets and diagnostic bundles, sync, platform health, audit (read elsewhere) |
| Auditor | audit log and platform health, read only |

Operators page (owners): add an operator (email, name, role, initial password of at least 12
characters), change role, disable / enable (disabling signs them out everywhere at once), reset
their two-step verification, delete (their audit trail stays). Each change asks for a reason and a
fresh authenticator code (`vendor_user_admin`) and is audited.

- A new operator signs in with the password, then must enter the **one-time enrolment code** shown
  to the owner when the account was created, then sets up their authenticator. Give the password
  and the code to them yourself, ideally by two different channels. The code is shown once and is
  never stored in clear.
- After an MFA reset by an owner, the same: a one-time reset code is shown once.
- Nobody can change their own role, disable, delete or reset themselves from this page, and the
  last enabled owner can never be removed: the console always keeps someone who can manage it.
  (A lost authenticator of the only owner: `deploy/VENDOR_AUTH.md`, server command.)
- Everyone can change their own password (account menu): current password required; their other
  sessions end.

## Deploy checklist

1. **Migration** `013_vendor_operators.sql`: `users` gains `display_name`, `role`, `is_active`,
   `last_login_at`. Every existing operator becomes **owner** (they had full access before).
2. **Environment:** nothing new.
3. Rebuild and restart the API and console images.
4. Check: sign in as the owner → the **Operators** page lists you with role Owner.

**Rollback.** Un-record the migration before starting the previous images
(`DELETE FROM schema_migrations WHERE version = 13`; also 12 and 11 when rolling back 4.2 and 4.1).
The previous API ignores the new columns: every operator gets full access again, and a disabled
operator could sign in again (delete such accounts first if that matters). Re-deploying 4.3 later
re-applies 013: first `ALTER TABLE users DROP COLUMN display_name, DROP COLUMN role, DROP COLUMN
is_active, DROP COLUMN last_login_at;` (everyone becomes owner again).

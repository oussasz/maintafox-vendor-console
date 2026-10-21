# Audit ledger categories (Phase 4.7 fix)

**What was wrong.** Since Phase 4.1 the control API writes ledger records in categories the
console did not know (`vendor_auth` on every console sign-in, then `tenant`, `operator`,
`billing`, `rollout`). The console checked every record against the desktop's 7 categories, so
one such record made the whole Audit page show "unexpected answer" and no records; the API's
category filter could not select them either. Found by the browser test (`e2e/console.spec.ts`).

**Now.** `shared/audit-action-categories.v1.json` lists every category (append-only), marking the
7 that exist in the desktop contract (`VendorAdminAuditActionCategoryV1`). The API loads it at
startup (`api/src/app/audit-categories.ts`), refuses to write a record in any other category (a
programming error, caught by the integration tests that exercise every audited route) and filters
the ledger by it (`?category=`; an unknown category is a 400). The console offers the same list
as filters, shows names in the operator's language, and shows a category it does not know by its
code instead of dropping the ledger. No data is changed: existing records keep their category.

**For the desktop.** The desktop's type still names 7 categories; records in the other 5 are
written by the control API only and are not sent to desktops.

## Deploy checklist

1. API image: `shared/audit-action-categories.v1.json` is copied to `/app/shared` (api/Dockerfile);
   the API does not start without it.
2. No migration, no new setting.
3. Check: Audit & evidence shows records, including console sign-ins ("Console sign-in").

**Rollback.** Previous API and console images (nothing to undo in the database).

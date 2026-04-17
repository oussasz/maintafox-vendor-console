# Vendor Console UX QA Checklist

## Goal

Verify that every visible action in vendor-console is either:

- fully functional against real APIs, or
- intentionally unavailable with a clear explanation.

## Route-by-Route Checks

## `/vendor-console` (overview)
- [ ] Ops hub cards render real telemetry values.
- [ ] Drill-through links navigate to the correct workspace.
- [ ] Refresh button updates cards and alerts.
- [ ] Step-up trigger opens step-up dialog and status text updates.

## `/vendor-console/customers`
- [ ] Customer list loads from API (`listTenants`) without fallback rows.
- [ ] Search/filter/sort controls behave as expected.
- [ ] Clicking a row updates selected customer metadata/policy view.
- [ ] Add customer/company modal validates fields and creates tenant via API.
- [ ] Success banner appears and new row is immediately visible/selectable.
- [ ] Error/loading/empty/retry states are visible and actionable.

## `/vendor-console/entitlements`
- [ ] Entitlement list loads from API (`listTenantLicenses`) without fallback rows.
- [ ] Add/Issue key dialog issues a real key via API and row appears immediately.
- [ ] Key row click opens detail dialog with full metadata.
- [ ] Revoke action calls API and updates key state.
- [ ] Update/Delete buttons remain disabled with explicit unavailable reasons.
- [ ] Error/loading/empty/retry states are visible and actionable.

## `/vendor-console/machines`
- [ ] Tenant machine table and policy load from API only.
- [ ] Policy action buttons mutate policy and show success/failure feedback.
- [ ] Claim activation executes API flow and refreshes tenant machine state.
- [ ] Machine row actions clearly indicate step-up requirement.

## `/vendor-console/sync`
- [ ] Telemetry cards/tables render real API data.
- [ ] Refresh and retry actions are functional.
- [ ] Empty states render clearly when datasets are empty.
- [ ] Drill-down panel opens from tenant table and shows rows.

## `/vendor-console/rollouts`
- [ ] Impact/cohort/diagnostic data render from API.
- [ ] Refresh and retry actions are functional.
- [ ] Cohort action buttons invoke step-up prompt with clear label intent.

## `/vendor-console/health`
- [ ] Service/pressure/alerts sections render from API.
- [ ] Refresh and retry actions are functional.
- [ ] Related operational drill links navigate correctly.

## `/vendor-console/audit` (ledger/support/hardening)
- [ ] Ledger search/filter/verify/export/refresh actions are functional.
- [ ] Ledger detail panel opens and shows record metadata from API.
- [ ] Support interventions require note and persist through API.
- [ ] Support export/download actions provide success/failure feedback.
- [ ] Hardening runbooks/readiness load from API; refresh works.

## Regression Guard

The automated guard `src/vendor-console/__tests__/ui-hardening-guards.test.ts` fails CI when:

- no-op click handlers are introduced (`onClick={() => {}}`, `onClick={() => null}`, etc.);
- disabled buttons labeled as unavailable are missing explicit reason (`title`).

## Evidence Commands

- `pnpm test`
- `pnpm typecheck`

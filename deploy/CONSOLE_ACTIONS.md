# Console actions: slots, policy refresh, suspension, rollout governance (Phase 4.2)

Every button of the console now calls an audited API endpoint. Code: `api/src/routes/licences.ts`
(machines), `api/src/routes/tenants.ts` (suspend / resume / delete), `api/src/routes/releases.ts`
(rollouts), `api/src/routes/activation.ts` + `api/src/app/guards.ts` (what devices see). Migration
`012_console_actions.sql`. Test: `api/scripts/console-actions.integration.mjs` (in `test:all`).

| Console button | Endpoint | Step-up kind | What the device sees |
|---|---|---|---|
| Machines → Revoke / Reinstate | `POST /tenants/:t/machines/:fp/revoke`, `/reinstate` | `machine_trust_change` | refused (`activation_revoked`) / accepted again |
| Machines → Slot release | `POST …/release` | `machine_trust_change` | refused from its next request; the slot is free and the device **may** activate again with the key |
| Machines → Rebind | `POST …/rebind` `{new_machine_fingerprint}` | `machine_trust_change` | old machine refused at once; the replacement activates with the key and finds its slot held (even if the licence is full) |
| Machines → Policy refresh | `POST …/policy-refresh` (reason header, no step-up) | — | its sync is refused (`401 policy_refresh_required`), so the desktop re-checks its licence, gets a **new token** with fresh policy, and resumes syncing |
| Customers → Suspend | `POST /tenants/:t/suspend` | `entitlement_suspension` | every device refused (`tenant_inactive`); licences, machines and data kept |
| Customers → Lift suspension | `POST /tenants/:t/resume` | `tenant_restore` | every active device is asked for a policy refresh (as above) so blocked desktops recover |
| Customers → Delete | `DELETE /tenants/:t` `{confirm_slug}` | `tenant_delete` | tenant, licences, activations and synced data purged (irreversible) |
| Rollouts → Pause / Resume | `POST /rollouts/:channel/:cohort/pause`, `/resume` | `rollout_publish` | `rollout_governance` in its policy (claim / policy refresh) |
| Rollouts → Recall | `POST /rollouts/:channel/:cohort/recall` `{recalled_version}` | `forced_rollback` | `rollout_governance: "recalled"`, `rollout_recalled_version` |

Every action needs a reason (`X-Operator-Reason`, kept in the audit ledger); dangerous ones also
need a fresh authenticator code for their kind (`deploy/VENDOR_AUTH.md`).

**Rollout pause and recall reach devices only with the Phase 5 updater.** They are stored, audited
and delivered to every device of the cohort with its policy, but today's desktops do not install
updates by themselves, so nothing changes on them yet. The console says so on the Rollouts page.
The rollout overview now shows the stored governance state (it used to show "paused" whenever a
forced-update policy was set, which was a guess).

Governance is keyed by the channel a device receives (its licence's `update_channel`) and its
tenant's cohort.

## Deploy checklist

1. **Migration** `012_console_actions.sql` runs at API start: `machine_activations` gains
   `policy_refresh_requested_at` and the revocation kind `released`; `tenants` gains
   `suspended_at`, `suspended_reason`; new table `rollout_cohort_governance` (operators only, RLS)
   and function `mfx_rollout_governance` (devices read their cohort's state).
2. **Environment:** nothing new.
3. **Desktop contract:** additive only. Claim and policy-refresh answers gain `rollout_governance`
   and `rollout_recalled_version` (ignored by today's desktops); sync may answer
   `401 policy_refresh_required` (today's desktops treat any 401 on sync as "re-check the licence",
   which is the intended behaviour); device tokens gain a `jti` claim (unique per issue).
4. Rebuild and restart the API and console images.
5. Check: on the Machines page, "Policy refresh" on a live device → the row shows "Refresh pending",
   then clears after the desktop's next licence check; the Audit page shows
   `machine_policy_refresh_requested`.

**Rollback.** Before starting the previous images, un-record the migrations they do not know
(`DELETE FROM schema_migrations WHERE version IN (12)`; also 11 when rolling back 4.1, see
`deploy/VENDOR_AUTH.md`). The previous API ignores the new columns and table; a device whose slot
was released stays refused (the previous API treats any revocation as revoked) and can re-activate
with the key. Re-deploying 4.2 later re-applies 012: first drop what it created (`DROP TABLE
rollout_cohort_governance; DROP FUNCTION mfx_rollout_governance(text, text); ALTER TABLE
machine_activations DROP COLUMN policy_refresh_requested_at; ALTER TABLE tenants DROP COLUMN
suspended_at, DROP COLUMN suspended_reason;`).

## Forced-update floor and the PC's version (licence review R4-S2)

- **Floor format.** The minimum app version (tenant override or cohort baseline) must be
  `MAJOR.MINOR.PATCH`, optionally with a pre-release tag (`2.0.0-rc.1`). The loose forms `2`,
  `2.0` and `v2.0.0` are accepted and mean `2.0.0`. Anything else (`latest`, `2.x`, `2.0.0.1`) is
  refused with `400 invalid_request` when it is set (tenant create, tenant and cohort
  update-policy). A floor that cannot be read blocks every PC under `required`.
- **Pre-release builds.** A pre-release such as `0.4.0-dev` counts as **below** `0.4.0`. Set the
  floor to a version the shipped builds actually report, or a dev/rc build stays blocked.
- **Policy refresh compares the PC's version.** `POST /api/v1/activation/policy-refresh` accepts
  `{"app_version": "<running version>"}` (optional, string, max 32; unknown fields are ignored;
  a wrong type is a 400). Under `required`, a PC at or above the floor is no longer told to
  update. A desktop that does not send the field (body `{}` or no body), or sends a version that is
  not `MAJOR.MINOR.PATCH[-pre]`, keeps the old answer: update required. `emergency` blocks every
  version, as before. Claim and preview apply the same rule to their `app_version`.
- **An empty field never removes the floor.** On the update-policy `PUT` a missing or `null`
  `force_min_app_version` keeps the stored floor, and `""` is a 400. The console sends `null` for
  an empty field, so emptying the field and applying changes nothing.
- **Remove minimum version** (console: Updates > Force-update governance, the button under the
  minimum version, shown only when one is stored; a confirmation names the floor and the customer,
  or the channel and rollout group). Its own routes:
  `POST /api/v1/tenants/:tenantId/update-policy/clear-min-version` and
  `POST /api/v1/cohorts/:channel/:cohort/update-policy/clear-min-version`, body
  `{"expected_force_min_app_version": "<the floor shown to the operator>"}` and nothing else (any
  other field, a missing or empty value: 400). Permission `rollout.manage`, audit reason and step-up
  `rollout_publish`, like applying a policy. Only the floor is removed; mode and user message stay.
  Refusals (409): `no_force_min_app_version` (nothing stored), `force_min_app_version_changed`
  (the stored floor is not the one confirmed), `force_min_app_version_needed_by_required_mode`
  (the policy is `required`: without a floor `required` blocks every PC, so switch the mode first).
  Ledger: `tenant_update_policy_min_version_removed` / `cohort_update_policy_min_version_removed`,
  category `rollout_intervention`; the payload (stored as its hash in the chain) carries
  `floor_removed: true` and the removed value. The policy history keeps the old floor, so
  **Roll back** (step-up `forced_rollback`) restores it. The confirmation tells the operator what
  PCs see: under `emergency` every PC stays blocked until the mode changes; under `off` (or a
  customer on `inherit`) nothing changes for PCs now.

**Before deploying**, list the stored floors the new rule cannot read and correct them in the
console (run as the database owner / migration role, which bypasses RLS):

```sql
WITH floors AS (
  SELECT 'tenant' AS source, slug AS name, force_min_app_version AS floor, force_update_mode AS mode
  FROM tenants WHERE force_min_app_version IS NOT NULL
  UNION ALL
  SELECT 'cohort', channel || '/' || cohort_label, force_min_app_version, force_update_mode
  FROM cohort_update_policies WHERE force_min_app_version IS NOT NULL
)
SELECT * FROM floors
WHERE btrim(floor) !~ '^v?(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8}))?(\.(0|[1-9][0-9]{0,8}))?(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$';
```

Rows with mode `required` are the urgent ones: after the deploy they block every PC of that tenant
or cohort until the floor is corrected. A policy rollback restores the previous floor from
`tenant_update_policy_history` / `cohort_update_policy_history` without re-validating it; run the
same check on `previous_force_min_app_version` there if you plan to roll back.

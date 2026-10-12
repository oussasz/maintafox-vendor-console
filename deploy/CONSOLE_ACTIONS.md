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

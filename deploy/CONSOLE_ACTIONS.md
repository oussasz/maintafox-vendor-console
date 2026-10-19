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

A suspended customer stays in the Customers list and the Overview (status "Suspended"; counted in the
total but not as active, and its licences and devices are not "needs attention" items), so an operator can
find it and lift the suspension.

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
- **"Required" always has a floor.** A policy `PUT` whose result would be `required` with no floor
  is refused with `409 force_min_app_version_needed_by_required_mode` (nothing written); the policy
  routes lock the policy row (`FOR UPDATE`) so a concurrent change cannot slip in between.
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

## Administrator recovery code (decision register 2026-10-19, "No active administrator left on a PC")

> **NEW MIGRATION: `016_admin_recovery_codes.sql`** (new table `admin_recovery_codes`, tenant RLS;
> no existing table changes). It runs automatically at API start.

**What it is.** A one-time code, signed by Maintafox, bound to one PC activation (tenant, machine
fingerprint, licence). It **creates one new administrator account on that PC** (valid **24 h**,
**single use**). It does **not** reset or unlock an existing account; the customer disables the old
account afterwards. The desktop accepts it whatever the PC's administrator state (rule amended by
the CMMS Advisor on 2026-10-19: no "no active administrator" precondition), and every active
administrator of the PC then sees a persistent notice that a recovery code was used.

**When to use it.** When the site can no longer administer the PC, e.g. the only administrator
forgot their password. The site enters the code in the Maintafox desktop (administrator recovery).

**How.** Customer → Devices → the PC's "⋯" menu → "Administrator recovery code" → reason (ledger)
→ authenticator code (step-up kind `admin_recovery_code`). The code is shown **once** with a copy
button and its expiry; send it to the site by email or chat. Maintafox does not keep the code (not
in the database, the ledger, or the idempotency store); if it is lost, issue a new one. The dialog
says when codes sent earlier for that PC are still valid.

**Server (control API).**
- `POST /api/v1/tenants/:tenantId/machines/:machineFingerprint/admin-recovery-code`, permission
  `entitlement.manage`, `X-Operator-Reason` + `X-Step-Up-Token` of kind `admin_recovery_code`
  (console-only kind: `rust_variant` null in `shared/step-up-actions.v1.json`). Returns `201` with
  `code`, `code_id`, `issued_at`, `expires_at`, `key_id`, `audit_record_id` (`Cache-Control: no-store`).
- Refusals: `404 tenant_not_found | activation_not_found`; `409 tenant_suspended |
  activation_revoked | license_revoked | license_expired | admin_recovery_code_limit` (at most **3
  unexpired codes per PC**; re-issuing is allowed below that, earlier codes stay valid until they
  expire or are used); `403 privileged_action_guard_failed` (no reason, no / wrong step-up),
  `403 permission_denied`.
- Ledger: `admin_recovery_code_issued`, category `entitlement`, entity refs tenant / licence /
  machine, payload `code_id`, `license_id`, `machine_fingerprint`, `key_id`, `issued_at`,
  `expires_at` — never the code or its signature.
- `GET /api/v1/tenants/:tenantId/admin-recovery-codes[?machine_fingerprint=…]` (`console.view`):
  issued codes (who, why, when, until when, `expired`), never the codes.

**Format** (agreed with the desktop licensing verifier; implementation
`api/src/admin-recovery-signer.ts`, test vector `api/testdata/admin-recovery-vector.json`, regenerate
with `node api/scripts/admin-recovery-vector.mjs` after `pnpm --filter maintafox-control-api build`;
besides the primary vector it holds `extra_cases`: an escaped fingerprint that must verify, and
negatives with their expected result named in `refusal_codes`: bare-payload signature, expired,
issued in the future, wrong purpose, keys reordered):

```
MFXREC1.<payload, base64url without padding>.<Ed25519 signature, 128 lowercase hex chars>
payload = {"v":1,"purpose":"admin_recovery","code_id":"<uuid v4>","tenant_id":"…",
           "machine_fingerprint":"<as stored>","license_id":"…","issuer":"maintafox-vps",
           "key_id":"<entitlement signing key id>","signature_alg":"ed25519:admin-recovery:v1",
           "issued_at":"<toISOString()>","expires_at":"<issued_at + 24 h>"}   (exactly this key order)
signature = Ed25519("maintafox-admin-recovery:v1\n" + payload) with the entitlement signing key
```

**What the desktop checks** (refuses otherwise): prefix; base64url; JSON shape and key order
(re-serialised, bytes compared); `v`, `purpose`, `signature_alg`; `issuer`; `key_id` pinned and not
compromised; the signature; `tenant_id`, `machine_fingerprint`, `license_id` equal to its stored
activation claim; now < `expires_at`; `issued_at` not more than 5 minutes in the future; `code_id`
not used before (single use is enforced on the PC; no consumption report to the server in v1).
There is no check on the PC's administrator state: the code creates one extra administrator and
the desktop shows every active administrator a persistent notice.

**Key rotation.** Codes are signed with the current entitlement signing key: after a rotation, codes
issued with the old key stop working on desktops that no longer pin it (issue a new one).

**Rollback.** Un-record version 16 in `schema_migrations` before starting the previous images (same
statement as in `PHASE4_DEPLOY.md`, with 16); the previous API ignores the table. Re-deploying later:
drop the table `admin_recovery_codes` first. Codes already sent stay valid on the desktops until they
expire (they are verified offline).

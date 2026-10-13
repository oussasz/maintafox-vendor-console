# Console redesign (October 2026)

Approved design: three mockups (Overview, Customer, System health). Left navy sidebar, white cards
on a pale blue ground, IBM Plex Sans (self-hosted, no font CDN), 44 px controls, orange only for
"needs attention", plain language in English and French.

## Where everything is now

| Section | What it holds | Before |
|---|---|---|
| Overview | 4 key figures, "Needs your attention" (each item with one action), health summary, customer table | Overview cards |
| Customers | all customers, filter by standing, search, new customer | Customers workspace (list) |
| Customer page | header (standing, edition, main action) and tabs: Overview (licence, seats, data sync, devices with actions, sensitive actions), Licence and billing (keys, payments, offline rules), Data sync (device timeline, full resynchronisation), Support (tickets, diagnostic files), History (audit log of this customer) | Customers workspace (details), Entitlements, Billing, Machines, Sync, Audit |
| Licences and editions | tabs: Licence keys (all customers), Editions, Payments | Entitlements, Editions, Billing |
| Devices | tabs: Devices (per customer, with actions), Sync across customers, Test an activation | Machines, Sync |
| Updates | tabs: Rollout groups (pause, resume, recall), Required versions (per customer or group) | Rollouts, forced-update part of Customers |
| Support | tickets, interventions, diagnostic files, reconciliation, exports | Audit, Support tab |
| System health | one sentence, then Server, Backups, Data sync, App updates; technical details tab | Platform health |
| Settings and team | tabs: Team (operators), Audit log, Safeguards (step-up actions, runbooks, readiness) | Operators, Audit |

Old addresses (`/vendor-console/machines`, `/entitlements`, `/billing`, `/sync`, `/rollouts`,
`/audit`, `/operators`, `/editions`) redirect to their new place.

## Real data only

The Overview and System health read two new endpoints (`api/src/routes/console.ts`):
`GET /api/v1/console/overview` (permission `console.view`) and `GET /api/v1/console/health`
(`platform.observe`). They return facts and codes; the console words them. Thresholds: a licence
ending within 30 days needs a renewal; a device not seen for 24 hours is "not syncing"; a backup
older than 26 hours is late; a restore test older than 35 days is overdue (same values as the ops
overview). Empty platform: the pages say what to do instead of showing zeros as findings.

`GET /api/v1/tenants/:id/activations` also returns the device name the desktop reported
(`machine_label`), its activation and revocation dates (additive fields).

"Copies kept" on System health comes from `BACKUP_LOCAL_RETENTION_DAYS`, now also passed to the API
service in `docker-compose.yml` (the value the backup service already reads from `.env`); without
it the line is not shown.

## Errors

Every failure is one sentence with a retry: a known API code is translated, otherwise the message
of the server is shown; a lost connection and an unreadable answer have their own sentence. Raw
JSON, codes and validation output are never shown (browser test: `e2e/console.spec.ts`).

## Removed

- The "bulk entitlement operation" block of the old Customers page: it only built a JSON preview
  and sent nothing (no server action exists).
- Unused components (signed claim preview, destructive approval fields, ops hub card).

## Not finished (shown as such, never as a dead button)

- App updates: the latest published version appears with the release catalogue (Phase 5); the page
  lists the versions devices report and says so.
- Pause and recall of a rollout group are recorded and sent with the policy; devices act on them
  once the desktop updater exists (Phase 5); the Updates page says so.
- Payment links need SlickPay settings on the server; without them the page says so and the button
  is disabled.
- Some older panels kept their content inside the new tabs (Support, Rollout groups, Licence keys,
  Payments, Editions, Sync across customers, Team, Safeguards): restyled to the new palette, not yet
  rebuilt card by card.

## Deploy checklist

Console and API images (one deploy with Phase 4, `deploy/PHASE4_DEPLOY.md`). No migration for the
redesign itself. `docker-compose.yml` passes `BACKUP_LOCAL_RETENTION_DAYS` to the API (already in
`.env`). Check after deploy: the Overview shows the four figures; System health shows the last
backup; a customer page opens from the table.

Rollback: previous console and API images (nothing to undo in the database).

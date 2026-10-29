# Support data (Phase 3.4)

Tickets, interventions, diagnostic bundles and runbooks are real records (migration 009). The
bootstrap seed fixtures (`sup_seed_001`, `bundle_seed_001`, `dq_seed_*`, placeholder runbooks) are
removed; the seed's old audit record stays because the ledger is append-only.

## Tickets
- Opened by an operator in the console (`POST /api/v1/support/tickets`, recorded as
  `support_ticket_create`) or by a desktop together with a diagnostic bundle.
- Fields added: `summary`, `origin` (`operator` | `device`), `created_by` (`user_<id>` or
  `device:<fingerprint>`), `diagnostic_bundle_ids`. `app_version_reported` and
  `sync_status_hint` are null until a device reports them.
- Interventions are unchanged (step-up + reason, linked to an audit record).

## Diagnostic bundles (desktop → object storage → console)
1. Desktop: `POST /api/v1/sync/diagnostic-bundles` (activation token) with the bundle's byte size
   (≤ 5 MiB), SHA-256, redaction profile, app version, artifact list, and optionally a ticket
   (`summary`, `affected_module`, `severity`). Answer: `bundle_id` + a presigned PUT URL.
2. Desktop uploads the bytes to that URL (object key `{env}/support/{tenant}/{bundle_id}`, in the
   media bucket, so the off-site backup copies it too).
3. Desktop: `POST /api/v1/sync/diagnostic-bundles/{id}/complete`. The server reads the object back
   and checks size and SHA-256: match → `uploaded` (and the requested ticket is opened);
   mismatch → `rejected` (422, reason stored); not uploaded → 409. Only the device that declared a
   bundle can complete it; row-level security keeps bundles inside their tenant.
4. Console: `GET /api/v1/support/diagnostic-bundles[?tenant_id=]` lists them;
   `GET /api/v1/support/diagnostic-bundles/{id}/download` returns a 15-minute presigned URL and
   records `diagnostic_bundle_download` in the audit ledger.

## Runbooks
Six real procedures are ensured at API startup (`api/src/app/runbooks.ts`: `heartbeat_outage`, `sync_backlog_surge`,
`failed_rollout`, `storage_pressure`, `key_rotation`, `database_restore`), pointing at the actual
documents and commands. Operators create / update / delete runbooks
(`POST|PUT|DELETE /api/v1/audit/hardening/runbooks[/id]`, all audited). Startup replaces the
old placeholder text only for runbooks no operator has edited.

## Readiness checks
Computed, not counted: the audit hash chain is recomputed; every intervention must point to an
existing audit record; uploaded bundles must carry a redaction profile and a verified SHA-256.

## Offline reconciliation
The endpoint lists the real `offline_ticket_reconciliation` table (empty: no desktop feature writes
it yet; the fixtures are gone).

Tests: `scripts/support.integration.mjs` (in `test:all`), `scripts/support-bundles.integration.mjs`
(needs an S3-compatible server; CI object-storage job).

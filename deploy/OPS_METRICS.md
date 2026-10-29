# Ops metrics (Phase 3.3)

All figures shown by the vendor console's sync / platform / rollout pages and by
`GET /api/v1/ops/metrics` are **measured** from the database or a live probe. The earlier estimates
(`lag = stale devices x 45 s`, `checkpoint age = stale x 120 s`, rejection rate from revoked machines,
a fixed "postgres healthy" line, rollout counts as 2 % of machines, ...) are gone.
Code: `api/src/ops/sync-health.ts`, `api/src/routes/ops.ts`.

## Sync (per device and per tenant)

Active device = activation not revoked, licence not revoked, tenant active.

| Figure | Definition |
|---|---|
| `lag_seconds` (device) | Age of the oldest change the device has not acknowledged yet: current-state rows after its acknowledged checkpoint (v2), not written by itself, not personal rows of users it does not report; v1-only devices: log rows after their cursor. A device acknowledges with the checkpoint it sends on its next exchange (one heartbeat later), so delivered-but-unconfirmed changes still count. 0 = up to date. |
| `checkpoint_age_seconds` (device) | Time since its last exchange; since activation for a device that never synced. |
| tenant `lag_seconds` / `checkpoint_age_seconds` | Worst active device. `online_lag_seconds`: worst device seen in the last 15 min. |
| `rejection_rate_bps` | Last 24 h: refused / (applied + refused + conflicting) items, in basis points. |
| `dead_letter_count` | Last 24 h: distinct item keys refused and never applied since (a corrected resend under the same key clears it). |
| `conflicts` | Last 24 h: items refused because the device edited a stale version. |
| `retry_pressure` | Last 24 h: % of exchange requests that were retries of an exchange already answered (lost response), answered from the stored response (migration 008 counts them). |
| severity | Worst of: online lag ≥ 120 s warn / ≥ 900 s critical; rejection rate ≥ 100 / 500 bps; dead letters ≥ 1 / 10; retry pressure ≥ 20 / 50 %. |
| heartbeat anomalies | `never_synced`, `stale_heartbeat` (no heartbeat for 15 min), `expired_offline_grace` (no exchange within the tenant's offline grace). |
| drill-down | Refused and conflicting items of the last 24 h with the exchange (`server_batch_id`) that refused them. |

`GET /api/v1/ops/sync-overview` keeps its fields and adds `window_hours`, `generated_at_rfc3339`,
per-tenant counts (`applied_items`, `rejected_items`, `conflicts`, `exchanges`, `retries`,
`device_count`, `online_device_count`, `online_lag_seconds`) and `device_rows`.

## Platform

`api` (uptime, requests, 5xx share since start), `workers` (last sync-retention run of this
process), `postgresql` (live round trip, connections, size), `object_storage` (live HEAD of the
media bucket), `backups` (from `backup_runs`: last nightly success ≤ 26 h, off-site status, restore
drill ≤ 35 days). Infra pressure values are current measurements (`trend: not_tracked`: no history
is stored). Rollout diagnostics list only what the server measures (`migration` = forced-update
policy changes, `post_deploy_heartbeat` = devices with a heartbeat in 24 h); download and signature
events need the desktop updater (Phase 5).

## Prometheus / OpenMetrics

`GET https://api.maintafox.systems/api/v1/ops/metrics` (text format 0.0.4). Authorization:
`Bearer <METRICS_SCRAPE_TOKEN>` (optional env, ≥ 32 characters; each scrape is recorded in
`operator_scope_access` as `system:metrics-scrape`) or a vendor operator token.

Families: `maintafox_api_uptime_seconds`, `maintafox_api_requests_total`,
`maintafox_api_requests_5xx_total`, `maintafox_auth_logins_total{result}`,
`maintafox_activation_claims_total{result}`, per tenant `maintafox_sync_devices`,
`_devices_online`, `_applied_items`, `_rejected_items`, `_conflicts`, `_dead_letters`,
`_exchanges`, `_retries`, `_rejection_rate_bps`, `_retry_pressure_percent`, `_tenant_severity`;
per device `maintafox_sync_device_lag_seconds`, `_checkpoint_age_seconds`;
`maintafox_backup_last_success_timestamp_seconds{kind}`, `maintafox_backup_last_run_succeeded{kind}`,
`maintafox_backup_offsite_last_upload_timestamp_seconds`, `maintafox_database_size_bytes`.

Prometheus job example:

```yaml
- job_name: maintafox-control-api
  scheme: https
  metrics_path: /api/v1/ops/metrics
  authorization: { type: Bearer, credentials_file: /etc/prometheus/maintafox-scrape-token }
  static_configs: [{ targets: ["api.maintafox.systems"] }]
```

Test: `node scripts/ops-metrics.integration.mjs` (part of `test:all`).

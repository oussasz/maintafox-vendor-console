// IPC contract types shared between src/ (frontend) and the Tauri command layer.
// Types defined here must be kept in sync with Rust structs in src-tauri/src/.

export interface HealthCheckResponse {
  status: "ok" | "degraded";
  version: string;
  db_connected: boolean;
  locale: string;
}

// â”€â”€â”€ Startup Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type StartupStage =
  | "db_ready"
  | "migrations_complete"
  | "entitlement_cache_loaded"
  | "ready"
  | "failed";

export interface StartupEvent {
  stage: StartupStage;
  /** Present only for stage = "migrations_complete" */
  applied?: number;
  /** Present only for stage = "failed" */
  reason?: string;
}

// â”€â”€â”€ App Info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AppInfoResponse {
  version: string;
  build_mode: "debug" | "release";
  os: string;
  arch: string;
  app_name: string;
  default_locale: string;
}

// â”€â”€â”€ Task Status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type TaskStatusKind = "running" | "cancelled" | "finished";

export interface TaskStatusEntry {
  id: string;
  status: TaskStatusKind;
}

// â”€â”€â”€ Shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// shutdown_app â€” no response type; the Rust command calls app.exit(0).

// â”€â”€â”€ Auth & Session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SessionInfo {
  is_authenticated: boolean;
  is_locked: boolean;
  user_id: number | null;
  username: string | null;
  display_name: string | null;
  is_admin: boolean | null;
  force_password_change: boolean | null;
  expires_at: string | null;
  last_activity_at: string | null;
  password_expires_in_days: number | null;
  pin_configured: boolean | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  session_info: SessionInfo;
}

// â”€â”€â”€ RBAC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PermissionRecord {
  name: string;
  description: string;
  category: string;
  is_dangerous: boolean;
  requires_step_up: boolean;
}

export interface StepUpRequest {
  password: string;
}

export interface StepUpResponse {
  success: boolean;
  expires_at: string;
}

// â”€â”€â”€ Device Trust â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DeviceTrustStatus {
  device_fingerprint: string;
  is_trusted: boolean;
  is_revoked: boolean;
  offline_allowed: boolean;
  offline_hours_remaining: number | null;
  device_label: string | null;
  trusted_at: string | null;
  offline_denial_code?: string | null;
  offline_denial_message?: string | null;
  status?: string;
}

export interface ActivationPolicySnapshot {
  fingerprint_max_drift: number;
  grace_hours: number;
  offline_allowed_states: string[];
  reconnect_revocation_blocking: boolean;
}

export interface ApplyMachineActivationInput {
  contract_id: string;
  machine_id: string;
  slot_assignment_id: string;
  slot_number: number;
  slot_limit: number;
  trust_score: number;
  vps_version: number;
  response_nonce: string;
  issued_at: string;
  expires_at: string;
  offline_grace_until: string;
  revocation_state: "active" | "pending_revocation" | "revoked" | string;
  revocation_reason?: string | null;
  anchor_hashes_json: string;
  policy_snapshot_json: string;
}

export interface MachineActivationStatus {
  contract_id: string | null;
  machine_id: string | null;
  slot_assignment_id: string | null;
  slot_number: number | null;
  slot_limit: number | null;
  trust_score: number | null;
  revocation_state: string;
  issued_at: string | null;
  expires_at: string | null;
  offline_grace_until: string | null;
  drift_score: number;
  drift_within_tolerance: boolean;
  denial_code: string | null;
  denial_message: string | null;
}

export interface MachineActivationApplyResult {
  contract_id: string;
  trusted_binding: boolean;
  drift_score: number;
  slot_assignment_consistent: boolean;
  replay_rejected: boolean;
}

export interface OfflineActivationDecision {
  allowed: boolean;
  denial_code: string | null;
  denial_message: string | null;
  requires_online_reconnect: boolean;
  grace_hours_remaining: number | null;
}

export interface ActivationLineageRecord {
  id: string;
  event_code: string;
  contract_id: string | null;
  slot_assignment_id: string | null;
  detail_json: string;
  occurred_at: string;
  actor_user_id: number | null;
}

export interface MachineActivationDiagnostics {
  status: MachineActivationStatus;
  last_reconnect_at: string | null;
  last_revocation_applied_at: string | null;
  lineage: ActivationLineageRecord[];
  runbook_links: string[];
}

export interface RotateActivationSecretInput {
  reason: string;
}

export interface RotateActivationSecretResult {
  rotated: boolean;
  rotated_at: string;
  reason: string;
}

export interface RebindMachineActivationInput {
  reason: string;
}

export interface RebindMachineActivationResult {
  previous_contract_id: string | null;
  rebind_required: boolean;
  rebind_requested_at: string;
  reason: string;
}

export interface LicenseRejectionReason {
  code: string;
  message: string;
  source: string;
}

export interface LicenseEnforcementDecision {
  permission: string;
  capability_class: string;
  allowed: boolean;
  degraded_to_read_only: boolean;
  reason: LicenseRejectionReason | null;
  entitlement_state: string;
  activation_state: string;
  trust_state: string;
}

export interface LicenseStatusView {
  entitlement_state: string;
  activation_state: string;
  trust_state: string;
  policy_sync_pending: boolean;
  pending_local_writes: number;
  last_admin_action: string | null;
  last_admin_action_at: string | null;
  actionable_message: string;
  recovery_paths: string[];
}

export interface ApplyAdminLicenseActionInput {
  action: "suspend" | "revoke" | "reactivate" | string;
  reason: string;
  expected_entitlement_state?: string | null;
  expected_activation_state?: string | null;
}

export interface ApplyAdminLicenseActionResult {
  action_id: string;
  action: string;
  applied_at: string;
  entitlement_state_after: string;
  activation_state_after: string;
  pending_local_writes: number;
  queued_local_writes: boolean;
}

export interface LicenseTraceEvent {
  id: string;
  correlation_id: string;
  event_type: string;
  source: string;
  subject_type: string;
  subject_id: string | null;
  reason_code: string | null;
  outcome: string;
  occurred_at: string;
  payload_hash: string;
  previous_hash: string | null;
  event_hash: string;
}

export interface ApplyLicensingCompromiseResponseInput {
  issuer: string;
  key_id: string;
  reason: string;
  force_revocation: boolean;
}

export interface ApplyLicensingCompromiseResponseResult {
  issuer: string;
  key_id: string;
  policy_sync_pending: boolean;
  forced_revocation: boolean;
  applied_at: string;
}

export type VpsApiFamily = "license" | "sync" | "updates" | "admin" | "relay";

export type VpsAuthBoundary = "tenant_runtime" | "vendor_admin";

export interface VpsContractError {
  family: VpsApiFamily;
  code: string;
  message: string;
  http_status: number;
  retryable: boolean;
}

export interface VpsRouteContract {
  family: VpsApiFamily;
  owner: string;
  route_prefix: string;
  version: "v1" | string;
  required_boundary: VpsAuthBoundary;
  tenant_scope: "required" | "not_allowed";
  required_permissions: string[];
  idempotency_required: boolean;
  replay_guard_required: boolean;
}

export interface VpsRequestContext {
  correlation_id: string;
  api_version: "v1" | string;
  auth_boundary: VpsAuthBoundary;
  actor_id: string;
  tenant_id: string | null;
  token_tenant_id: string | null;
  permissions: string[];
  idempotency_key: string | null;
  request_nonce: string | null;
  checkpoint_token: string | null;
}

export interface VpsPolicyDeliveryPayload {
  entitlement_state: string;
  offline_grace_until: string | null;
  trusted_device_policy: string;
  rollout_channel: string;
  urgent_notice: string | null;
}

export interface VpsLicenseHeartbeatRequest {
  contract_family: "license";
  api_version: "v1" | string;
  machine_id: string;
  idempotency_key: string;
  request_nonce: string;
  checkpoint_token: string | null;
}

export interface VpsLicenseHeartbeatResponse {
  correlation_id: string;
  policy: VpsPolicyDeliveryPayload;
  server_time: string;
}

export interface VpsSyncPushRequest {
  contract_family: "sync";
  api_version: "v1" | string;
  checkpoint_token: string | null;
  idempotency_key: string;
}

export interface VpsSyncPushResponse {
  correlation_id: string;
  checkpoint_token: string | null;
  acknowledged_idempotency_keys: string[];
}

export interface VpsAdminMutationRequest {
  contract_family: "admin";
  api_version: "v1" | string;
  action: string;
  idempotency_key: string;
}

export type VendorConsolePermission =
  | "console.view"
  | "customer.manage"
  | "entitlement.manage"
  | "sync.operate"
  | "rollout.manage"
  | "platform.observe"
  | "audit.view";

/** Typed admin mutation envelope; server ignores client permission claims. */
export interface VendorAdminMutationEnvelope {
  contract_family: "admin";
  api_version: "v1" | string;
  action: string;
  idempotency_key: string;
  correlation_id?: string;
  _client_claimed_permissions?: VendorConsolePermission[];
}

export type VendorAdminMfaAuditKind =
  | "login_success"
  | "login_failure"
  | "mfa_challenge_shown"
  | "mfa_success"
  | "mfa_failure"
  | "step_up_prompted"
  | "step_up_satisfied"
  | "privileged_action_denied"
  | "privileged_action_committed"
  | "refresh_rotated"
  | "logout";

export interface VendorAdminMfaAuditEvent {
  kind: VendorAdminMfaAuditKind;
  correlation_id: string;
  actor_id: string;
  route: string;
  detail_code: string;
}

export type EntitlementLifecycleState =
  | "active"
  | "grace"
  | "expired"
  | "suspended"
  | "revoked";

export type EntitlementLifecycleAction =
  | "issue"
  | "renew"
  | "suspend"
  | "revoke"
  | "emergency_lock"
  | "resume_from_suspension";

export type VendorUpdateChannel = "stable" | "pilot" | "internal";

export interface SignedClaimPreviewV1 {
  schema_version: number;
  tenant_id: string;
  tier: string;
  machine_slots: number;
  offline_grace_hours: number;
  update_channel: VendorUpdateChannel;
  valid_from_rfc3339: string;
  valid_until_rfc3339: string;
  feature_flags_digest: string;
  capabilities_digest: string;
  issuer: string;
  key_id: string;
  payload_sha256: string;
  signature_alg: string;
}

export type DestructiveEntitlementAction =
  | "revocation"
  | "immediate_expiry"
  | "machine_slot_reduction";

export interface AuditableApprovalContextV1 {
  actor_id: string;
  second_actor_id?: string;
  reason_code: string;
  free_text_rationale: string;
  previous_claim_snapshot_sha256: string;
  correlation_id: string;
}

export type HeartbeatFreshness = "live" | "stale" | "unknown";

export interface MachineActivationRowV1 {
  machine_id: string;
  tenant_id: string;
  last_heartbeat_rfc3339: string | null;
  app_version: string | null;
  trusted_device: boolean;
  activation_source: string;
  anomaly_flags: string[];
  heartbeat_freshness: HeartbeatFreshness;
}

export interface OfflinePolicyControlsV1 {
  grace_hours: number;
  trust_revocation_disconnects_immediately: boolean;
  reconnect_requires_fresh_heartbeat: boolean;
}

export interface BulkEntitlementOperationRequestV1 {
  dry_run: boolean;
  tenant_ids: string[];
  target_channel?: VendorUpdateChannel;
  expected_lineage_version_by_tenant: [string, number][];
}

export interface BulkFailureRow {
  tenant_id: string;
  code: string;
  message: string;
}

export interface BulkEntitlementOperationResultV1 {
  dry_run: boolean;
  would_affect_count: number;
  failures: BulkFailureRow[];
}

export interface OptimisticConcurrencyV1 {
  resource_id: string;
  expected_version: number;
}

// ─── Vendor ops console: sync / rollout / platform health (aligns with vps::sync_rollout_platform_ops) ───

export type SyncHealthSeverityV1 = "info" | "warn" | "critical";

export interface TenantSyncHealthRowV1 {
  tenant_id: string;
  lag_seconds: number;
  checkpoint_age_seconds: number;
  rejection_rate_bps: number;
  retry_pressure: number;
  dead_letter_count: number;
  severity: SyncHealthSeverityV1;
}

export interface SyncFailureDrillDownRowV1 {
  batch_id: string;
  entity_type: string;
  failure_reason_code: string;
  idempotency_key: string;
  last_attempt_rfc3339: string;
  attempt_count: number;
}

export type RepairQueueActionV1 = "replay" | "requeue" | "acknowledge" | "escalate";

export interface RepairQueueItemV1 {
  item_id: string;
  tenant_id: string;
  queue_kind: string;
  severity: SyncHealthSeverityV1;
  summary: string;
  recommended_action: RepairQueueActionV1;
}

export interface HeartbeatPolicyAnomalyV1 {
  tenant_id: string;
  machine_id: string;
  anomaly_code: string;
  detected_at_rfc3339: string;
}

export type RolloutGovernanceStateV1 = "active" | "paused" | "recalled";

export interface CohortRolloutStageV1 {
  channel: string;
  cohort_label: string;
  tenant_count: number;
  machine_count: number;
  governance: RolloutGovernanceStateV1;
  paused_at_rfc3339: string | null;
}

export interface RolloutImpactPreviewV1 {
  release_id: string;
  affected_tenants: number;
  affected_machines: number;
  entitlement_channel_ok: boolean;
  known_blockers: string[];
}

export type RolloutFailureCategoryV1 =
  | "download"
  | "signature_verification"
  | "migration"
  | "post_deploy_heartbeat";

export interface RolloutDiagnosticsBucketV1 {
  category: RolloutFailureCategoryV1;
  count_24h: number;
  last_event_rfc3339: string | null;
  sample_correlation_ids: string[];
}

export type PlatformServiceKindV1 =
  | "api"
  | "workers"
  | "postgresql"
  | "redis"
  | "object_storage"
  | "admin_ui";

export interface PlatformServiceStatusV1 {
  service: PlatformServiceKindV1;
  severity: SyncHealthSeverityV1;
  detail: string;
}

export interface InfrastructurePressureV1 {
  metric_code: string;
  value: number;
  unit: string;
  threshold_hint: string;
  trend: string;
}

export type OpsAlertStateV1 = "open" | "acknowledged" | "resolved";

export interface IncidentDrillThroughRefsV1 {
  tenant_id_hint?: string;
  sync_batch_id?: string;
  rollout_release_id?: string;
  correlation_id?: string;
}

export interface OpsAlertV1 {
  alert_id: string;
  title: string;
  severity: SyncHealthSeverityV1;
  state: OpsAlertStateV1;
  owner_actor_id: string | null;
  acknowledged_at_rfc3339: string | null;
  notes: string[];
  drill_refs: IncidentDrillThroughRefsV1;
}

// ─── Vendor audit, support, hardening (aligns with vps::audit_support_hardening) ───

export type VendorAdminAuditActionCategoryV1 =
  | "auth_session"
  | "entitlement"
  | "machine"
  | "sync_repair"
  | "rollout_intervention"
  | "platform_override"
  | "support_intervention";

export interface AuditEntityRefsV1 {
  tenant_id?: string;
  entitlement_id?: string;
  machine_id?: string;
  sync_batch_id?: string;
  release_id?: string;
  incident_id?: string;
  support_ticket_id?: string;
}

export interface VendorAdminAuditRecordV1 {
  record_id: string;
  sequence: number;
  occurred_at_rfc3339: string;
  actor_id: string;
  action_code: string;
  action_category: VendorAdminAuditActionCategoryV1;
  correlation_id: string;
  scope_tenant_id: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  payload_canonical_sha256: string;
  chain_prev_hash: string | null;
  record_integrity_sha256: string;
  reason_code: string | null;
  approval_correlation_id: string | null;
  entity_refs: AuditEntityRefsV1;
}

export type SupportTicketStateV1 =
  | "new"
  | "triaged"
  | "waiting_for_vendor"
  | "waiting_for_customer"
  | "resolved"
  | "closed";

export interface SupportTicketV1 {
  ticket_id: string;
  tenant_id: string;
  state: SupportTicketStateV1;
  severity: SyncHealthSeverityV1;
  affected_module: string;
  sync_status_hint: string;
  app_version_reported: string;
  linked_incident_ids: string[];
  linked_audit_record_ids: string[];
  sla_due_rfc3339: string | null;
  created_at_rfc3339: string;
}

export interface DiagnosticArtifactRefV1 {
  logical_path: string;
  sha256: string;
  kind: string;
}

export interface DiagnosticBundleManifestV1 {
  bundle_id: string;
  created_at_rfc3339: string;
  redaction_profile: string;
  artifacts: DiagnosticArtifactRefV1[];
}

export interface OfflineTicketReconciliationRowV1 {
  desktop_queue_id: string;
  vendor_ticket_id: string | null;
  sync_state: string;
  duplicate_of: string | null;
}

export type IncidentRunbookIdV1 =
  | "heartbeat_outage"
  | "sync_backlog_surge"
  | "failed_rollout"
  | "storage_pressure"
  | "key_rotation";

export interface IncidentRunbookEntryV1 {
  runbook_id: IncidentRunbookIdV1;
  title: string;
  summary: string;
  first_steps: string[];
}

export type ComplianceExportKindV1 =
  | "entitlement_history"
  | "machine_state_timeline"
  | "rollout_actions"
  | "support_resolution_chronology";

export interface AuditReadinessCheckItemV1 {
  code: string;
  description: string;
  passed: boolean;
}

export type VpsMirrorQueueKind =
  | "push_ingestion"
  | "pull_materialization"
  | "restore_preparation"
  | "replay_repair"
  | "conflict_review"
  | "dead_letter";

export type VpsMirrorRecordClass = "append_only_event" | "governed_snapshot" | "mutable_operational";

export interface VpsTenantProvisioningPlan {
  tenant_id: string;
  schema_name: string;
  baseline_migrations: string[];
  required_invariants: string[];
}

export interface VpsMirrorQueueJob {
  job_id: string;
  tenant_id: string;
  target_schema: string;
  queue_kind: VpsMirrorQueueKind;
  idempotency_key: string;
  checkpoint_token: string | null;
  record_class: VpsMirrorRecordClass;
  merge_key: string;
  local_row_version: number;
  incoming_row_version: number;
  attempt: number;
  injected_failure_code: string | null;
}

export interface VpsMirrorWorkerConfig {
  max_batch_size: number;
  max_retry_attempts: number;
  tenant_fairness_quantum: number;
  tenant_lag_alert_threshold: number;
}

export interface VpsMirrorWorkerMetrics {
  queue_depth_by_kind: Record<string, number>;
  retry_count: number;
  dead_letter_count: number;
  conflict_queue_count: number;
  per_tenant_processed: Record<string, number>;
  per_tenant_lag: Record<string, number>;
}

// VPS object storage / backups (control plane + tenant mirror)

export type VpsDeploymentEnvironment = "dev" | "staging" | "pilot" | "prod";

export type VpsObjectCategory = "updates" | "backups" | "restore-bundles" | "support";

export type VpsStorageDataClass = "rollout_ephemeral" | "backup_operational" | "compliance_archive" | "support_export";

export interface VpsObjectStorageObjectKey {
  full_key: string;
  environment: VpsDeploymentEnvironment;
  category: VpsObjectCategory;
  data_class: VpsStorageDataClass;
}

export interface VpsObjectStorageSecretRef {
  ref_kind: string;
  ref_name: string;
}

export interface VpsBackupManifestPart {
  object_key: string;
  sha256: string;
  byte_length: number;
}

export interface VpsBackupManifestV1 {
  manifest_version: number;
  snapshot_id: string;
  created_at_rfc3339: string;
  environment: string;
  payload_sha256: string;
  parts: VpsBackupManifestPart[];
}

export type VpsBackupScope =
  | { kind: "control_plane" }
  | { kind: "tenant_mirror"; tenant_id: string };

export type VpsBackupVerifyStatus = "pending" | "verified" | "failed";

export interface VpsBackupCatalogRecord {
  snapshot_id: string;
  scope: VpsBackupScope;
  started_at_rfc3339: string;
  completed_at_rfc3339: string | null;
  sha256_manifest: string;
  encryption_context: string;
  retention_class: VpsStorageDataClass;
  verify_status: VpsBackupVerifyStatus;
  pitr_wal_archive_ok: boolean | null;
}

export interface VpsQueueHealthSnapshot {
  max_sync_queue_depth_threshold: number;
  current_max_depth: number;
}

export interface VpsRestoreRunbook {
  title: string;
  scope: string;
  prerequisites: string[];
  rpo_hours: number;
  rto_hours: number;
  steps: string[];
}

export interface VpsPostRestoreValidationChecklist {
  entitlement_heartbeat_ok: boolean;
  sync_checkpoint_continuous: boolean;
  admin_audit_read_ok: boolean;
  update_manifest_integrity_ok: boolean;
}

export interface VpsRestoreDrillEvidence {
  drill_id: string;
  drill_type: string;
  started_at_rfc3339: string;
  completed_at_rfc3339: string;
  seconds_to_restore: number;
  checklist: VpsPostRestoreValidationChecklist;
  residual_issues: string[];
}

// VPS deployment observability and recovery (PRD section 16)

export type VpsComposeServiceRole =
  | "nginx_edge"
  | "api"
  | "worker"
  | "postgres"
  | "redis"
  | "admin_ui"
  | "object_storage_sidecar"
  | "observability_agent";

export interface VpsProductionDnsBoundaries {
  tenant_runtime_api_hostname_example: string;
  vendor_admin_console_hostname_example: string;
}

export type VpsNetworkExposureTier =
  | "public_https_edge"
  | "internal_services"
  | "ops_restricted_ssh";

export interface VpsNetworkSegmentRule {
  from_tier: VpsNetworkExposureTier;
  to_tier: VpsNetworkExposureTier;
  allowed: boolean;
  note: string;
}

export type VpsSecretInjectionStrategy =
  | "environment_reference"
  | "runtime_secret_store"
  | "kms_envelope";

export interface VpsSecretHandlingContract {
  strategy: VpsSecretInjectionStrategy;
  reference_var_names: string[];
  forbid_plaintext_in_compose: boolean;
  rotate_after_exposure: boolean;
}

export type VpsDeploymentSizingProfile =
  | "pilot"
  | "shared_production"
  | "growth";

export interface VpsResourceSizingHints {
  api_replicas: number;
  worker_replicas: number;
  postgres_cpu_units: number;
  postgres_memory_gb: number;
  redis_memory_gb: number;
  recommended_connection_pool_api: number;
}

export type VpsDeployPreflightKind =
  | "db_migration_readiness"
  | "queue_drain_policy"
  | "artifact_integrity_verified"
  | "secret_refs_resolvable"
  | "slo_baseline_healthy";

export interface VpsDeployPreflightItem {
  kind: VpsDeployPreflightKind;
  description: string;
  blocking: boolean;
}

export interface VpsStructuredLogContractV1 {
  schema_version: number;
  required_fields: string[];
}

export interface VpsControlPlaneSlo {
  slo_id: string;
  description: string;
  target_ratio: number;
  window_days: number;
  metric_keys: string[];
}

export interface VpsSloAlertThreshold {
  slo_id: string;
  alert_window_minutes: number;
  threshold_description: string;
}

export interface VpsTenantHealthIndicators {
  tenant_id: string;
  heartbeat_success_ratio_24h: number;
  sync_queue_lag_ms_p95: number;
  rollout_download_failure_count_24h: number;
  worker_retry_count_24h: number;
  worker_dead_letter_count_24h: number;
  degraded: boolean;
}

export type VpsIncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";

export interface VpsOnCallRoutingContract {
  severity_map: [VpsIncidentSeverity, string][];
  ack_required_within_minutes: number;
  escalation_note: string;
}

export type VpsRecoveryDrillCategory =
  | "control_plane_metadata_restore"
  | "tenant_mirror_restore"
  | "update_artifact_recovery";

export interface VpsRecoveryValidationEvidence {
  drill_id: string;
  category: VpsRecoveryDrillCategory;
  completed_at_rfc3339: string;
  post_restore: VpsPostRestoreValidationChecklist;
  notes: string;
}

export interface VpsFailureInjectionScenario {
  scenario_id: string;
  title: string;
  operator_response_steps: string[];
}

export interface VpsDeploymentReadinessChecklist {
  dr_drills_evidence_present: boolean;
  failure_scenarios_documented: boolean;
  post_restore_entitlement_sync_validated: boolean;
  cert_and_key_runbooks_acknowledged: boolean;
  all_items_ok: boolean;
}


// â”€â”€â”€ Locale â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface LocalePreference {
  active_locale: string;
  user_locale: string | null;
  tenant_locale: string | null;
  os_locale: string | null;
  supported_locales: string[];
}

// â”€â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AppSetting {
  id: number;
  setting_key: string;
  setting_scope: string;
  setting_value_json: string;
  category: string;
  setting_risk: "low" | "high";
  validation_status: "valid" | "draft" | "error" | "untested";
  secret_ref_id: number | null;
  last_modified_by_id: number | null;
  last_modified_at: string;
}

export interface PolicySnapshot {
  id: number;
  policy_domain: string;
  version_no: number;
  snapshot_json: string;
  is_active: boolean;
  activated_at: string | null;
  activated_by_id: number | null;
}

export interface PolicyTestResult {
  rule_name: string;
  severity: "pass" | "warn" | "fail";
  message: string;
}

export interface SavePolicyDraftPayload {
  domain: string;
  snapshot_json: string;
}

export interface ActivatePolicyPayload {
  domain: string;
  snapshot_id: number;
}

export interface SessionPolicy {
  idle_timeout_minutes: number;
  absolute_session_minutes: number;
  offline_grace_hours: number;
  step_up_window_minutes: number;
  max_failed_attempts: number;
  lockout_minutes: number;
}

export interface SettingsChangeEvent {
  id: number;
  setting_key_or_domain: string;
  change_summary: string;
  old_value_hash: string | null;
  new_value_hash: string | null;
  changed_by_id: number | null;
  changed_at: string;
  required_step_up: boolean;
  apply_result: string;
}

// â”€â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface NotificationSummary {
  id: number;
  title: string;
  body: string | null;
  category_code: string;
  severity: string;
  delivery_state: string;
  created_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
  action_url: string | null;
  escalation_level: number;
  requires_ack: boolean;
}

export interface NotificationFilterInput {
  delivery_state?: string;
  category_code?: string;
  limit?: number;
  offset?: number;
}

export interface UserPreferenceRow {
  category_code: string;
  label: string;
  is_user_configurable: boolean;
  in_app_enabled: boolean;
  os_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  digest_mode: string;
  muted_until: string | null;
}

export interface NotificationRuleDetail {
  id: number;
  category_code: string;
  category_label: string;
  routing_mode: string;
  requires_ack: boolean;
  dedupe_window_minutes: number;
  quiet_hours_policy_json: string | null;
  escalation_policy_id: number | null;
  escalation_policy_name: string | null;
  is_active: boolean;
}

export interface NotificationCategory {
  id: number;
  code: string;
  label: string;
  default_severity: string;
  default_requires_ack: boolean;
  is_user_configurable: boolean;
}

// â”€â”€â”€ Archive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ArchiveFilterInput {
  source_module?: string;
  archive_class?: string;
  legal_hold?: boolean;
  search_text?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface ArchiveItemSummary {
  id: number;
  source_module: string;
  source_record_id: string;
  archive_class: string;
  source_state: string | null;
  archive_reason_code: string;
  archived_at: string;
  archived_by_id: number | null;
  retention_policy_id: number | null;
  restore_policy: string;
  restore_until_at: string | null;
  legal_hold: boolean;
  checksum_sha256: string | null;
  search_text: string | null;
}

export interface ArchivePayloadRow {
  id: number;
  archive_item_id: number;
  payload_json: unknown;
  workflow_history_json: string | null;
  attachment_manifest_json: string | null;
  config_version_refs_json: string | null;
  payload_size_bytes: number;
}

export interface ArchiveActionRow {
  id: number;
  archive_item_id: number;
  action: string;
  action_by_id: number | null;
  action_at: string;
  reason_note: string | null;
  result_status: string;
}

export interface RetentionPolicy {
  id: number;
  module_code: string;
  archive_class: string;
  retention_years: number;
  purge_mode: string;
  allow_restore: boolean;
  allow_purge: boolean;
  requires_legal_hold_check: boolean;
}

export interface ArchiveItemDetail {
  item: ArchiveItemSummary;
  payload: ArchivePayloadRow | null;
  actions: ArchiveActionRow[];
  retention_policy: RetentionPolicy | null;
  checksum_valid: boolean;
}

export interface RestoreInput {
  archive_item_id: number;
  reason_note: string;
}

export interface ArchiveRestoreResult {
  archive_item_id: number;
  restore_action_id: number;
  message: string;
}

export interface ExportInput {
  archive_item_ids: number[];
  export_reason?: string;
}

export interface ExportedArchivePayload {
  archive_item_id: number;
  source_module: string;
  source_record_id: string;
  archive_class: string;
  payload_json: unknown;
}

export interface ExportPayload {
  items: ExportedArchivePayload[];
}

export interface PurgeInput {
  archive_item_ids: number[];
  purge_reason: string;
}

export interface PurgeBlockedItem {
  archive_item_id: number;
  reason: string;
}

export interface PurgeResult {
  strict_mode: boolean;
  purged_item_ids: number[];
  blocked_items: PurgeBlockedItem[];
}

export interface LegalHoldInput {
  archive_item_id: number;
  enable: boolean;
  reason_note: string;
}

export interface UpdateRetentionInput {
  policy_id: number;
  retention_years?: number;
  purge_mode?: string;
  allow_restore?: boolean;
  allow_purge?: boolean;
  requires_legal_hold_check?: boolean;
}

// â”€â”€â”€ Updater â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface UpdateCheckResult {
  available: boolean;
  version: string | null;
  notes: string | null;
  pub_date: string | null;
}

// â”€â”€â”€ Diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface IntegrityIssue {
  code: string;
  description: string;
  is_auto_repairable: boolean;
  subject: string;
}

export interface IntegrityReport {
  is_healthy: boolean;
  is_recoverable: boolean;
  issues: IntegrityIssue[];
  seed_schema_version: number | null;
  domain_count: number;
  value_count: number;
}

export interface DiagnosticsAppInfo {
  app_version: string;
  os_name: string;
  os_version: string;
  arch: string;
  db_schema_version: number;
  active_locale: string;
  sync_status: string;
  uptime_seconds: number;
}

export interface SupportBundle {
  generated_at: string;
  app_info: DiagnosticsAppInfo;
  log_lines: string[];
  collection_warnings: string[];
  runbook_links?: string[];
}

// â”€â”€â”€ Backup & Restore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface BackupRunRecord {
  id: number;
  trigger: string;
  status: string;
  output_path: string;
  file_size_bytes: number | null;
  sha256_checksum: string | null;
  encryption_mode: string;
  db_schema_version: number | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  initiated_by_id: number | null;
}

export interface BackupRunResult {
  run_id: number;
  output_path: string;
  file_size_bytes: number;
  sha256_checksum: string;
  status: string;
}

export interface RestoreTestResult {
  backup_path: string;
  integrity_ok: boolean;
  stored_checksum: string | null;
  computed_checksum: string;
  checksum_match: boolean;
  integrity_check_output: string;
  warnings: string[];
}

// â”€â”€â”€ Organization â€” Structure Model & Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OrgStructureModel {
  id: number;
  sync_id: string;
  version_number: number;
  status: string;
  description: string | null;
  activated_at: string | null;
  activated_by_id: number | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgNodeType {
  id: number;
  sync_id: string;
  structure_model_id: number;
  code: string;
  label: string;
  icon_key: string | null;
  color: string | null;
  depth_hint: number | null;
  can_host_assets: boolean;
  can_own_work: boolean;
  can_carry_cost_center: boolean;
  can_aggregate_kpis: boolean;
  can_receive_permits: boolean;
  is_root_type: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgRelationshipRule {
  id: number;
  structure_model_id: number;
  parent_type_id: number;
  child_type_id: number;
  min_children: number | null;
  max_children: number | null;
  created_at: string;
  parent_type_label?: string | null;
  child_type_label?: string | null;
}

export interface CreateStructureModelPayload {
  description?: string | null;
}

export interface CreateOrgNodeTypePayload {
  structure_model_id: number;
  code: string;
  label: string;
  icon_key?: string;
  color?: string;
  depth_hint?: number;
  can_host_assets: boolean;
  can_own_work: boolean;
  can_carry_cost_center: boolean;
  can_aggregate_kpis: boolean;
  can_receive_permits: boolean;
  is_root_type: boolean;
}

export interface UpdateOrgNodeTypePayload {
  id: number;
  label?: string;
  icon_key?: string | null;
  color?: string | null;
  depth_hint?: number | null;
  can_host_assets?: boolean;
  can_own_work?: boolean;
  can_carry_cost_center?: boolean;
  can_aggregate_kpis?: boolean;
  can_receive_permits?: boolean;
}

export interface CreateRelationshipRulePayload {
  structure_model_id: number;
  parent_type_id: number;
  child_type_id: number;
  min_children?: number | null;
  max_children?: number | null;
}

// â”€â”€â”€ Organization â€” Equipment Assignment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OrgNodeEquipmentRow {
  id: number;
  asset_id_code: string;
  name: string;
  lifecycle_status: string;
  installed_at_node_id: number | null;
  current_node_name: string | null;
}

export interface AssignEquipmentPayload {
  equipment_id: number;
  node_id: number;
}

// â”€â”€â”€ Organization â€” Nodes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OrgNode {
  id: number;
  sync_id: string;
  code: string;
  name: string;
  node_type_id: number;
  parent_id: number | null;
  ancestor_path: string;
  depth: number;
  description: string | null;
  cost_center_code: string | null;
  external_reference: string | null;
  status: string;
  effective_from: string | null;
  effective_to: string | null;
  erp_reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  row_version: number;
  origin_machine_id: string | null;
  last_synced_checkpoint: string | null;
}

export interface OrgTreeRow {
  node: OrgNode;
  node_type_code: string;
  node_type_label: string;
  can_host_assets: boolean;
  can_own_work: boolean;
  can_carry_cost_center: boolean;
  can_aggregate_kpis: boolean;
  can_receive_permits: boolean;
  child_count: number;
}

export interface OrgNodeResponsibility {
  id: number;
  node_id: number;
  responsibility_type: string;
  person_id: number | null;
  team_id: number | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgEntityBinding {
  id: number;
  node_id: number;
  binding_type: string;
  external_system: string;
  external_id: string;
  is_primary: boolean;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
}

export interface CreateOrgNodePayload {
  code: string;
  name: string;
  node_type_id: number;
  parent_id?: number | null;
  description?: string | null;
  cost_center_code?: string | null;
  external_reference?: string | null;
  effective_from?: string | null;
  erp_reference?: string | null;
  notes?: string | null;
}

export interface UpdateOrgNodeMetadataPayload {
  node_id: number;
  name?: string;
  description?: string | null;
  cost_center_code?: string | null;
  external_reference?: string | null;
  erp_reference?: string | null;
  notes?: string | null;
  status?: string;
  expected_row_version: number;
}

export interface MoveOrgNodePayload {
  node_id: number;
  new_parent_id?: number | null;
  expected_row_version: number;
  effective_from?: string | null;
}

export interface AssignResponsibilityPayload {
  node_id: number;
  responsibility_type: string;
  person_id?: number | null;
  team_id?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface UpsertOrgEntityBindingPayload {
  node_id: number;
  binding_type: string;
  external_system: string;
  external_id: string;
  is_primary: boolean;
  valid_from?: string | null;
  valid_to?: string | null;
}

// â”€â”€â”€ Organization â€” Designer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OrgDesignerNodeRow {
  node_id: number;
  parent_id: number | null;
  ancestor_path: string;
  depth: number;
  code: string;
  name: string;
  status: string;
  row_version: number;
  node_type_id: number;
  node_type_code: string;
  node_type_label: string;
  can_host_assets: boolean;
  can_own_work: boolean;
  can_carry_cost_center: boolean;
  can_aggregate_kpis: boolean;
  can_receive_permits: boolean;
  child_count: number;
  active_responsibility_count: number;
  active_binding_count: number;
}

export interface OrgDesignerSnapshot {
  active_model_id: number | null;
  active_model_version: number | null;
  draft_model_id: number | null;
  nodes: OrgDesignerNodeRow[];
}

export interface OrgImpactDependencySummary {
  domain: string;
  status: string;
  count: number | null;
  note: string | null;
}

export interface OrgImpactPreview {
  action: "MoveNode" | "DeactivateNode" | "ReassignResponsibility";
  subject_node_id: number;
  affected_node_count: number;
  descendant_count: number;
  active_responsibility_count: number;
  active_binding_count: number;
  blockers: string[];
  warnings: string[];
  dependencies: OrgImpactDependencySummary[];
}

export interface PreviewOrgChangePayload {
  action: string;
  node_id: number;
  new_parent_id?: number | null;
  responsibility_type?: string | null;
  replacement_person_id?: number | null;
  replacement_team_id?: number | null;
}

// â”€â”€â”€ Organization â€” Governance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface OrgValidationIssue {
  code: string;
  severity: string;
  message: string;
  related_id: number | null;
}

export interface OrgPublishValidationResult {
  model_id: number;
  can_publish: boolean;
  issue_count: number;
  blocking_count: number;
  issues: OrgValidationIssue[];
  remap_count: number;
}

export interface OrgChangeEvent {
  id: number;
  entity_kind: string;
  entity_id: number | null;
  change_type: string;
  before_json: string | null;
  after_json: string | null;
  preview_summary_json: string | null;
  changed_by_id: number | null;
  changed_at: string;
  requires_step_up: boolean;
  apply_result: string;
}

// â”€â”€â”€ Reference Data â€” Core â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReferenceDomain {
  id: number;
  code: string;
  name: string;
  structure_type: string;
  governance_level: string;
  is_extendable: boolean;
  validation_rules_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReferenceDomainPayload {
  code: string;
  name: string;
  structure_type: string;
  governance_level: string;
  is_extendable?: boolean;
  validation_rules_json?: string | null;
}

export interface UpdateReferenceDomainPayload {
  name?: string;
  structure_type?: string;
  governance_level?: string;
  is_extendable?: boolean;
  validation_rules_json?: string | null;
}

export interface ReferenceSet {
  id: number;
  domain_id: number;
  version_no: number;
  status: string;
  effective_from: string | null;
  created_by_id: number | null;
  created_at: string;
  published_at: string | null;
}

export interface ReferenceValue {
  id: number;
  set_id: number;
  parent_id: number | null;
  code: string;
  label: string;
  description: string | null;
  sort_order: number | null;
  color_hex: string | null;
  icon_name: string | null;
  semantic_tag: string | null;
  external_code: string | null;
  is_active: boolean;
  metadata_json: string | null;
}

export interface CreateReferenceValuePayload {
  set_id: number;
  parent_id?: number | null;
  code: string;
  label: string;
  description?: string | null;
  sort_order?: number | null;
  color_hex?: string | null;
  icon_name?: string | null;
  semantic_tag?: string | null;
  external_code?: string | null;
  metadata_json?: string | null;
}

export interface UpdateReferenceValuePayload {
  label?: string;
  description?: string | null;
  sort_order?: number | null;
  color_hex?: string | null;
  icon_name?: string | null;
  semantic_tag?: string | null;
  external_code?: string | null;
  metadata_json?: string | null;
}

export interface ReferenceValueMigration {
  id: number;
  domain_id: number;
  from_value_id: number;
  to_value_id: number;
  reason_code: string | null;
  migrated_by_id: number | null;
  migrated_at: string;
}

export interface ReferenceUsageMigrationResult {
  migration: ReferenceValueMigration;
  source_value: ReferenceValue;
  target_value: ReferenceValue;
  remapped_references: number;
  source_deactivated: boolean;
}

// â”€â”€â”€ Reference Data â€” Aliases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReferenceAlias {
  id: number;
  reference_value_id: number;
  alias_label: string;
  locale: string;
  alias_type: string;
  is_preferred: boolean;
  created_at: string;
}

export interface CreateReferenceAliasPayload {
  reference_value_id: number;
  alias_label: string;
  locale: string;
  alias_type: string;
  is_preferred?: boolean;
}

export interface UpdateReferenceAliasPayload {
  alias_label?: string;
  locale?: string;
  alias_type?: string;
  is_preferred?: boolean;
}

// â”€â”€â”€ Reference Data â€” Import / Export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ImportRowMessage {
  category: string;
  severity: string;
  message: string;
}

export interface RefImportBatchSummary {
  id: number;
  domain_id: number;
  source_filename: string;
  source_sha256: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
  initiated_by_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RefImportRow {
  id: number;
  batch_id: number;
  row_no: number;
  raw_json: string;
  normalized_code: string | null;
  validation_status: string;
  messages: ImportRowMessage[];
  proposed_action: string | null;
}

export interface RefImportPreview {
  batch: RefImportBatchSummary;
  rows: RefImportRow[];
}

export interface ImportRowInput {
  code?: string | null;
  label?: string | null;
  description?: string | null;
  parent_code?: string | null;
  sort_order?: number | null;
  color_hex?: string | null;
  icon_name?: string | null;
  semantic_tag?: string | null;
  external_code?: string | null;
  metadata_json?: string | null;
}

export interface RefImportApplyPolicy {
  include_warnings: boolean;
  target_set_id: number;
}

export interface RefImportApplyResult {
  batch: RefImportBatchSummary;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
}

export interface RefExportRow {
  value: ReferenceValue;
  aliases: ReferenceAlias[];
}

export interface RefExportResult {
  domain: ReferenceDomain;
  set: ReferenceSet;
  rows: RefExportRow[];
}

// â”€â”€â”€ Reference Data â€” Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReferenceSearchHit {
  value_id: number;
  code: string;
  label: string;
  matched_text: string;
  match_source: string;
  alias_type: string | null;
  rank: number;
}

// â”€â”€â”€ Reference Data â€” Publish Governance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReferencePublishIssue {
  check: string;
  message: string;
  severity: string;
}

export interface ReferencePublishReadiness {
  set_id: number;
  domain_id: number;
  is_ready: boolean;
  is_protected: boolean;
  issues: ReferencePublishIssue[];
  impact_preview_required: boolean;
  impact_preview_available: boolean;
}

export interface ModuleImpact {
  module: string;
  status: string;
  affected_count: number;
  details: string | null;
}

export interface ReferenceImpactSummary {
  set_id: number;
  domain_id: number;
  domain_code: string;
  total_affected: number;
  dimensions: ModuleImpact[];
  computed_at: string;
}

export interface ReferencePublishResult {
  set: ReferenceSet;
  superseded_set_id: number | null;
  readiness: ReferencePublishReadiness;
}

// â”€â”€â”€ Asset â€” Identity & Hierarchy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface Asset {
  id: number;
  sync_id: string;
  asset_code: string;
  asset_name: string;
  class_id: number | null;
  class_code: string | null;
  class_name: string | null;
  family_code: string | null;
  family_name: string | null;
  criticality_value_id: number | null;
  criticality_code: string | null;
  status_code: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  maintainable_boundary: boolean;
  org_node_id: number | null;
  org_node_name: string | null;
  commissioned_at: string | null;
  decommissioned_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  row_version: number;
}

export interface AssetHierarchyRow {
  relation_id: number;
  parent_asset_id: number;
  child_asset_id: number;
  relation_type: string;
  effective_from: string | null;
  effective_to: string | null;
}

export interface CreateAssetPayload {
  asset_code: string;
  asset_name: string;
  class_code: string;
  family_code?: string | null;
  criticality_code: string;
  status_code: string;
  manufacturer?: string | null;
  model?: string | null;
  serial_number?: string | null;
  maintainable_boundary: boolean;
  org_node_id: number;
  commissioned_at?: string | null;
}

export interface UpdateAssetIdentityPayload {
  asset_name?: string;
  class_code?: string;
  family_code?: string | null;
  criticality_code?: string;
  status_code?: string;
  manufacturer?: string | null;
  model?: string | null;
  serial_number?: string | null;
  maintainable_boundary?: boolean;
  commissioned_at?: string | null;
  decommissioned_at?: string | null;
}

export interface LinkAssetPayload {
  parent_asset_id: number;
  child_asset_id: number;
  relation_type: string;
  effective_from?: string | null;
}

// â”€â”€â”€ Asset â€” Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AssetLifecycleEvent {
  id: number;
  sync_id: string;
  asset_id: number;
  event_type: string;
  event_at: string;
  from_org_node_id: number | null;
  to_org_node_id: number | null;
  from_status_code: string | null;
  to_status_code: string | null;
  from_class_code: string | null;
  to_class_code: string | null;
  related_asset_id: number | null;
  reason_code: string | null;
  notes: string | null;
  approved_by_id: number | null;
  created_by_id: number | null;
  created_at: string;
}

export interface RecordLifecycleEventPayload {
  asset_id: number;
  event_type: string;
  event_at?: string | null;
  from_org_node_id?: number | null;
  to_org_node_id?: number | null;
  from_status_code?: string | null;
  to_status_code?: string | null;
  from_class_code?: string | null;
  to_class_code?: string | null;
  related_asset_id?: number | null;
  reason_code?: string | null;
  notes?: string | null;
  approved_by_id?: number | null;
}

export interface AssetMeter {
  id: number;
  sync_id: string;
  asset_id: number;
  name: string;
  meter_code: string | null;
  meter_type: string;
  unit: string | null;
  current_reading: number;
  last_read_at: string | null;
  expected_rate_per_day: number | null;
  rollover_value: number | null;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateAssetMeterPayload {
  asset_id: number;
  name: string;
  meter_code?: string | null;
  meter_type: string;
  unit?: string | null;
  initial_reading?: number | null;
  expected_rate_per_day?: number | null;
  rollover_value?: number | null;
  is_primary?: boolean;
}

export interface MeterReading {
  id: number;
  meter_id: number;
  reading_value: number;
  reading_at: string;
  source_type: string;
  source_reference: string | null;
  quality_flag: string;
  created_by_id: number | null;
  created_at: string;
}

export interface RecordMeterReadingPayload {
  meter_id: number;
  reading_value: number;
  reading_at?: string | null;
  source_type: string;
  source_reference?: string | null;
  quality_flag?: string;
}

export interface AssetDocumentLink {
  id: number;
  asset_id: number;
  document_ref: string;
  link_purpose: string;
  is_primary: boolean;
  valid_from: string | null;
  valid_to: string | null;
  created_by_id: number | null;
  created_at: string;
}

export interface UpsertDocumentLinkPayload {
  asset_id: number;
  document_ref: string;
  link_purpose: string;
  is_primary?: boolean;
  valid_from?: string | null;
}

export interface DomainBindingEntry {
  status: "available" | "not_implemented";
  count: number | null;
}

export interface AssetBindingSummary {
  asset_id: number;
  linked_di_count: DomainBindingEntry;
  linked_wo_count: DomainBindingEntry;
  linked_pm_plan_count: DomainBindingEntry;
  linked_failure_event_count: DomainBindingEntry;
  linked_document_count: DomainBindingEntry;
  linked_iot_signal_count: DomainBindingEntry;
  linked_erp_mapping_count: DomainBindingEntry;
}

// â”€â”€â”€ Asset â€” Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AssetSearchFilters {
  query?: string | null;
  classCodes?: string[] | null;
  familyCodes?: string[] | null;
  statusCodes?: string[] | null;
  orgNodeIds?: number[] | null;
  includeDecommissioned?: boolean;
  limit?: number | null;
}

export interface AssetSearchResult {
  id: number;
  sync_id: string;
  asset_code: string;
  asset_name: string;
  class_code: string | null;
  class_name: string | null;
  family_code: string | null;
  family_name: string | null;
  criticality_code: string | null;
  status_code: string;
  org_node_id: number | null;
  org_node_name: string | null;
  parent_asset_id: number | null;
  parent_asset_code: string | null;
  parent_asset_name: string | null;
  primary_meter_name: string | null;
  primary_meter_reading: number | null;
  primary_meter_unit: string | null;
  primary_meter_last_read_at: string | null;
  external_id_count: number;
  row_version: number;
}

export interface AssetSuggestion {
  id: number;
  asset_code: string;
  asset_name: string;
  status_code: string;
}

// â”€â”€â”€ Asset â€” Import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ValidationMessage {
  category: string;
  severity: string;
  message: string;
}

export interface ImportBatchSummary {
  id: number;
  source_filename: string;
  source_sha256: string;
  initiated_by_id: number | null;
  status: string;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
  created_at: string;
  updated_at: string;
}

export interface ImportPreviewRow {
  id: number;
  row_no: number;
  normalized_asset_code: string | null;
  normalized_external_key: string | null;
  validation_status: string;
  validation_messages: ValidationMessage[];
  proposed_action: string | null;
  raw_json: string;
}

export interface ImportPreview {
  batch: ImportBatchSummary;
  rows: ImportPreviewRow[];
}

export interface ApplyPolicy {
  include_warnings: boolean;
  external_system_code?: string | null;
}

export interface ApplyResult {
  batch: ImportBatchSummary;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
}

// â”€â”€â”€ Inventory (PRD Â§6.8) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ArticleFamily {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Warehouse {
  id: number;
  code: string;
  name: string;
  is_active: number;
  created_at: string;
}

export interface StockLocation {
  id: number;
  warehouse_id: number;
  warehouse_code: string;
  code: string;
  name: string;
  is_default: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface CreateWarehouseInput {
  code: string;
  name: string;
}

export interface UpdateWarehouseInput {
  name?: string | null;
  is_active?: boolean | null;
}

export interface CreateStockLocationInput {
  warehouse_id: number;
  code: string;
  name: string;
  is_default?: boolean | null;
}

export interface UpdateStockLocationInput {
  code?: string | null;
  name?: string | null;
  is_default?: boolean | null;
  is_active?: boolean | null;
}

/** Result of inventory valuation policy evaluation (WO part costing, procurement projections). */
export interface ValuationCostResult {
  unit_cost: number;
  currency_value_id: number;
  source_type: string;
  source_ref: string | null;
  effective_at: string;
  is_provisional: boolean;
  confidence: string;
}

export interface InventoryArticle {
  id: number;
  article_code: string;
  article_name: string;
  family_id: number | null;
  family_code: string | null;
  family_name: string | null;
  unit_value_id: number;
  unit_code: string;
  unit_label: string;
  criticality_value_id: number | null;
  criticality_code: string | null;
  criticality_label: string | null;
  stocking_type_value_id: number;
  stocking_type_code: string;
  stocking_type_label: string;
  tax_category_value_id: number;
  tax_category_code: string;
  tax_category_label: string;
  procurement_category_value_id: number | null;
  procurement_category_code: string | null;
  procurement_category_label: string | null;
  preferred_warehouse_id: number | null;
  preferred_warehouse_code: string | null;
  preferred_location_id: number | null;
  preferred_location_code: string | null;
  min_stock: number;
  max_stock: number | null;
  reorder_point: number;
  safety_stock: number;
  is_active: number;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryStockBalance {
  id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  warehouse_code: string;
  location_id: number;
  location_code: string;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  updated_at: string;
}

export interface CreateArticleFamilyInput {
  code: string;
  name: string;
  description?: string | null;
}

export interface UpdateArticleFamilyInput {
  code: string;
  name: string;
  description?: string | null;
  is_active?: boolean;
}

export interface InventoryTaxCategory {
  id: number;
  code: string;
  label: string;
  fr_label: string | null;
  en_label: string | null;
  description: string | null;
  sort_order: number;
  is_active: number;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryTaxCategoryInput {
  code: string;
  label: string;
  fr_label?: string | null;
  en_label?: string | null;
  description?: string | null;
}

export interface InventoryArticleInput {
  article_code: string;
  article_name: string;
  family_id?: number | null;
  unit_value_id: number;
  criticality_value_id?: number | null;
  stocking_type_value_id: number;
  tax_category_value_id: number;
  procurement_category_value_id?: number | null;
  preferred_warehouse_id?: number | null;
  preferred_location_id?: number | null;
  min_stock: number;
  max_stock?: number | null;
  reorder_point: number;
  safety_stock: number;
  is_active?: boolean;
}

export interface InventoryArticleFilter {
  search?: string | null;
}

export interface InventoryStockFilter {
  article_id?: number | null;
  warehouse_id?: number | null;
  low_stock_only?: boolean;
}

export interface InventoryStockAdjustInput {
  article_id: number;
  location_id: number;
  delta_qty: number;
  reason?: string | null;
}

export interface InventoryTransaction {
  id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  warehouse_code: string;
  location_id: number;
  location_code: string;
  reservation_id: number | null;
  movement_type: string;
  quantity: number;
  source_type: string;
  source_id: number | null;
  source_ref: string | null;
  reason: string | null;
  performed_by_id: number | null;
  performed_at: string;
}

export interface StockReservation {
  id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  warehouse_code: string;
  location_id: number;
  location_code: string;
  source_type: string;
  source_id: number | null;
  source_ref: string | null;
  quantity_reserved: number;
  quantity_issued: number;
  status: string;
  notes: string | null;
  created_by_id: number | null;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

export interface InventoryTransactionFilter {
  article_id?: number | null;
  warehouse_id?: number | null;
  source_type?: string | null;
  source_id?: number | null;
  limit?: number | null;
}

export interface StockReservationFilter {
  article_id?: number | null;
  warehouse_id?: number | null;
  source_type?: string | null;
  source_id?: number | null;
  include_inactive?: boolean;
}

export interface InventoryReserveInput {
  article_id: number;
  location_id: number;
  quantity: number;
  source_type: string;
  source_id?: number | null;
  source_ref?: string | null;
  notes?: string | null;
}

export interface InventoryIssueInput {
  reservation_id: number;
  quantity: number;
  source_type?: string | null;
  source_id?: number | null;
  source_ref?: string | null;
  notes?: string | null;
}

export interface InventoryReturnInput {
  reservation_id: number;
  quantity: number;
  notes?: string | null;
}

export interface InventoryTransferInput {
  article_id: number;
  from_location_id: number;
  to_location_id: number;
  quantity: number;
  source_type?: string | null;
  source_id?: number | null;
  source_ref?: string | null;
  notes?: string | null;
}

export interface InventoryReleaseReservationInput {
  reservation_id: number;
  notes?: string | null;
}

export interface InventoryReorderRecommendation {
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  warehouse_code: string;
  min_stock: number;
  reorder_point: number;
  max_stock: number | null;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  suggested_reorder_qty: number;
  trigger_type: string;
}

export interface ProcurementSupplier {
  id: number;
  company_code: string;
  company_name: string;
  is_active: number;
}

export interface ProcurementRequisition {
  id: number;
  req_number: string;
  demand_source_type: string;
  demand_source_id: number | null;
  demand_source_ref: string | null;
  status: string;
  posting_state: string;
  posting_error: string | null;
  requested_by_id: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface ProcurementRequisitionLine {
  id: number;
  requisition_id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  preferred_location_id: number | null;
  preferred_location_code: string | null;
  requested_qty: number;
  source_reservation_id: number | null;
  source_reorder_trigger: string | null;
  status: string;
  created_at: string;
}

export interface CreateProcurementRequisitionInput {
  article_id: number;
  preferred_location_id?: number | null;
  requested_qty: number;
  demand_source_type: string;
  demand_source_id?: number | null;
  demand_source_ref?: string | null;
  source_reservation_id?: number | null;
  source_reorder_trigger?: string | null;
  reason?: string | null;
  actor_id?: number | null;
}

export interface TransitionProcurementRequisitionInput {
  requisition_id: number;
  expected_row_version: number;
  next_status: string;
  reason?: string | null;
  note?: string | null;
  actor_id?: number | null;
}

export interface PurchaseOrder {
  id: number;
  po_number: string;
  requisition_id: number | null;
  supplier_company_id: number | null;
  supplier_company_name: string | null;
  status: string;
  posting_state: string;
  posting_error: string | null;
  ordered_by_id: number | null;
  ordered_at: string | null;
  approved_by_id: number | null;
  approved_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderLine {
  id: number;
  purchase_order_id: number;
  requisition_line_id: number | null;
  article_id: number;
  article_code: string;
  article_name: string;
  ordered_qty: number;
  received_qty: number;
  unit_price: number | null;
  demand_source_type: string;
  demand_source_id: number | null;
  demand_source_ref: string | null;
  source_reservation_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePurchaseOrderFromRequisitionInput {
  requisition_id: number;
  supplier_company_id?: number | null;
  actor_id?: number | null;
}

export interface TransitionPurchaseOrderInput {
  purchase_order_id: number;
  expected_row_version: number;
  next_status: string;
  reason?: string | null;
  note?: string | null;
  actor_id?: number | null;
}

export interface GoodsReceipt {
  id: number;
  gr_number: string;
  purchase_order_id: number;
  status: string;
  posting_state: string;
  posting_error: string | null;
  received_by_id: number | null;
  received_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface GoodsReceiptLine {
  id: number;
  goods_receipt_id: number;
  po_line_id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  location_id: number;
  location_code: string;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  rejection_reason: string | null;
  status: string;
  created_at: string;
}

export interface ReceivePurchaseOrderLineInput {
  po_line_id: number;
  article_id: number;
  location_id: number;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  rejection_reason?: string | null;
}

export interface ReceiveGoodsInput {
  purchase_order_id: number;
  lines: ReceivePurchaseOrderLineInput[];
  actor_id?: number | null;
}

export interface UpdatePostingStateInput {
  entity_type: string;
  entity_id: number;
  posting_state: string;
  posting_error?: string | null;
}

export interface RepairableOrder {
  id: number;
  order_code: string;
  article_id: number;
  article_code: string;
  article_name: string;
  quantity: number;
  source_location_id: number;
  source_location_code: string;
  return_location_id: number | null;
  return_location_code: string | null;
  linked_po_line_id: number | null;
  linked_reservation_id: number | null;
  status: string;
  reason: string | null;
  created_by_id: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateRepairableOrderInput {
  article_id: number;
  quantity: number;
  source_location_id: number;
  return_location_id?: number | null;
  linked_po_line_id?: number | null;
  linked_reservation_id?: number | null;
  reason?: string | null;
  actor_id?: number | null;
}

export interface TransitionRepairableOrderInput {
  order_id: number;
  expected_row_version: number;
  next_status: string;
  reason?: string | null;
  note?: string | null;
  actor_id?: number | null;
  return_location_id?: number | null;
}

export interface InventoryStateEvent {
  id: number;
  entity_type: string;
  entity_id: number;
  from_status: string | null;
  to_status: string;
  actor_id: number | null;
  reason: string | null;
  note: string | null;
  changed_at: string;
}

export interface InventoryCountSession {
  id: number;
  session_code: string;
  warehouse_id: number;
  location_id: number | null;
  status: string;
  critical_abs_threshold: number;
  submitted_by_id: number | null;
  submitted_at: string | null;
  posted_by_id: number | null;
  posted_at: string | null;
  reversed_by_id: number | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryCountLine {
  id: number;
  session_id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  location_id: number;
  location_code: string;
  system_qty: number;
  counted_qty: number;
  variance_qty: number;
  variance_reason_code: string | null;
  is_critical: number;
  approval_required: number;
  approved_by_id: number | null;
  approved_at: string | null;
  approval_note: string | null;
  posted_transaction_id: number | null;
  reversed_transaction_id: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateInventoryCountSessionInput {
  warehouse_id: number;
  location_id?: number | null;
  critical_abs_threshold?: number;
  actor_id?: number | null;
}

export interface UpsertInventoryCountLineInput {
  session_id: number;
  article_id: number;
  location_id: number;
  counted_qty: number;
  variance_reason_code?: string | null;
}

export interface TransitionInventoryCountSessionInput {
  session_id: number;
  expected_row_version: number;
  next_status: string;
  reason?: string | null;
  actor_id?: number | null;
}

export interface ApproveInventoryCountLineInput {
  line_id: number;
  expected_row_version: number;
  reviewer_id: number;
  reviewer_evidence: string;
}

export interface PostInventoryCountSessionInput {
  session_id: number;
  expected_row_version: number;
  actor_id?: number | null;
}

export interface ReverseInventoryCountSessionInput {
  session_id: number;
  expected_row_version: number;
  reason: string;
  actor_id?: number | null;
}

export interface InventoryReconciliationRun {
  id: number;
  run_code: string;
  run_date: string;
  status: string;
  checked_rows: number;
  drift_rows: number;
  checked_by_id: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface InventoryReconciliationFinding {
  id: number;
  run_id: number;
  article_id: number;
  article_code: string;
  article_name: string;
  warehouse_id: number;
  warehouse_code: string;
  location_id: number;
  location_code: string;
  balance_on_hand: number;
  ledger_expected_on_hand: number;
  drift_qty: number;
  is_break: number;
  created_at: string;
}

export interface RunInventoryReconciliationInput {
  actor_id?: number | null;
  drift_break_threshold?: number;
}

// â”€â”€â”€ Preventive Maintenance (PRD Â§6.9) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PmPlan {
  id: number;
  code: string;
  title: string;
  description: string | null;
  asset_scope_type: string;
  asset_scope_id: number | null;
  strategy_type: string;
  criticality_value_id: number | null;
  criticality_code: string | null;
  criticality_label: string | null;
  assigned_group_id: number | null;
  requires_shutdown: number;
  requires_permit: number;
  is_active: number;
  lifecycle_status: string;
  current_version_id: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface PmPlanVersion {
  id: number;
  pm_plan_id: number;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  trigger_definition_json: string;
  task_package_json: string | null;
  required_parts_json: string | null;
  required_skills_json: string | null;
  required_tools_json: string | null;
  estimated_duration_hours: number | null;
  estimated_labor_cost: number | null;
  estimated_parts_cost: number | null;
  estimated_service_cost: number | null;
  change_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface PmPlanFilter {
  search?: string | null;
  strategy_type?: string | null;
  lifecycle_status?: string | null;
  is_active?: boolean | null;
}

export interface CreatePmPlanInput {
  code: string;
  title: string;
  description?: string | null;
  asset_scope_type: string;
  asset_scope_id?: number | null;
  strategy_type: string;
  criticality_value_id?: number | null;
  assigned_group_id?: number | null;
  requires_shutdown: boolean;
  requires_permit: boolean;
  is_active?: boolean;
}

export interface UpdatePmPlanInput {
  title?: string | null;
  description?: string | null;
  asset_scope_type?: string | null;
  asset_scope_id?: number | null;
  strategy_type?: string | null;
  criticality_value_id?: number | null;
  assigned_group_id?: number | null;
  requires_shutdown?: boolean | null;
  requires_permit?: boolean | null;
  is_active?: boolean | null;
}

export interface TransitionPmPlanLifecycleInput {
  plan_id: number;
  expected_row_version: number;
  next_status: string;
}

export interface CreatePmPlanVersionInput {
  effective_from: string;
  effective_to?: string | null;
  trigger_definition_json: string;
  task_package_json?: string | null;
  required_parts_json?: string | null;
  required_skills_json?: string | null;
  required_tools_json?: string | null;
  estimated_duration_hours?: number | null;
  estimated_labor_cost?: number | null;
  estimated_parts_cost?: number | null;
  estimated_service_cost?: number | null;
  change_reason?: string | null;
}

export interface UpdatePmPlanVersionInput {
  effective_from?: string | null;
  effective_to?: string | null;
  trigger_definition_json?: string | null;
  task_package_json?: string | null;
  required_parts_json?: string | null;
  required_skills_json?: string | null;
  required_tools_json?: string | null;
  estimated_duration_hours?: number | null;
  estimated_labor_cost?: number | null;
  estimated_parts_cost?: number | null;
  estimated_service_cost?: number | null;
  change_reason?: string | null;
}

export interface PublishPmPlanVersionInput {
  version_id: number;
  expected_row_version: number;
}
export interface PmOccurrence {
  id: number;
  pm_plan_id: number;
  plan_version_id: number;
  due_basis: string;
  due_at: string | null;
  due_meter_value: number | null;
  generated_at: string;
  status: string;
  linked_work_order_id: number | null;
  linked_work_order_code: string | null;
  deferral_reason: string | null;
  missed_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
  plan_code: string | null;
  plan_title: string | null;
  strategy_type: string | null;
}

export interface PmOccurrenceFilter {
  pm_plan_id?: number | null;
  status?: string | null;
  due_from?: string | null;
  due_to?: string | null;
  include_completed?: boolean;
}

export interface GeneratePmOccurrencesInput {
  as_of?: string | null;
  horizon_days?: number | null;
  pm_plan_id?: number | null;
  event_codes?: string[] | null;
  condition_codes?: string[] | null;
}

export interface GeneratePmOccurrencesResult {
  generated_count: number;
  skipped_count: number;
  trigger_events_recorded: number;
  occurrence_ids: number[];
}

export interface TransitionPmOccurrenceInput {
  occurrence_id: number;
  expected_row_version: number;
  next_status: string;
  reason_code?: string | null;
  note?: string | null;
  generate_work_order?: boolean | null;
  work_order_type_id?: number | null;
  actor_id?: number | null;
}

export interface PmDueMetrics {
  as_of: string;
  overdue_count: number;
  due_today_count: number;
  due_next_7d_count: number;
  ready_for_scheduling_count: number;
}

export interface PmPlanningReadinessInput {
  pm_plan_id?: number | null;
  due_from?: string | null;
  due_to?: string | null;
  include_linked_work_orders?: boolean | null;
  limit?: number | null;
}

export interface PmPlanningReadinessBlocker {
  code: string;
  message: string;
  source: string;
}

export interface PmPlanningCandidate {
  occurrence: PmOccurrence;
  ready_for_scheduling: boolean;
  blockers: PmPlanningReadinessBlocker[];
}

export interface PmPlanningReadinessProjection {
  as_of: string;
  candidate_count: number;
  ready_count: number;
  blocked_count: number;
  derivation_rules: string[];
  candidates: PmPlanningCandidate[];
}

export interface PmExecution {
  id: number;
  pm_occurrence_id: number;
  work_order_id: number | null;
  work_order_code: string | null;
  execution_result: string;
  executed_at: string;
  notes: string | null;
  actor_id: number | null;
  actual_duration_hours: number | null;
  actual_labor_hours: number | null;
  created_at: string | null;
}

export interface PmFinding {
  id: number;
  pm_execution_id: number;
  finding_type: string;
  severity: string | null;
  description: string;
  follow_up_di_id: number | null;
  follow_up_work_order_id: number | null;
  follow_up_di_code: string | null;
  follow_up_work_order_code: string | null;
  created_at: string;
}

export interface PmExecutionFindingInput {
  finding_type: string;
  severity?: string | null;
  description: string;
  create_follow_up_di?: boolean | null;
  create_follow_up_work_order?: boolean | null;
  follow_up_work_order_type_id?: number | null;
}

export interface ExecutePmOccurrenceInput {
  occurrence_id: number;
  expected_occurrence_row_version: number;
  execution_result: string;
  note?: string | null;
  actor_id?: number | null;
  work_order_id?: number | null;
  defer_reason_code?: string | null;
  miss_reason_code?: string | null;
  findings?: PmExecutionFindingInput[] | null;
}

export interface ExecutePmOccurrenceResult {
  occurrence: PmOccurrence;
  execution: PmExecution;
  findings: PmFinding[];
}

export interface PmExecutionFilter {
  occurrence_id?: number | null;
  pm_plan_id?: number | null;
}

export interface PmRecurringFindingsInput {
  days_window?: number | null;
  min_occurrences?: number | null;
  pm_plan_id?: number | null;
}

export interface PmRecurringFinding {
  pm_plan_id: number;
  plan_code: string | null;
  finding_type: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  latest_severity: string | null;
}

export interface PmGovernanceKpiInput {
  from?: string | null;
  to?: string | null;
  pm_plan_id?: number | null;
  criticality_code?: string | null;
}

export interface PmRateKpi {
  numerator: number;
  denominator: number;
  value_pct: number | null;
  derivation: string;
}

export interface PmEffortVarianceKpi {
  sample_size: number;
  estimated_hours: number;
  actual_hours: number;
  variance_hours: number;
  variance_pct: number | null;
  derivation: string;
}

export interface PmGovernanceKpiReport {
  as_of: string;
  from: string;
  to: string;
  pm_plan_id: number | null;
  criticality_code: string | null;
  compliance: PmRateKpi;
  overdue_risk: PmRateKpi;
  first_pass_completion: PmRateKpi;
  follow_up_ratio: PmRateKpi;
  effort_variance: PmEffortVarianceKpi;
  derivation_rules: string[];
}

// â”€â”€â”€ Intervention Requests (DI) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type DiStatus =
  | "submitted"
  | "pending_review"
  | "returned_for_clarification"
  | "rejected"
  | "screened"
  | "awaiting_approval"
  | "approved_for_planning"
  | "deferred"
  | "converted_to_work_order"
  | "closed_as_non_executable"
  | "archived";

export type DiOriginType =
  | "operator"
  | "technician"
  | "inspection"
  | "pm"
  | "iot"
  | "quality"
  | "hse"
  | "production"
  | "external";

export type DiUrgency = "low" | "medium" | "high" | "critical";

export type DiImpactLevel = "unknown" | "none" | "minor" | "major" | "critical";

export interface InterventionRequest {
  id: number;
  code: string;
  asset_id: number;
  sub_asset_ref: string | null;
  org_node_id: number;
  status: DiStatus;
  title: string;
  description: string;
  origin_type: DiOriginType;
  symptom_code_id: number | null;
  impact_level: DiImpactLevel;
  production_impact: boolean;
  safety_flag: boolean;
  environmental_flag: boolean;
  quality_flag: boolean;
  reported_urgency: DiUrgency;
  validated_urgency: DiUrgency | null;
  observed_at: string | null;
  submitted_at: string;
  review_team_id: number | null;
  reviewer_id: number | null;
  screened_at: string | null;
  approved_at: string | null;
  deferred_until: string | null;
  declined_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
  converted_to_wo_id: number | null;
  converted_at: string | null;
  reviewer_note: string | null;
  classification_code_id: number | null;
  is_recurrence_flag: boolean;
  recurrence_di_id: number | null;
  is_modified: boolean;
  row_version: number;
  submitter_id: number;
  created_at: string;
  updated_at: string;
}

export interface DiListFilter {
  status?: string[] | null;
  asset_id?: number | null;
  org_node_id?: number | null;
  submitter_id?: number | null;
  reviewer_id?: number | null;
  origin_type?: string | null;
  urgency?: string | null;
  search?: string | null;
  limit: number;
  offset: number;
}

export interface DiListPage {
  items: InterventionRequest[];
  total: number;
}

export interface DiTransitionRow {
  id: number;
  from_status: string;
  to_status: string;
  action: string;
  actor_id: number | null;
  reason_code: string | null;
  notes: string | null;
  acted_at: string;
}

export interface DiSummaryRow {
  id: number;
  code: string;
  title: string;
  status: string;
  submitted_at: string;
}

export interface DiCreateInput {
  asset_id: number;
  org_node_id: number;
  title: string;
  description: string;
  origin_type: string;
  symptom_code_id?: number | null;
  impact_level: string;
  production_impact: boolean;
  safety_flag: boolean;
  environmental_flag: boolean;
  quality_flag: boolean;
  reported_urgency: string;
  observed_at?: string | null;
  submitter_id: number;
}

export interface DiDraftUpdateInput {
  id: number;
  expected_row_version: number;
  title?: string | null;
  description?: string | null;
  symptom_code_id?: number | null;
  impact_level?: string | null;
  production_impact?: boolean | null;
  safety_flag?: boolean | null;
  environmental_flag?: boolean | null;
  quality_flag?: boolean | null;
  reported_urgency?: string | null;
  observed_at?: string | null;
}

export interface DiGetResponse {
  di: InterventionRequest;
  transitions: DiTransitionRow[];
  similar: DiSummaryRow[];
}

// â”€â”€ DI Review / Triage (File 02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DiScreenInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  validated_urgency: string;
  review_team_id?: number | null;
  classification_code_id?: number | null;
  reviewer_note?: string | null;
}

export interface DiReturnInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  reviewer_note: string;
}

export interface DiRejectInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  reason_code: string;
  notes?: string | null;
}

export interface DiApproveInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  notes?: string | null;
}

export interface DiDeferInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  deferred_until: string;
  reason_code: string;
  notes?: string | null;
}

export interface DiReactivateInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  notes?: string | null;
}

export interface DiReviewEvent {
  id: number;
  di_id: number;
  event_type: string;
  actor_id: number | null;
  acted_at: string;
  from_status: string;
  to_status: string;
  reason_code: string | null;
  notes: string | null;
  sla_target_hours: number | null;
  sla_deadline: string | null;
  step_up_used: boolean;
}

// â”€â”€â”€ Lookup Service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface LookupValueOption {
  id: number;
  code: string;
  label: string;
  fr_label: string | null;
  en_label: string | null;
  color: string | null;
  is_active: number;
}

export interface LookupValueRecord extends LookupValueOption {
  sync_id: string;
  domain_id: number;
  description: string | null;
  sort_order: number;
  is_system: number;
  parent_value_id: number | null;
}

export interface LookupDomainSummary {
  id: number;
  code: string;
  name: string;
  value_count: number;
}

export interface LookupDomainFilter {
  search?: string | null;
}

export interface PageRequest {
  page: number;
  per_page: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

// â”€â”€â”€ DI Attachments (File 03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type DiAttachmentType = "photo" | "sensor_snapshot" | "pdf" | "other";

export interface DiAttachment {
  id: number;
  di_id: number;
  file_name: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  attachment_type: string;
  uploaded_by_id: number | null;
  uploaded_at: string;
  notes: string | null;
}

export interface DiAttachmentUploadInput {
  diId: number;
  fileName: string;
  fileBytes: number[];
  mimeType: string;
  attachmentType: DiAttachmentType;
  notes?: string;
}

// â”€â”€â”€ DI SLA (File 03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DiSlaRule {
  id: number;
  name: string;
  urgency_level: string;
  origin_type: string | null;
  asset_criticality_class: string | null;
  target_response_hours: number;
  target_resolution_hours: number;
  escalation_threshold_hours: number;
  is_active: boolean;
}

export interface DiSlaStatus {
  rule_id: number | null;
  target_response_hours: number | null;
  target_resolution_hours: number | null;
  sla_deadline: string | null;
  response_elapsed_hours: number | null;
  resolution_elapsed_hours: number | null;
  is_response_breached: boolean;
  is_resolution_breached: boolean;
}

export interface SlaRuleUpdateInput {
  id: number;
  name: string;
  urgency_level: string;
  origin_type?: string | null;
  asset_criticality_class?: string | null;
  target_response_hours: number;
  target_resolution_hours: number;
  escalation_threshold_hours: number;
  is_active: boolean;
}

// â”€â”€â”€ DI WO Conversion (File 03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface WoConversionInput {
  di_id: number;
  actor_id: number;
  expected_row_version: number;
  conversion_notes?: string | null;
}

export interface WoConversionResult {
  di: InterventionRequest;
  wo_id: number;
  wo_code: string;
}

// Frontend invokes via: invoke("shutdown_app")

// â”€â”€â”€ Asset â€” Health Score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AssetHealthScore {
  asset_id: number;
  score: number | null;
  label: "good" | "fair" | "poor" | "no_data";
}

// â”€â”€â”€ Asset â€” Photos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AssetPhoto {
  id: number;
  asset_id: number;
  file_name: string;
  file_path: string;
  mime_type: string;
  file_size_bytes: number;
  caption: string | null;
  created_by_id: number | null;
  created_at: string;
}

export interface UploadAssetPhotoPayload {
  asset_id: number;
  source_path: string;
  caption: string | null;
}

// â”€â”€â”€ Asset â€” Decommission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DecommissionAssetPayload {
  asset_id: number;
  target_status: "RETIRED" | "SCRAPPED" | "TRANSFERRED";
  reason: string;
  notes: string | null;
}

// â”€â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface KpiValue {
  key: string;
  value: number;
  previous_value: number;
  available: boolean;
}

export interface DashboardKpis {
  open_dis: KpiValue;
  open_wos: KpiValue;
  total_assets: KpiValue;
  overdue_items: KpiValue;
}

export interface WorkloadDay {
  date: string;
  di_created: number;
  wo_completed: number;
  pm_due: number;
}

export interface DashboardWorkloadChart {
  days: WorkloadDay[];
  period_days: number;
}

// â”€â”€â”€ DI Statistics (File 04) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DiStatsFilter {
  date_from?: string | null;
  date_to?: string | null;
  entity_id?: number | null;
}

export interface DiStatusCount {
  status: string;
  count: number;
}

export interface DiPriorityCount {
  priority: string;
  count: number;
}

export interface DiTypeCount {
  origin_type: string;
  count: number;
}

export interface DiTrendPoint {
  period: string;
  created: number;
  closed: number;
}

export interface DiEquipmentCount {
  asset_id: number;
  asset_label: string;
  count: number;
  percentage: number;
}

export interface DiOverdueDi {
  id: number;
  code: string;
  title: string;
  priority: string;
  days_overdue: number;
}

export interface DiStatsPayload {
  total: number;
  pending: number;
  in_progress: number;
  closed: number;
  closed_this_month: number;
  overdue: number;
  sla_met_count: number;
  sla_total: number;
  safety_issues: number;
  status_distribution: DiStatusCount[];
  priority_distribution: DiPriorityCount[];
  type_distribution: DiTypeCount[];
  monthly_trend: DiTrendPoint[];
  available_years: number[];
  avg_age_days: number;
  max_age_days: number;
  top_equipment: DiEquipmentCount[];
  overdue_dis: DiOverdueDi[];
}

// â”€â”€â”€ Work Orders (OT) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type WoStatus =
  | "draft"
  | "awaiting_approval"
  | "planned"
  | "ready_to_schedule"
  | "assigned"
  | "waiting_for_prerequisite"
  | "in_progress"
  | "paused"
  | "mechanically_complete"
  | "technically_verified"
  | "closed"
  | "cancelled";

export type WoMacroState = "open" | "executing" | "completed" | "closed" | "cancelled";

export interface WorkOrder {
  id: number;
  code: string;
  // Classification
  type_id: number;
  status_id: number;
  // Asset context
  equipment_id: number | null;
  component_id: number | null;
  location_id: number | null;
  // People
  requester_id: number | null;
  source_di_id: number | null;
  entity_id: number | null;
  planner_id: number | null;
  approver_id: number | null;
  assigned_group_id: number | null;
  primary_responsible_id: number | null;
  // Urgency
  urgency_id: number | null;
  // Core description
  title: string;
  description: string | null;
  // Timing
  planned_start: string | null;
  planned_end: string | null;
  shift: WoShift | null;
  scheduled_at: string | null;
  actual_start: string | null;
  actual_end: string | null;
  mechanically_completed_at: string | null;
  technically_verified_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  // Duration accumulators
  expected_duration_hours: number | null;
  actual_duration_hours: number | null;
  active_labor_hours: number | null;
  total_waiting_hours: number | null;
  downtime_hours: number | null;
  // Cost accumulators
  labor_cost: number | null;
  parts_cost: number | null;
  service_cost: number | null;
  total_cost: number | null;
  // Close-out evidence
  recurrence_risk_level: string | null;
  production_impact_id: number | null;
  root_cause_summary: string | null;
  corrective_action_summary: string | null;
  verification_method: string | null;
  // Metadata
  notes: string | null;
  cancel_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
  // Join fields (populated by queries)
  status_code?: string | null;
  status_label?: string | null;
  status_color?: string | null;
  type_code?: string | null;
  type_label?: string | null;
  urgency_level?: number | null;
  urgency_label?: string | null;
  urgency_color?: string | null;
  asset_code?: string | null;
  asset_label?: string | null;
  planner_username?: string | null;
  responsible_username?: string | null;
}

export interface WoTransitionRow {
  id: number;
  wo_id: number;
  from_status: string;
  to_status: string;
  action: string;
  actor_id: number | null;
  reason_code: string | null;
  notes: string | null;
  acted_at: string;
}

export interface WoCreateInput {
  type_id: number;
  equipment_id?: number | null;
  location_id?: number | null;
  source_di_id?: number | null;
  entity_id?: number | null;
  planner_id?: number | null;
  urgency_id?: number | null;
  title: string;
  description?: string | null;
  notes?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  shift?: WoShift | null;
  expected_duration_hours?: number | null;
  creator_id: number;
}

export interface WoDraftUpdateInput {
  id: number;
  expected_row_version: number;
  title?: string | null;
  type_id?: number | null;
  equipment_id?: number | null;
  location_id?: number | null;
  description?: string | null;
  planned_start?: string | null;
  planned_end?: string | null;
  shift?: WoShift | null;
  expected_duration_hours?: number | null;
  notes?: string | null;
  urgency_id?: number | null;
}

export interface WoListFilter {
  status_codes?: string[] | null;
  type_codes?: string[] | null;
  equipment_id?: number | null;
  entity_id?: number | null;
  planner_id?: number | null;
  primary_responsible_id?: number | null;
  urgency_level?: number | null;
  source_di_id?: number | null;
  search?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  limit: number;
  offset: number;
}

export interface WoListPage {
  items: WorkOrder[];
  total: number;
}

export interface WoGetResponse {
  wo: WorkOrder;
  transitions: WoTransitionRow[];
}

export interface WoCancelInput {
  id: number;
  expected_row_version: number;
  actor_id: number;
  cancel_reason: string;
}

// â”€â”€ WO File 02 â€” Planning, Labor, Completion types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type WoShift = "morning" | "afternoon" | "night" | "full_day";

export interface WoPlanInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
  planner_id: number;
  planned_start: string;
  planned_end: string;
  shift?: WoShift | null;
  expected_duration_hours?: number | null;
  urgency_id?: number | null;
}

export interface WoAssignInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
  assigned_group_id?: number | null;
  primary_responsible_id?: number | null;
  scheduled_at?: string | null;
}

export interface WoStartInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
}

export interface WoPauseInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
  delay_reason_id: number;
  comment?: string | null;
}

export interface WoResumeInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
}

export interface WoHoldInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
  delay_reason_id: number;
  comment?: string | null;
}

export interface WoMechCompleteInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
  actual_end?: string | null;
  actual_duration_hours?: number | null;
  conclusion?: string | null;
}

export interface WoMechCompleteResponse {
  wo: WorkOrder;
  errors: WoPreflightError[];
}

export interface WoPreflightError {
  code: string;
  message: string;
}

export interface WoCloseInput {
  wo_id: number;
  actor_id: number;
  expected_row_version: number;
}

export interface WoLaborEntry {
  id: number;
  work_order_id: number;
  intervener_id: number;
  intervener_name: string | null;
  skill: string | null;
  started_at: string | null;
  ended_at: string | null;
  hours_worked: number | null;
  hourly_rate: number | null;
  notes: string | null;
  created_at: string;
}

export interface WoAddLaborInput {
  work_order_id: number;
  intervener_id: number;
  started_at?: string | null;
  skill?: string | null;
  hourly_rate?: number | null;
  notes?: string | null;
}

export interface WoCloseLaborInput {
  id: number;
  ended_at: string;
  hours_worked?: number | null;
}

export interface WoTask {
  id: number;
  work_order_id: number;
  sequence: number;
  description: string;
  is_mandatory: boolean;
  is_completed: boolean;
  completed_at: string | null;
  completed_by_id: number | null;
}

export interface WoPartUsage {
  id: number;
  work_order_id: number;
  part_id: number | null;
  part_label: string | null;
  quantity_planned: number | null;
  quantity_actual: number | null;
  unit_cost: number | null;
  notes: string | null;
}

export interface WoCostSummary {
  labor_cost: number;
  parts_cost: number;
  service_cost: number;
  total_cost: number;
  expected_duration_hours: number | null;
  actual_duration_hours: number | null;
}

// â”€â”€ WO Execution sub-entity types (from wo-execution-service) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type TaskResultCode = "ok" | "nok" | "na" | "deferred";

export type DowntimeType = "full" | "partial" | "standby" | "quality_loss";

/** Task row as returned by execution commands (raw FK columns). */
export interface WoExecTask {
  id: number;
  work_order_id: number;
  task_description: string;
  sequence_order: number;
  estimated_minutes: number | null;
  is_mandatory: boolean;
  is_completed: boolean;
  completed_by_id: number | null;
  completed_at: string | null;
  result_code: TaskResultCode | null;
  notes: string | null;
}

/** Labor/intervener row as returned by execution commands (raw FK columns). */
export interface WoIntervener {
  id: number;
  work_order_id: number;
  intervener_id: number;
  skill_id: number | null;
  started_at: string | null;
  ended_at: string | null;
  hours_worked: number | null;
  hourly_rate: number | null;
  notes: string | null;
}

/** Part row as returned by execution commands (raw FK columns). */
export interface WoExecPart {
  id: number;
  work_order_id: number;
  article_id: number | null;
  article_ref: string | null;
  quantity_planned: number;
  quantity_used: number | null;
  unit_cost: number | null;
  stock_location_id: number | null;
  reservation_id: number | null;
  quantity_reserved: number;
  quantity_issued: number;
  notes: string | null;
}

export interface WoDelaySegment {
  id: number;
  work_order_id: number;
  started_at: string;
  ended_at: string | null;
  delay_reason_id: number | null;
  comment: string | null;
  entered_by_id: number | null;
}

export interface WoDowntimeSegment {
  id: number;
  work_order_id: number;
  started_at: string;
  ended_at: string | null;
  downtime_type: DowntimeType;
  comment: string | null;
}

export interface WoStatsPayload {
  total: number;
  in_progress: number;
  completed: number;
  overdue: number;
  by_status: { status: string; count: number }[];
  by_urgency: { urgency: string; count: number }[];
  daily_completed: { date: string; count: number }[];
  by_entity: { entity: string; count: number }[];
}

// â”€â”€â”€ Admin & Governance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AdminStatsPayload {
  active_users: number;
  inactive_users: number;
  total_roles: number;
  system_roles: number;
  custom_roles: number;
  active_sessions: number;
  unassigned_users: number;
  emergency_grants_active: number;
}

export interface UserProfile {
  id: number;
  username: string;
  personnel_id: number | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  language: string | null;
  identity_mode: string;
  created_at: string;
  password_changed_at: string | null;
  pin_configured: boolean;
  role_name: string | null;
}

export interface UpdateProfileInput {
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
  language?: string | null;
}

export interface ChangePasswordInput {
  current_password: string;
  new_password: string;
}

export interface SessionHistoryEntry {
  id: number | string;
  device_label: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  status: string;
}

export interface TrustedDeviceEntry {
  id: string;
  device_label: string | null;
  trusted_at: string;
  last_seen_at: string | null;
  is_revoked: boolean;
}

export interface UserPresence {
  user_id: number;
  status: "active" | "idle" | "offline";
  last_activity_at: string | null;
}

export interface CreateUserInput {
  username: string;
  identity_mode: string;
  personnel_id?: number | null;
  initial_password?: string | null;
  force_password_change?: boolean;
}

export interface SetPinInput {
  current_password: string;
  new_pin: string;
}

export interface ClearPinInput {
  current_password: string;
}

export interface PinUnlockInput {
  pin: string;
}

export interface PasswordPolicySettings {
  max_age_days: number;
  warn_days_before_expiry: number;
  min_length: number;
  require_uppercase: boolean;
  require_lowercase: boolean;
  require_digit: boolean;
  require_special: boolean;
}

export interface RbacSettingEntry {
  key: string;
  value: string;
  description: string | null;
}

// â”€â”€â”€ Admin Users & Roles (SP06-F01) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface RoleAssignmentSummary {
  assignment_id: number;
  role_id: number;
  role_name: string;
  scope_type: string;
  scope_reference: string | null;
  valid_from: string | null;
  valid_to: string | null;
  is_emergency: boolean;
}

export interface UserWithRoles {
  id: number;
  username: string;
  display_name: string | null;
  identity_mode: string;
  is_active: boolean;
  force_password_change: boolean;
  last_seen_at: string | null;
  locked_until: string | null;
  roles: RoleAssignmentSummary[];
}

export interface UserScopeAssignment {
  id: number;
  user_id: number;
  role_id: number;
  scope_type: string;
  scope_reference: string | null;
  valid_from: string | null;
  valid_to: string | null;
  assigned_by_id: number | null;
  notes: string | null;
  is_emergency: boolean;
  emergency_reason: string | null;
  emergency_expires_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface UserDetail {
  user: UserWithRoles;
  scope_assignments: UserScopeAssignment[];
  effective_permissions: string[];
}

export interface UserListFilter {
  is_active?: boolean;
  identity_mode?: string;
  search?: string;
}

export interface UpdateUserInput {
  user_id: number;
  username?: string;
  personnel_id?: number | null;
  force_password_change?: boolean;
  is_active?: boolean;
}

export interface AssignRoleScopeInput {
  user_id: number;
  role_id: number;
  scope_type: string;
  scope_reference?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface RoleWithPermissions {
  id: number;
  name: string;
  description: string | null;
  role_type: string;
  status: string;
  is_system: boolean;
  permissions: string[];
}

export interface RoleDetail {
  role: RoleWithPermissions;
  dependency_warnings: string[];
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  permission_names: string[];
}

export interface UpdateRoleInput {
  role_id: number;
  description?: string | null;
  add_permissions?: string[];
  remove_permissions?: string[];
}

export interface RoleTemplate {
  id: number;
  name: string;
  description: string | null;
  module_set_json: string;
  is_system: boolean;
}

export interface SimulateAccessInput {
  user_id: number;
  scope_type: string;
  scope_reference?: string | null;
}

export interface SimulateAccessResult {
  permissions: Record<string, boolean>;
  assignments: UserScopeAssignment[];
  dependency_warnings: string[];
  blocked_by: string[];
}

export interface IdPayload {
  id: number;
}

// â”€â”€â”€ Permission Catalog (SP06-F02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PermissionWithSystem {
  id: number;
  name: string;
  description: string | null;
  category: string;
  is_dangerous: boolean;
  requires_step_up: boolean;
  is_system: boolean;
}

export interface PermissionListFilter {
  category?: string;
  is_dangerous?: boolean;
  search?: string;
}

export interface PermissionDependencyRow {
  id: number;
  permission_name: string;
  required_permission_name: string;
  dependency_type: string;
}

export interface CreateCustomPermissionInput {
  name: string;
  description?: string | null;
  category?: string | null;
}

export interface MissingDependency {
  permission_name: string;
  required_permission_name: string;
  dependency_type: string;
}

export interface RoleValidationResult {
  missing_hard_deps: MissingDependency[];
  warn_deps: MissingDependency[];
  unknown_permissions: string[];
  is_valid: boolean;
}

// â”€â”€â”€ Emergency Elevation (SP06-F02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface GrantEmergencyElevationInput {
  user_id: number;
  role_id: number;
  scope_type: string;
  scope_reference?: string | null;
  reason: string;
  expires_at: string;
}

export interface RevokeEmergencyElevationInput {
  assignment_id: number;
}

// â”€â”€â”€ Admin Governance â€” Session Visibility (SP06-F03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SessionSummary {
  session_id: string;
  user_id: string;
  username: string;
  device_id: string | null;
  device_name: string | null;
  device_trust_status: string;
  session_started_at: string;
  last_activity_at: string | null;
  is_current_session: boolean;
  current_role_names: string[];
}

// â”€â”€â”€ Admin Governance â€” Delegation (SP06-F03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface DelegationPolicyView {
  id: number;
  admin_role_id: number;
  admin_role_name: string;
  managed_scope_type: string;
  managed_scope_reference: string | null;
  allowed_domains: string[];
  requires_step_up_for_publish: boolean;
}

export interface CreateDelegationInput {
  admin_role_id: number;
  managed_scope_type: string;
  managed_scope_reference?: string | null;
  allowed_domains: string[];
  requires_step_up_for_publish: boolean;
}

export interface UpdateDelegationInput {
  policy_id: number;
  allowed_domains?: string[];
  requires_step_up_for_publish?: boolean;
}

// â”€â”€â”€ Admin Governance â€” Emergency Grants (SP06-F03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EmergencyGrantView {
  assignment_id: number;
  user_id: number;
  username: string;
  role_id: number;
  role_name: string;
  scope_type: string;
  scope_reference: string | null;
  emergency_reason: string | null;
  emergency_expires_at: string | null;
  assigned_by_username: string | null;
  created_at: string;
  is_expired: boolean;
}

// â”€â”€â”€ Admin Governance â€” Role Import/Export (SP06-F03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface RoleExportEntry {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
  is_system: boolean;
}

export interface RoleExportPayload {
  roles: RoleExportEntry[];
  exported_at: string;
  exported_by: string;
}

export interface RoleImportEntry {
  name: string;
  description?: string | null;
  permissions: string[];
}

export interface RoleImportPayload {
  roles: RoleImportEntry[];
}

export interface SkippedRole {
  name: string;
  errors: string[];
}

export interface ImportResult {
  imported_count: number;
  skipped: SkippedRole[];
}

// â”€â”€â”€ Admin Audit Events (SP06-F04) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AdminEventFilter {
  action?: string;
  actorId?: number;
  targetUserId?: number;
  targetRoleId?: number;
  dateFrom?: string;
  dateTo?: string;
  applyResult?: string;
  limit?: number;
  offset?: number;
}

export interface AdminChangeEventDetail {
  id: number;
  action: string;
  actor_id: number | null;
  actor_username: string | null;
  target_user_id: number | null;
  target_username: string | null;
  target_role_id: number | null;
  target_role_name: string | null;
  acted_at: string;
  scope_type: string | null;
  scope_reference: string | null;
  summary: string | null;
  diff_json: string | null;
  step_up_used: boolean;
  apply_result: string;
}

// â”€â”€â”€ Activity Feed & Audit Log (SP07-F03) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ActivityFilter {
  event_class?: string;
  event_code?: string;
  source_module?: string;
  source_record_type?: string;
  source_record_id?: string;
  entity_scope_id?: number;
  actor_id?: number;
  severity?: string;
  date_from?: string;
  date_to?: string;
  correlation_id?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityEventSummary {
  id: number;
  event_class: string;
  event_code: string;
  source_module: string;
  source_record_type: string | null;
  source_record_id: string | null;
  entity_scope_id: number | null;
  actor_id: number | null;
  actor_username: string | null;
  happened_at: string;
  severity: string;
  summary_json: unknown | null;
  correlation_id: string | null;
  visibility_scope: string;
}

export interface ActivityEventDetail {
  event: ActivityEventSummary;
  correlated_events: ActivityEventSummary[];
  source_record_link: string | null;
}

export interface SaveFilterInput {
  view_name: string;
  filter_json: unknown;
  is_default: boolean;
}

export interface SavedActivityFilter {
  id: number;
  user_id: number;
  view_name: string;
  filter_json: unknown;
  is_default: boolean;
}

export interface EventChainNode {
  table: string;
  event_id: number;
  happened_at: string;
  event_code: string | null;
  action_code: string | null;
  source_module: string | null;
  link_type: string | null;
}

export interface EventChain {
  events: EventChainNode[];
}

export interface AuditFilter {
  action_code?: string;
  actor_id?: number;
  target_type?: string;
  result?: string;
  date_from?: string;
  date_to?: string;
  retention_class?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEventSummary {
  id: number;
  action_code: string;
  target_type: string | null;
  target_id: string | null;
  actor_id: number | null;
  actor_username: string | null;
  auth_context: string;
  result: string;
  happened_at: string;
  retention_class: string;
}

export interface AuditEventDetail {
  id: number;
  action_code: string;
  target_type: string | null;
  target_id: string | null;
  actor_id: number | null;
  actor_username: string | null;
  auth_context: string;
  result: string;
  before_hash: string | null;
  after_hash: string | null;
  happened_at: string;
  retention_class: string;
  details_json: unknown | null;
}

export interface ExportAuditInput {
  filter: AuditFilter;
  export_reason: string;
}

export interface ExportResult {
  event_export_run_id: number;
  row_count: number;
  rows_json: unknown;
}

// â”€â”€ Personnel (PRD Â§6.6) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface Personnel {
  id: number;
  employee_code: string;
  full_name: string;
  employment_type: string;
  position_id: number | null;
  primary_entity_id: number | null;
  primary_team_id: number | null;
  supervisor_id: number | null;
  home_schedule_id: number | null;
  availability_status: string;
  hire_date: string | null;
  termination_date: string | null;
  email: string | null;
  phone: string | null;
  photo_path: string | null;
  hr_external_id: string | null;
  external_company_id: number | null;
  notes: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
  position_name: string | null;
  position_category: string | null;
  entity_name: string | null;
  team_name: string | null;
  supervisor_name: string | null;
  schedule_name: string | null;
  company_name: string | null;
}

export interface PersonnelListFilter {
  employment_type?: string[] | null;
  availability_status?: string[] | null;
  position_id?: number | null;
  entity_id?: number | null;
  team_id?: number | null;
  company_id?: number | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface PersonnelListPage {
  items: Personnel[];
  total: number;
}

export interface PersonnelCreateInput {
  full_name: string;
  employee_code?: string | null;
  employment_type: string;
  position_id?: number | null;
  primary_entity_id?: number | null;
  primary_team_id?: number | null;
  supervisor_id?: number | null;
  home_schedule_id?: number | null;
  hire_date?: string | null;
  email?: string | null;
  phone?: string | null;
  external_company_id?: number | null;
  notes?: string | null;
}

export interface PersonnelUpdateInput {
  id: number;
  expected_row_version: number;
  full_name?: string | null;
  employment_type?: string | null;
  position_id?: number | null;
  primary_entity_id?: number | null;
  primary_team_id?: number | null;
  supervisor_id?: number | null;
  home_schedule_id?: number | null;
  availability_status?: string | null;
  hire_date?: string | null;
  termination_date?: string | null;
  email?: string | null;
  phone?: string | null;
  external_company_id?: number | null;
  notes?: string | null;
}

export interface Position {
  id: number;
  code: string;
  name: string;
  category: string;
  requirement_profile_id: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleClass {
  id: number;
  name: string;
  shift_pattern_code: string;
  is_continuous: number;
  nominal_hours_per_day: number;
  is_active: number;
  created_at: string;
}

export interface ScheduleDetail {
  id: number;
  schedule_class_id: number;
  day_of_week: number;
  shift_start: string;
  shift_end: string;
  is_rest_day: number;
}

export interface ScheduleClassWithDetails {
  class: ScheduleClass;
  details: ScheduleDetail[];
}

export interface PersonnelRateCard {
  id: number;
  personnel_id: number;
  effective_from: string;
  labor_rate: number;
  overtime_rate: number;
  cost_center_id: number | null;
  source_type: string;
  created_at: string;
}

export interface PersonnelAuthorization {
  id: number;
  personnel_id: number;
  authorization_type: string;
  valid_from: string;
  valid_to: string | null;
  source_certification_type_id: number | null;
  is_active: number;
  created_at: string;
}

export interface ExternalCompany {
  id: number;
  name: string;
  service_domain: string | null;
  contract_start: string | null;
  contract_end: string | null;
  onboarding_status: string;
  insurance_status: string;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ExternalCompanyContact {
  id: number;
  company_id: number;
  contact_name: string;
  contact_role: string | null;
  phone: string | null;
  email: string | null;
  is_primary: number;
  created_at: string;
}

export interface CompanyListFilter {
  onboarding_status?: string | null;
  search?: string | null;
}

export interface PersonnelDetailPayload {
  personnel: Personnel;
  rate_cards: PersonnelRateCard[];
  authorizations: PersonnelAuthorization[];
}

export interface SkillsMatrixFilter {
  personnel_id?: number | null;
  entity_id?: number | null;
  team_id?: number | null;
  skill_code?: string | null;
  include_inactive?: boolean;
}

export interface SkillMatrixRow {
  personnel_id: number;
  employee_code: string;
  full_name: string;
  employment_type: string;
  availability_status: string;
  entity_id: number | null;
  entity_name: string | null;
  team_id: number | null;
  team_name: string | null;
  skill_code: string | null;
  skill_label: string | null;
  proficiency_level: number | null;
  coverage_status: "active" | "expired" | "missing";
}

export interface AvailabilityCalendarFilter {
  date_from: string;
  date_to: string;
  personnel_id?: number | null;
  entity_id?: number | null;
  team_id?: number | null;
  include_inactive?: boolean;
}

export interface AvailabilityCalendarEntry {
  personnel_id: number;
  employee_code: string;
  full_name: string;
  entity_id: number | null;
  entity_name: string | null;
  team_id: number | null;
  team_name: string | null;
  work_date: string;
  shift_start: string | null;
  shift_end: string | null;
  scheduled_minutes: number;
  blocked_minutes: number;
  available_minutes: number;
  has_critical_block: boolean;
  block_types: string[];
}

export interface TeamCapacityFilter {
  date_from: string;
  date_to: string;
  entity_id?: number | null;
  include_inactive?: boolean;
}

export interface TeamCapacitySummaryRow {
  team_id: number;
  team_code: string;
  team_name: string;
  member_count: number;
  lead_count: number;
  total_scheduled_minutes: number;
  total_available_minutes: number;
  total_blocked_minutes: number;
  avg_availability_ratio: number;
}

export interface AvailabilityBlockCreateInput {
  personnel_id: number;
  block_type: string;
  start_at: string;
  end_at: string;
  reason_note?: string | null;
  is_critical?: boolean;
}

export interface PersonnelAvailabilityBlock {
  id: number;
  personnel_id: number;
  block_type: string;
  start_at: string;
  end_at: string;
  reason_note: string | null;
  is_critical: boolean;
  created_by_id: number | null;
  created_at: string;
}

export interface PersonnelTeamAssignment {
  id: number;
  personnel_id: number;
  team_id: number;
  team_code: string | null;
  team_name: string | null;
  role_code: string;
  allocation_percent: number;
  valid_from: string | null;
  valid_to: string | null;
  is_lead: number;
  created_at: string;
  updated_at: string;
}

export interface PersonnelWorkHistoryEntry {
  source_module: string;
  record_id: number;
  record_code: string | null;
  role_code: string;
  status_code: string | null;
  title: string;
  happened_at: string;
}

export interface PersonnelWorkloadSummary {
  open_work_orders: number;
  in_progress_work_orders: number;
  pending_interventions: number;
  interventions_last_30d: number;
}

export interface SuccessionRiskRow {
  personnel_id: number;
  full_name: string;
  employee_code: string;
  position_name: string | null;
  team_name: string | null;
  coverage_count: number;
  risk_level: "high" | "medium" | "low";
  reason: string;
}

export interface DeclareOwnSkillInput {
  reference_value_id: number;
  proficiency_level: number;
  valid_to?: string | null;
  note?: string | null;
  is_primary?: boolean;
}

export interface PersonnelSkillReferenceValue {
  id: number;
  code: string;
  label: string;
}

export interface PersonnelImportCreateInput {
  filename: string;
  source_sha256: string;
  source_kind: "csv" | "xlsx";
  mode: "create_and_update" | "create_only";
  file_content: number[];
}

export interface PersonnelImportMessage {
  category: string;
  severity: "warning" | "error" | "info";
  message: string;
}

export interface PersonnelImportBatchSummary {
  id: number;
  source_filename: string;
  source_sha256: string;
  source_kind: string;
  mode: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
  initiated_by_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface PersonnelImportPreviewRow {
  id: number;
  row_no: number;
  employee_code: string | null;
  hr_external_id: string | null;
  target_personnel_id: number | null;
  target_row_version: number | null;
  validation_status: string;
  messages: PersonnelImportMessage[];
  proposed_action: string | null;
  raw_json: string;
}

export interface PersonnelImportPreview {
  batch: PersonnelImportBatchSummary;
  rows: PersonnelImportPreviewRow[];
}

export interface PersonnelImportApplyResult {
  batch: PersonnelImportBatchSummary;
  created: number;
  updated: number;
  skipped: number;
  protected_ignored: number;
}

export interface WorkforceSummaryRow {
  bucket: string;
  count: number;
}

export interface WorkforceSummaryReport {
  total_personnel: number;
  active_personnel: number;
  employment_breakdown: WorkforceSummaryRow[];
  availability_breakdown: WorkforceSummaryRow[];
}

export interface WorkforceSkillsGapRow {
  personnel_id: number;
  employee_code: string;
  full_name: string;
  position_name: string | null;
  team_name: string | null;
  active_skill_count: number;
  gap_score: number;
}

export interface WorkforceKpiReport {
  avg_skills_per_person: number;
  blocked_ratio: number;
  contractor_ratio: number;
  team_coverage_ratio: number;
}

// -- Planning & Scheduling (PRD §6.16) --
export interface ScheduleCandidate {
  id: number;
  source_type: string;
  source_id: number;
  source_di_id: number | null;
  readiness_status: string;
  readiness_score: number;
  priority_id: number | null;
  required_skill_set_json: string | null;
  required_parts_ready: number;
  permit_status: string;
  shutdown_requirement: string | null;
  prerequisite_status: string;
  estimated_duration_hours: number | null;
  assigned_personnel_id: number | null;
  assigned_team_id: number | null;
  window_start: string | null;
  window_end: string | null;
  suggested_assignees_json: string | null;
  availability_conflict_count: number;
  skill_match_score: number | null;
  estimated_labor_cost_range_json: string | null;
  blocking_flags_json: string | null;
  open_work_count: number | null;
  next_available_window: string | null;
  estimated_assignment_risk: number | null;
  risk_reason_codes_json: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface SchedulingConflict {
  id: number;
  candidate_id: number;
  conflict_type: string;
  reference_type: string | null;
  reference_id: number | null;
  reason_code: string;
  severity: string;
  details_json: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ScheduleCandidateFilter {
  source_type?: string | null;
  readiness_status?: string | null;
  assigned_personnel_id?: number | null;
  include_resolved_conflicts?: boolean | null;
  limit?: number | null;
}

export interface CandidateConflictSummary {
  candidate_id: number;
  blocker_codes: string[];
  blocker_dimensions: string[];
  readiness_status: string;
  readiness_score: number;
}

export interface ScheduleBacklogSnapshot {
  as_of: string;
  candidate_count: number;
  ready_count: number;
  blocked_count: number;
  candidates: ScheduleCandidate[];
  conflict_summary: CandidateConflictSummary[];
  derivation_rules: string[];
}

export interface RefreshScheduleCandidatesInput {
  include_work_orders?: boolean | null;
  include_pm_occurrences?: boolean | null;
  include_approved_di?: boolean | null;
  limit_per_source?: number | null;
}

export interface RefreshScheduleCandidatesResult {
  inserted_count: number;
  updated_count: number;
  evaluated_count: number;
  ready_count: number;
  blocked_count: number;
}

export interface CapacityRule {
  id: number;
  entity_id: number | null;
  team_id: number;
  effective_start: string;
  effective_end: string | null;
  available_hours_per_day: number;
  max_overtime_hours_per_day: number;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface CapacityRuleFilter {
  entity_id?: number | null;
  team_id?: number | null;
}

export interface CreateCapacityRuleInput {
  entity_id?: number | null;
  team_id: number;
  effective_start: string;
  effective_end?: string | null;
  available_hours_per_day: number;
  max_overtime_hours_per_day: number;
}

export interface UpdateCapacityRuleInput {
  effective_start?: string | null;
  effective_end?: string | null;
  available_hours_per_day?: number | null;
  max_overtime_hours_per_day?: number | null;
}

export interface PlanningWindow {
  id: number;
  entity_id: number | null;
  window_type: string;
  start_datetime: string;
  end_datetime: string;
  is_locked: number;
  lock_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface PlanningWindowFilter {
  entity_id?: number | null;
  window_type?: string | null;
  include_locked?: boolean | null;
}

export interface CreatePlanningWindowInput {
  entity_id?: number | null;
  window_type: string;
  start_datetime: string;
  end_datetime: string;
  is_locked?: boolean | null;
  lock_reason?: string | null;
}

export interface UpdatePlanningWindowInput {
  window_type?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  is_locked?: boolean | null;
  lock_reason?: string | null;
}

export interface ScheduleCommitment {
  id: number;
  schedule_candidate_id: number;
  source_type: string;
  source_id: number;
  schedule_period_start: string;
  schedule_period_end: string;
  committed_start: string;
  committed_end: string;
  assigned_team_id: number;
  assigned_personnel_id: number | null;
  committed_by_id: number | null;
  frozen_at: string | null;
  estimated_labor_cost: number | null;
  budget_threshold: number | null;
  cost_variance_warning: number;
  has_blocking_conflict: number;
  nearest_feasible_window: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduleCommitmentFilter {
  period_start?: string | null;
  period_end?: string | null;
  team_id?: number | null;
  personnel_id?: number | null;
}

export interface CreateScheduleCommitmentInput {
  schedule_candidate_id: number;
  expected_candidate_row_version?: number | null;
  committed_start: string;
  committed_end: string;
  assigned_team_id: number;
  assigned_personnel_id?: number | null;
  allow_double_booking_override?: boolean | null;
  override_reason?: string | null;
  budget_threshold?: number | null;
}

export interface RescheduleCommitmentInput {
  commitment_id: number;
  expected_row_version: number;
  committed_start: string;
  committed_end: string;
  assigned_team_id: number;
  assigned_personnel_id?: number | null;
  allow_double_booking_override?: boolean | null;
  override_reason?: string | null;
  budget_threshold?: number | null;
}

export interface FreezeSchedulePeriodInput {
  period_start: string;
  period_end: string;
  reason?: string | null;
}

export interface ScheduleChangeLogEntry {
  id: number;
  commitment_id: number | null;
  action_type: string;
  actor_id: number | null;
  field_changed: string | null;
  old_value: string | null;
  new_value: string | null;
  reason_code: string | null;
  reason_note: string | null;
  reason: string | null;
  details_json: string | null;
  created_at: string;
}

export interface ScheduleBreakIn {
  id: number;
  schedule_commitment_id: number;
  break_in_reason: string;
  approved_by_user_id: number | null;
  approved_by_personnel_id: number | null;
  override_reason: string | null;
  old_slot_start: string;
  old_slot_end: string;
  new_slot_start: string;
  new_slot_end: string;
  old_assignee_id: number | null;
  new_assignee_id: number | null;
  cost_impact_delta: number | null;
  notification_dedupe_key: string | null;
  row_version: number;
  created_by_id: number | null;
  created_at: string;
}

export interface ScheduleBreakInFilter {
  period_start?: string | null;
  period_end?: string | null;
  break_in_reason?: string | null;
  approved_by_user_id?: number | null;
}

export interface CreateScheduleBreakInInput {
  schedule_commitment_id: number;
  expected_commitment_row_version: number;
  break_in_reason: string;
  approved_by_user_id?: number | null;
  new_slot_start: string;
  new_slot_end: string;
  new_assigned_team_id?: number | null;
  new_assigned_personnel_id?: number | null;
  bypass_availability?: boolean | null;
  bypass_qualification?: boolean | null;
  override_reason?: string | null;
  dangerous_override_reason?: string | null;
}

export interface TeamCapacityLoad {
  team_id: number;
  work_date: string;
  available_hours: number;
  overtime_hours: number;
  committed_hours: number;
  utilization_ratio: number;
}

export interface PlanningAssigneeLane {
  personnel_id: number;
  full_name: string;
  blocked_intervals_json: string;
  commitments_json: string;
}

export interface PlanningGanttFilter {
  period_start: string;
  period_end: string;
  team_id?: number | null;
}

export interface PlanningGanttSnapshot {
  period_start: string;
  period_end: string;
  commitments: ScheduleCommitment[];
  locked_windows: PlanningWindow[];
  capacity: TeamCapacityLoad[];
  assignee_lanes: PlanningAssigneeLane[];
}

export interface NotifyTeamsInput {
  period_start: string;
  period_end: string;
  team_id?: number | null;
  include_break_ins?: boolean | null;
}

export interface NotifyTeamsResult {
  emitted_count: number;
  skipped_count: number;
}

export interface ExportPlanningGanttPdfInput {
  period_start: string;
  period_end: string;
  team_id?: number | null;
  paper_size?: string | null;
}

export interface ExportedBinaryDocument {
  file_name: string;
  mime_type: string;
  bytes: number[];
}

// Budget / Finance (PRD §6.24)

export interface CostCenter {
  id: number;
  code: string;
  name: string;
  entity_id: number | null;
  entity_name: string | null;
  parent_cost_center_id: number | null;
  parent_cost_center_code: string | null;
  budget_owner_id: number | null;
  erp_external_id: string | null;
  is_active: number;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface CostCenterFilter {
  entity_id?: number | null;
  include_inactive?: boolean | null;
  search?: string | null;
}

export interface CreateCostCenterInput {
  code: string;
  name: string;
  entity_id?: number | null;
  parent_cost_center_id?: number | null;
  budget_owner_id?: number | null;
  erp_external_id?: string | null;
  is_active?: boolean | null;
}

export interface UpdateCostCenterInput {
  code?: string | null;
  name?: string | null;
  entity_id?: number | null;
  parent_cost_center_id?: number | null;
  budget_owner_id?: number | null;
  erp_external_id?: string | null;
  is_active?: boolean | null;
}

export interface BudgetVersion {
  id: number;
  fiscal_year: number;
  scenario_type: string;
  version_no: number;
  status: string;
  currency_code: string;
  title: string | null;
  planning_basis: string | null;
  source_basis_mix_json: string | null;
  labor_assumptions_json: string | null;
  baseline_reference: string | null;
  erp_external_ref: string | null;
  successor_of_version_id: number | null;
  created_by_id: number | null;
  approved_at: string | null;
  approved_by_id: number | null;
  frozen_at: string | null;
  frozen_by_id: number | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetVersionFilter {
  fiscal_year?: number | null;
  scenario_type?: string | null;
  status?: string | null;
}

export interface CreateBudgetVersionInput {
  fiscal_year: number;
  scenario_type: string;
  currency_code: string;
  title?: string | null;
  planning_basis?: string | null;
  source_basis_mix_json?: string | null;
  labor_assumptions_json?: string | null;
  baseline_reference?: string | null;
  erp_external_ref?: string | null;
}

export interface UpdateBudgetVersionInput {
  currency_code?: string | null;
  title?: string | null;
  planning_basis?: string | null;
  source_basis_mix_json?: string | null;
  labor_assumptions_json?: string | null;
  baseline_reference?: string | null;
  erp_external_ref?: string | null;
}

export interface CreateBudgetSuccessorInput {
  source_version_id: number;
  fiscal_year?: number | null;
  scenario_type?: string | null;
  title?: string | null;
  baseline_reference?: string | null;
}

export interface TransitionBudgetVersionLifecycleInput {
  version_id: number;
  expected_row_version: number;
  next_status: string;
}

export interface BudgetLine {
  id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  planned_amount: number;
  source_basis: string | null;
  justification_note: string | null;
  asset_family: string | null;
  work_category: string | null;
  shutdown_package_ref: string | null;
  team_id: number | null;
  skill_pool_id: number | null;
  labor_lane: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetLineFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
}

export interface CreateBudgetLineInput {
  budget_version_id: number;
  cost_center_id: number;
  period_month?: number | null;
  budget_bucket: string;
  planned_amount: number;
  source_basis?: string | null;
  justification_note?: string | null;
  asset_family?: string | null;
  work_category?: string | null;
  shutdown_package_ref?: string | null;
  team_id?: number | null;
  skill_pool_id?: number | null;
  labor_lane?: string | null;
}

export interface UpdateBudgetLineInput {
  period_month?: number | null;
  budget_bucket?: string | null;
  planned_amount?: number | null;
  source_basis?: string | null;
  justification_note?: string | null;
  asset_family?: string | null;
  work_category?: string | null;
  shutdown_package_ref?: string | null;
  team_id?: number | null;
  skill_pool_id?: number | null;
  labor_lane?: string | null;
}

export interface BudgetActual {
  id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  amount_source: number;
  source_currency: string;
  amount_base: number;
  base_currency: string;
  source_type: string;
  source_id: string;
  work_order_id: number | null;
  equipment_id: number | null;
  posting_status: string;
  provisional_reason: string | null;
  posted_at: string | null;
  posted_by_id: number | null;
  reversal_of_actual_id: number | null;
  reversal_reason: string | null;
  personnel_id: number | null;
  team_id: number | null;
  rate_card_lane: string | null;
  event_at: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetActualFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  period_month?: number | null;
  budget_bucket?: string | null;
  posting_status?: string | null;
  source_type?: string | null;
}

export interface CreateBudgetActualInput {
  budget_version_id: number;
  cost_center_id: number;
  period_month?: number | null;
  budget_bucket: string;
  amount_source: number;
  source_currency: string;
  amount_base: number;
  base_currency: string;
  source_type: string;
  source_id: string;
  work_order_id?: number | null;
  equipment_id?: number | null;
  posting_status?: string | null;
  provisional_reason?: string | null;
  personnel_id?: number | null;
  team_id?: number | null;
  rate_card_lane?: string | null;
  event_at?: string | null;
}

export interface PostBudgetActualInput {
  actual_id: number;
  expected_row_version: number;
}

export interface ReverseBudgetActualInput {
  actual_id: number;
  expected_row_version: number;
  reason: string;
}

export interface BudgetCommitment {
  id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  commitment_type: string;
  source_type: string;
  source_id: string;
  obligation_amount: number;
  source_currency: string;
  base_amount: number;
  base_currency: string;
  commitment_status: string;
  work_order_id: number | null;
  contract_id: number | null;
  purchase_order_id: number | null;
  planning_commitment_ref: string | null;
  due_at: string | null;
  explainability_note: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetCommitmentFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  period_month?: number | null;
  budget_bucket?: string | null;
  commitment_status?: string | null;
  source_type?: string | null;
}

export interface CreateBudgetCommitmentInput {
  budget_version_id: number;
  cost_center_id: number;
  period_month?: number | null;
  budget_bucket: string;
  commitment_type: string;
  source_type: string;
  source_id: string;
  obligation_amount: number;
  source_currency: string;
  base_amount: number;
  base_currency: string;
  commitment_status?: string | null;
  work_order_id?: number | null;
  contract_id?: number | null;
  purchase_order_id?: number | null;
  planning_commitment_ref?: string | null;
  due_at?: string | null;
  explainability_note?: string | null;
}

export interface ForecastRun {
  id: number;
  budget_version_id: number;
  generated_by_id: number | null;
  idempotency_key: string;
  scope_signature: string;
  method_mix_json: string | null;
  confidence_policy_json: string | null;
  generated_at: string;
}

export interface BudgetForecast {
  id: number;
  forecast_run_id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  forecast_amount: number;
  forecast_method: string;
  confidence_level: string;
  driver_type: string | null;
  driver_reference: string | null;
  explainability_json: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetForecastFilter {
  budget_version_id?: number | null;
  forecast_run_id?: number | null;
  cost_center_id?: number | null;
  period_month?: number | null;
  budget_bucket?: string | null;
  forecast_method?: string | null;
}

export interface GenerateBudgetForecastInput {
  budget_version_id: number;
  idempotency_key: string;
  scope_signature: string;
  period_month_start?: number | null;
  period_month_end?: number | null;
  include_pm_occurrence?: boolean | null;
  include_backlog_demand?: boolean | null;
  include_shutdown_demand?: boolean | null;
  include_planning_demand?: boolean | null;
  include_burn_rate?: boolean | null;
  confidence_policy_json?: string | null;
}

export interface BudgetForecastGenerationResult {
  run: ForecastRun;
  forecasts: BudgetForecast[];
  reused_existing_run: boolean;
}

export interface BudgetVarianceReview {
  id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  variance_amount: number;
  variance_pct: number;
  driver_code: string;
  action_owner_id: number;
  review_status: string;
  review_commentary: string;
  snapshot_context_json: string;
  opened_at: string;
  reviewed_at: string | null;
  closed_at: string | null;
  reopened_from_review_id: number | null;
  reopen_reason: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetVarianceReviewFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  period_month?: number | null;
  review_status?: string | null;
  driver_code?: string | null;
  action_owner_id?: number | null;
}

export interface CreateBudgetVarianceReviewInput {
  budget_version_id: number;
  cost_center_id: number;
  period_month?: number | null;
  budget_bucket: string;
  variance_amount: number;
  variance_pct: number;
  driver_code: string;
  action_owner_id: number;
  review_commentary: string;
  snapshot_context_json: string;
}

export interface TransitionBudgetVarianceReviewInput {
  review_id: number;
  expected_row_version: number;
  next_status: string;
  review_commentary?: string | null;
  reopen_reason?: string | null;
}

export interface BudgetDashboardFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  period_month?: number | null;
  budget_bucket?: string | null;
  spend_mix?: string | null;
  team_id?: number | null;
  assignee_id?: number | null;
  labor_lane?: string | null;
}

export interface BudgetDashboardRow {
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  spend_mix: string;
  team_id: number | null;
  assignee_id: number | null;
  labor_lane: string | null;
  planned_amount: number;
  committed_amount: number;
  actual_amount: number;
  forecast_amount: number;
  variance_to_plan: number;
  variance_to_forecast: number;
  currency_code: string;
  source_links_json: string;
}

export interface BudgetDrilldownRow {
  layer_type: string;
  record_id: number;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  period_month: number | null;
  budget_bucket: string;
  amount: number;
  currency_code: string;
  source_type: string | null;
  source_id: string | null;
  work_order_id: number | null;
  pm_occurrence_ref: string | null;
  inspection_ref: string | null;
  shutdown_package_ref: string | null;
  team_id: number | null;
  assignee_id: number | null;
  labor_lane: string | null;
  hours_overrun_rate: number | null;
  first_pass_effect: number | null;
  repeat_work_penalty: number | null;
  schedule_discipline_impact: number | null;
}

export interface ErpCostCenterMasterRecordInput {
  external_code: string;
  external_name: string;
  local_cost_center_code?: string | null;
  is_active?: boolean | null;
}

export interface ImportErpCostCenterMasterInput {
  import_batch_id: string;
  records: ErpCostCenterMasterRecordInput[];
}

export interface ErpMasterImportResult {
  imported_count: number;
  linked_count: number;
  inactive_count: number;
}

export interface ErpPostedActualExportItem {
  actual_id: number;
  budget_version_id: number;
  fiscal_year: number;
  scenario_type: string;
  external_cost_center_code: string | null;
  local_cost_center_code: string;
  budget_bucket: string;
  amount_source: number;
  source_currency: string;
  amount_base: number;
  base_currency: string;
  source_type: string;
  source_id: string;
  posted_at: string | null;
  reconciliation_flags: string[];
}

export interface ErpApprovedReforecastExportItem {
  forecast_id: number;
  forecast_run_id: number;
  budget_version_id: number;
  fiscal_year: number;
  scenario_type: string;
  version_status: string;
  external_cost_center_code: string | null;
  local_cost_center_code: string;
  period_month: number | null;
  budget_bucket: string;
  forecast_amount: number;
  base_currency: string;
  forecast_method: string;
  confidence_level: string;
  reconciliation_flags: string[];
}

export interface BudgetAlertConfig {
  id: number;
  budget_version_id: number | null;
  cost_center_id: number | null;
  budget_bucket: string | null;
  alert_type: string;
  threshold_pct: number | null;
  threshold_amount: number | null;
  recipient_user_id: number | null;
  recipient_role_id: number | null;
  labor_template: string | null;
  dedupe_window_minutes: number;
  requires_ack: boolean;
  is_active: boolean;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetAlertConfigFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  alert_type?: string | null;
  active_only?: boolean | null;
}

export interface CreateBudgetAlertConfigInput {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  budget_bucket?: string | null;
  alert_type: string;
  threshold_pct?: number | null;
  threshold_amount?: number | null;
  recipient_user_id?: number | null;
  recipient_role_id?: number | null;
  labor_template?: string | null;
  dedupe_window_minutes?: number | null;
  requires_ack?: boolean | null;
  is_active?: boolean | null;
}

export interface UpdateBudgetAlertConfigInput {
  budget_bucket?: string | null;
  threshold_pct?: number | null;
  threshold_amount?: number | null;
  recipient_user_id?: number | null;
  recipient_role_id?: number | null;
  labor_template?: string | null;
  dedupe_window_minutes?: number | null;
  requires_ack?: boolean | null;
  is_active?: boolean | null;
}

export interface BudgetAlertEvent {
  id: number;
  alert_config_id: number | null;
  budget_version_id: number;
  cost_center_id: number;
  cost_center_code: string;
  cost_center_name: string;
  period_month: number | null;
  budget_bucket: string;
  alert_type: string;
  severity: string;
  title: string;
  message: string;
  dedupe_key: string;
  current_value: number;
  threshold_value: number | null;
  variance_amount: number | null;
  currency_code: string;
  payload_json: string | null;
  notification_event_id: number | null;
  notification_id: number | null;
  acknowledged_at: string | null;
  acknowledged_by_id: number | null;
  acknowledgement_note: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetAlertEventFilter {
  budget_version_id?: number | null;
  cost_center_id?: number | null;
  alert_type?: string | null;
  acknowledged_only?: boolean | null;
}

export interface EvaluateBudgetAlertsInput {
  budget_version_id: number;
  emit_notifications?: boolean | null;
}

export interface AcknowledgeBudgetAlertInput {
  alert_event_id: number;
  note?: string | null;
}

export interface BudgetAlertEvaluationResult {
  evaluated_at: string;
  emitted_count: number;
  deduped_count: number;
  considered_rows: number;
  events: BudgetAlertEvent[];
}

export interface BudgetReportPackFilter {
  budget_version_id: number;
  cost_center_id?: number | null;
  period_month_start?: number | null;
  period_month_end?: number | null;
  budget_bucket?: string | null;
  spend_mix?: string | null;
  team_id?: number | null;
  assignee_id?: number | null;
  labor_lane?: string | null;
  variance_driver_code?: string | null;
}

export interface BudgetReportPackTotals {
  baseline_amount: number;
  commitment_amount: number;
  posted_actual_amount: number;
  forecast_amount: number;
  variance_amount: number;
  variance_pct: number;
}

export interface BudgetReportPack {
  generated_at: string;
  budget_version_id: number;
  fiscal_year: number;
  scenario_type: string;
  version_status: string;
  currency_code: string;
  posting_status_filter: string;
  forecast_method_mix_json: string;
  totals: BudgetReportPackTotals;
  spend_mix_json: string;
  top_work_orders_json: string;
  top_assets_json: string;
  workforce_efficiency_json: string;
  explainability_json: string;
  multi_currency_flags: string[];
}

export interface ExportBudgetReportPackInput {
  filter: BudgetReportPackFilter;
  format: string;
}

export interface BudgetReportPackExport {
  format: string;
  file_name: string;
  mime_type: string;
  content: string;
  report: BudgetReportPack;
}

export const SYNC_PROTOCOL_VERSION_V1 = "v1";

export interface SyncOutboxItem {
  id: number;
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: string;
  row_version: number;
  payload_json: string;
  payload_hash: string;
  status: string;
  acknowledged_at: string | null;
  rejection_code: string | null;
  rejection_message: string | null;
  origin_machine_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncInboxItem {
  id: number;
  server_batch_id: string;
  checkpoint_token: string;
  entity_type: string;
  entity_sync_id: string;
  operation: string;
  row_version: number;
  payload_json: string;
  payload_hash: string;
  apply_status: string;
  rejection_code: string | null;
  rejection_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncCheckpoint {
  id: number;
  checkpoint_token: string | null;
  last_idempotency_key: string | null;
  protocol_version: string;
  policy_metadata_json: string | null;
  last_sync_at: string | null;
  updated_at: string;
}

export interface StageOutboxItemInput {
  idempotency_key: string;
  entity_type: string;
  entity_sync_id: string;
  operation: "create" | "update" | "delete" | "upsert" | "archive";
  row_version: number;
  payload_json: string;
  origin_machine_id?: string | null;
}

export interface ListOutboxFilter {
  status?: string | null;
  limit?: number | null;
}

export interface SyncAckInput {
  idempotency_key: string;
  entity_sync_id: string;
  operation: "create" | "update" | "delete" | "upsert" | "archive";
}

export interface SyncRejectedItemInput {
  idempotency_key: string;
  entity_sync_id: string;
  operation: "create" | "update" | "delete" | "upsert" | "archive";
  rejection_code: string;
  rejection_message: string;
}

export interface SyncInboundItemInput {
  entity_type: string;
  entity_sync_id: string;
  operation: "create" | "update" | "delete" | "upsert" | "archive";
  row_version: number;
  payload_json: string;
}

export interface ApplySyncBatchInput {
  protocol_version: string;
  server_batch_id: string;
  checkpoint_token: string;
  acknowledged_items: SyncAckInput[];
  rejected_items: SyncRejectedItemInput[];
  inbound_items: SyncInboundItemInput[];
  policy_metadata_json?: string | null;
}

export interface SyncTypedRejection {
  scope: string;
  entity_sync_id: string;
  operation: string;
  rejection_code: string;
  rejection_message: string;
}

export interface ApplySyncBatchResult {
  protocol_version: string;
  checkpoint_token: string | null;
  checkpoint_advanced: boolean;
  acknowledged_count: number;
  rejected_count: number;
  inbound_applied_count: number;
  inbound_duplicate_count: number;
  typed_rejections: SyncTypedRejection[];
}

export interface SyncPushPayload {
  protocol_version: string;
  checkpoint_token: string | null;
  outbox_batch: SyncOutboxItem[];
}

export interface SyncStateSummary {
  protocol_version: string;
  checkpoint: SyncCheckpoint | null;
  pending_outbox_count: number;
  rejected_outbox_count: number;
  inbox_error_count: number;
}

export interface SyncConflictFilter {
  statuses?: string[] | null;
  conflict_type?: string | null;
  requires_operator_review?: boolean | null;
  limit?: number | null;
}

export interface SyncConflictRecord {
  id: number;
  conflict_key: string;
  source_scope: string;
  source_batch_id: string | null;
  linked_outbox_id: number | null;
  linked_inbox_id: number | null;
  entity_type: string;
  entity_sync_id: string;
  operation: string;
  conflict_type: string;
  local_payload_json: string | null;
  inbound_payload_json: string | null;
  authority_side: string;
  checkpoint_token: string | null;
  auto_resolution_policy: string;
  requires_operator_review: boolean;
  recommended_action: string;
  status: string;
  resolution_action: string | null;
  resolution_note: string | null;
  resolved_by_id: number | null;
  resolved_at: string | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export interface ResolveSyncConflictInput {
  conflict_id: number;
  expected_row_version: number;
  action: "accept_local" | "accept_remote" | "merge_fields" | "retry_later" | "escalate" | "dismiss";
  resolution_note?: string | null;
}

export interface ReplaySyncFailuresInput {
  replay_key: string;
  mode: "single_item" | "batch" | "window" | "checkpoint_rollback";
  reason: string;
  conflict_id?: number | null;
  outbox_id?: number | null;
  server_batch_id?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  checkpoint_token?: string | null;
}

export interface SyncReplayRun {
  id: number;
  replay_key: string;
  mode: string;
  status: string;
  reason: string;
  requested_by_id: number;
  scope_json: string | null;
  pre_replay_checkpoint: string | null;
  post_replay_checkpoint: string | null;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ReplaySyncFailuresResult {
  run: SyncReplayRun;
  requeued_outbox_count: number;
  transitioned_conflict_count: number;
  checkpoint_token_after: string | null;
  guard_applied: boolean;
}

export const ENTITLEMENT_SIGNATURE_ALG_V1 = "sha256:issuer-key-v1";

export interface EntitlementEnvelopeInput {
  envelope_id: string;
  previous_envelope_id?: string | null;
  lineage_version: number;
  issuer: string;
  key_id: string;
  signature_alg: string;
  tier: string;
  state: "active" | "grace" | "expired" | "suspended" | "revoked" | string;
  channel: string;
  machine_slots: number;
  feature_flags_json: string;
  capabilities_json: string;
  policy_json: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  offline_grace_until: string;
  signature: string;
}

export interface EntitlementEnvelope {
  id: number;
  envelope_id: string;
  previous_envelope_id: string | null;
  lineage_version: number;
  issuer: string;
  key_id: string;
  signature_alg: string;
  tier: string;
  state: string;
  channel: string;
  machine_slots: number;
  feature_flags_json: string;
  capabilities_json: string;
  policy_json: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  offline_grace_until: string;
  payload_hash: string;
  signature: string;
  verified_at: string | null;
  verification_result: string;
  created_at: string;
}

export interface EntitlementRefreshResult {
  envelope_id: string;
  verified: boolean;
  verification_result: string;
  effective_state: string;
  active_lineage_version: number;
}

export interface EntitlementSummary {
  envelope_id: string | null;
  state: string;
  effective_state: string;
  tier: string | null;
  channel: string | null;
  lineage_version: number | null;
  valid_until: string | null;
  offline_grace_until: string | null;
  last_verified_at: string | null;
  capability_map_json: string;
  feature_flag_map_json: string;
}

export interface EntitlementCapabilityCheck {
  capability: string;
  allowed: boolean;
  reason: string;
  effective_state: string;
  envelope_id: string | null;
}

export interface EntitlementDiagnostics {
  summary: EntitlementSummary;
  last_refresh_at: string | null;
  last_refresh_error: string | null;
  lineage: EntitlementEnvelope[];
  runbook_links: string[];
}

export interface SyncRepairPreviewInput {
  mode: "requeue_rejected_outbox" | "retry_operator_conflicts" | "checkpoint_realign";
  reason: string;
  outbox_ids?: number[] | null;
  conflict_ids?: number[] | null;
  server_batch_id?: string | null;
  checkpoint_token?: string | null;
}

export interface SyncRepairPreview {
  plan_id: string;
  mode: string;
  reason: string;
  affected_outbox_count: number;
  affected_conflict_count: number;
  projected_checkpoint_token: string | null;
  warnings: string[];
  requires_confirmation: boolean;
  risk_level: "low" | "medium" | "high" | string;
}

export interface ExecuteSyncRepairInput {
  plan_id: string;
  confirm_phrase: string;
}

export interface SyncRepairExecutionResult {
  plan_id: string;
  mode: string;
  status: string;
  requeued_outbox_count: number;
  transitioned_conflict_count: number;
  checkpoint_token_after: string | null;
  executed_at: string;
}

export interface SyncRepairActionRecord {
  id: number;
  plan_id: string;
  mode: string;
  status: string;
  reason: string;
  created_by_id: number;
  executed_by_id: number | null;
  scope_json: string | null;
  preview_json: string | null;
  result_json: string | null;
  created_at: string;
  executed_at: string | null;
}

export interface SyncHealthMetrics {
  generated_at: string;
  pending_outbox_count: number;
  rejected_outbox_count: number;
  unresolved_conflict_count: number;
  replay_runs_last_24h: number;
  repair_runs_last_24h: number;
  checkpoint_token: string | null;
}

export interface SyncHealthAlert {
  code: string;
  severity: string;
  message: string;
  runbook_url: string;
}

export interface SyncRecoveryProof {
  workflow: string;
  reference_id: string;
  failure_at: string;
  recovered_at: string;
  duration_seconds: number;
}

export interface SyncObservabilityReport {
  metrics: SyncHealthMetrics;
  alerts: SyncHealthAlert[];
  recovery_proofs: SyncRecoveryProof[];
  diagnostics_links: string[];
}



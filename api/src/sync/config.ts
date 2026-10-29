/**
 * Sync configuration from the environment. Every value is required and range-checked; the API
 * refuses to start on a missing or out-of-range value instead of using a hidden default.
 */
export type SyncConfig = {
  /** HMAC key for v2 checkpoint and snapshot page tokens. */
  checkpointSecret: string;
  /** Log rows older than this (and passed by every active device) are compacted. */
  ingressRetentionDays: number;
  /** Stored exchange responses older than this are pruned. */
  idempotencyRetentionDays: number;
  /** How often the retention job runs. */
  retentionIntervalMinutes: number;
};

export const SYNC_CHECKPOINT_SECRET_MIN_LENGTH = 32;

function requiredInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    throw new Error(`environment variable ${name} is required (integer ${min}..${max}, see .env.example).`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`environment variable ${name} must be an integer ${min}..${max}, got '${raw}'.`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`environment variable ${name} must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

export function loadSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const secret = env["SYNC_CHECKPOINT_SECRET"]?.trim() ?? "";
  if (secret.length < SYNC_CHECKPOINT_SECRET_MIN_LENGTH) {
    throw new Error(
      `environment variable SYNC_CHECKPOINT_SECRET is required (at least ${SYNC_CHECKPOINT_SECRET_MIN_LENGTH} characters, see .env.example).`,
    );
  }
  return {
    checkpointSecret: secret,
    ingressRetentionDays: requiredInt(env, "SYNC_INGRESS_RETENTION_DAYS", 1, 3650),
    idempotencyRetentionDays: requiredInt(env, "SYNC_IDEMPOTENCY_RETENTION_DAYS", 1, 3650),
    retentionIntervalMinutes: requiredInt(env, "SYNC_RETENTION_INTERVAL_MINUTES", 5, 1440),
  };
}

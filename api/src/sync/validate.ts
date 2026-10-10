import type { SyncEntityRegistry } from "./registry.js";
import {
  isValidSha256Hex,
  normalizePayloadHash,
  sha256Hex,
  type SyncOutboxItem,
  type SyncOutboxItemV2,
  type SyncRejectedItem,
  type SyncRejectedItemV2,
} from "./types.js";

export type ItemValidationOk = { ok: true };
export type ItemValidationFail = {
  ok: false;
  rejection_code: string;
  rejection_message: string;
};

const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

function fail(rejection_code: string, rejection_message: string): ItemValidationFail {
  return { ok: false, rejection_code, rejection_message };
}

function validatePayloadHash(item: SyncOutboxItem): ItemValidationOk | ItemValidationFail {
  const hash = normalizePayloadHash(item.payload_hash);
  if (!isValidSha256Hex(hash)) {
    return fail(
      "invalid_payload_hash",
      "payload_hash must be 64 lowercase hex characters (optional sha256: prefix).",
    );
  }
  if (hash !== sha256Hex(item.payload_json)) {
    return fail("payload_hash_mismatch", "payload_hash does not match SHA-256 of payload_json.");
  }
  return { ok: true };
}

function validatePayloadJson(item: SyncOutboxItem): ItemValidationOk | ItemValidationFail {
  try {
    JSON.parse(item.payload_json);
  } catch {
    return fail("invalid_payload_json", "payload_json must be valid JSON.");
  }
  return { ok: true };
}

/** v1 item rules (unchanged): any well-formed entity type is accepted. */
export function validateOutboxItem(item: SyncOutboxItem): ItemValidationOk | ItemValidationFail {
  if (!ENTITY_TYPE_PATTERN.test(item.entity_type.trim())) {
    return fail("invalid_entity_type", "entity_type must be lowercase snake_case identifier.");
  }
  const hash = validatePayloadHash(item);
  if (!hash.ok) return hash;
  if (item.row_version < 0 || !Number.isInteger(item.row_version)) {
    return fail("invalid_row_version", "row_version must be a non-negative integer.");
  }
  return validatePayloadJson(item);
}

/**
 * v2 item rules, in the order documented in SYNC_PROTOCOL_V2.md §3.1: entity type format →
 * registry → owner rule → payload hash → payload JSON → row-version rule.
 */
export function validateOutboxItemV2(
  item: SyncOutboxItemV2,
  registry: SyncEntityRegistry,
): ItemValidationOk | ItemValidationFail {
  if (!ENTITY_TYPE_PATTERN.test(item.entity_type)) {
    return fail("invalid_entity_type", "entity_type must be lowercase snake_case identifier.");
  }
  const scope = registry.scopeOf(item.entity_type);
  if (!scope) {
    return fail(
      "unknown_entity_type",
      `entity_type '${item.entity_type}' is not in the sync entity registry (shared/sync-entity-registry.v2.json).`,
    );
  }
  const owner = item.owner_user_sync_id ?? null;
  if (scope === "user" && owner === null) {
    return fail(
      "missing_owner_user_sync_id",
      `entity_type '${item.entity_type}' is user-scoped: owner_user_sync_id is required.`,
    );
  }
  if (scope === "tenant" && owner !== null) {
    return fail(
      "unexpected_owner_user_sync_id",
      `entity_type '${item.entity_type}' is tenant-scoped: owner_user_sync_id must be null.`,
    );
  }
  const hash = validatePayloadHash(item);
  if (!hash.ok) return hash;
  const json = validatePayloadJson(item);
  if (!json.ok) return json;
  const expectedRowVersion = item.base_row_version === null ? 1 : item.base_row_version + 1;
  if (item.row_version !== expectedRowVersion) {
    return fail(
      "invalid_row_version",
      `row_version must be ${expectedRowVersion} (base_row_version ${item.base_row_version ?? "null"} + 1).`,
    );
  }
  return { ok: true };
}

export function toRejected(
  item: SyncOutboxItem,
  rejection_code: string,
  rejection_message: string,
): SyncRejectedItem {
  return {
    idempotency_key: item.idempotency_key,
    entity_sync_id: item.entity_sync_id,
    operation: item.operation,
    rejection_code,
    rejection_message,
  };
}

export function toRejectedV2(
  item: SyncOutboxItemV2,
  rejection_code: string,
  rejection_message: string,
): SyncRejectedItemV2 {
  return {
    idempotency_key: item.idempotency_key,
    entity_type: item.entity_type,
    entity_sync_id: item.entity_sync_id,
    operation: item.operation,
    rejection_code,
    rejection_message,
  };
}

export function shouldRedactPayloadLog(entityType: string): boolean {
  return entityType === "user_accounts";
}

import {
  isValidSha256Hex,
  normalizePayloadHash,
  sha256Hex,
  SYNC_KNOWN_ENTITY_TYPES,
  type SyncOutboxItem,
  type SyncRejectedItem,
} from "./types.js";

export type ItemValidationOk = { ok: true };
export type ItemValidationFail = {
  ok: false;
  rejection_code: string;
  rejection_message: string;
};

export function validateOutboxItem(item: SyncOutboxItem): ItemValidationOk | ItemValidationFail {
  const entityType = item.entity_type.trim();
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(entityType)) {
    return {
      ok: false,
      rejection_code: "invalid_entity_type",
      rejection_message: "entity_type must be lowercase snake_case identifier.",
    };
  }
  // Known set is documentation; unknown well-formed types are accepted for forward compatibility.
  void SYNC_KNOWN_ENTITY_TYPES;

  const hash = normalizePayloadHash(item.payload_hash);
  if (!isValidSha256Hex(hash)) {
    return {
      ok: false,
      rejection_code: "invalid_payload_hash",
      rejection_message: "payload_hash must be 64 lowercase hex characters (optional sha256: prefix).",
    };
  }

  const expected = sha256Hex(item.payload_json);
  if (hash !== expected) {
    return {
      ok: false,
      rejection_code: "payload_hash_mismatch",
      rejection_message: "payload_hash does not match SHA-256 of payload_json.",
    };
  }

  if (item.row_version < 0 || !Number.isInteger(item.row_version)) {
    return {
      ok: false,
      rejection_code: "invalid_row_version",
      rejection_message: "row_version must be a non-negative integer.",
    };
  }

  try {
    JSON.parse(item.payload_json);
  } catch {
    return {
      ok: false,
      rejection_code: "invalid_payload_json",
      rejection_message: "payload_json must be valid JSON.",
    };
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

export function shouldRedactPayloadLog(entityType: string): boolean {
  return entityType === "user_accounts";
}

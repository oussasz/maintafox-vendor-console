/**
 * Encryption at rest of sync data the server never needs to read (master plan Phase 3.2).
 *
 * Sealed: payloads of SENSITIVE_SYNC_ENTITY_TYPES in the log and the current state, and every
 * stored exchange response (they carry delivered payloads and conflict rows). AES-256-GCM with
 * SYNC_PAYLOAD_ENCRYPTION_KEY; the additional authenticated data binds a value to its row
 * (tenant, entity / device, key), so a sealed value copied to another row does not open.
 *
 * Stored form: `mfxenc:v1:<key id>:<iv>:<ciphertext + tag>` (base64url). Values written before
 * this existed are plaintext and are returned unchanged by `open`. The payload hash is computed
 * by the device over the plaintext and is stored and checked as before; delivery opens the value,
 * so the device receives the same bytes it would have received without encryption.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "mfxenc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Entity types whose payloads are stored encrypted (user accounts carry credentials and PII). */
export const SENSITIVE_SYNC_ENTITY_TYPES: ReadonlySet<string> = new Set(["user_accounts"]);

export function isSensitiveSyncEntityType(entityType: string): boolean {
  return SENSITIVE_SYNC_ENTITY_TYPES.has(entityType);
}

export class PayloadCipher {
  /** First 16 hex characters of SHA-256(key): names the key in every sealed value. */
  readonly keyId: string;

  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`payload encryption key must be ${KEY_BYTES} bytes`);
    this.keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  }

  static isSealed(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${PREFIX}${this.keyId}:${iv.toString("base64url")}:${body.toString("base64url")}`;
  }

  /** Opens a sealed value; a plaintext value (written before encryption existed) is returned as is. */
  open(stored: string, aad: string): string {
    if (!PayloadCipher.isSealed(stored)) return stored;
    const [keyId, ivText, bodyText] = stored.slice(PREFIX.length).split(":");
    if (!keyId || !ivText || !bodyText) throw new Error("sealed sync value is malformed");
    if (keyId !== this.keyId) {
      throw new Error(
        `sealed sync value uses key ${keyId}, but SYNC_PAYLOAD_ENCRYPTION_KEY is key ${this.keyId} (restore the previous key)`,
      );
    }
    const body = Buffer.from(bodyText, "base64url");
    if (body.length < TAG_BYTES) throw new Error("sealed sync value is truncated");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

/** SYNC_PAYLOAD_ENCRYPTION_KEY: base64 of exactly 32 random bytes (`openssl rand -base64 32`). */
export function loadPayloadCipher(env: NodeJS.ProcessEnv = process.env): PayloadCipher {
  const raw = env["SYNC_PAYLOAD_ENCRYPTION_KEY"]?.trim();
  if (!raw) {
    throw new Error(
      "environment variable SYNC_PAYLOAD_ENCRYPTION_KEY is required (base64 of 32 random bytes: `openssl rand -base64 32`, see .env.example).",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== raw) {
    throw new Error("SYNC_PAYLOAD_ENCRYPTION_KEY must be the base64 encoding of exactly 32 bytes.");
  }
  return new PayloadCipher(key);
}

/** Additional authenticated data: a payload belongs to one entity of one tenant. */
export function entityAad(tenantId: string, entityType: string, entitySyncId: string): string {
  return `entity|${tenantId}|${entityType}|${entitySyncId}`;
}

/** Additional authenticated data: a stored exchange response belongs to one request of one device. */
export function responseAad(tenantId: string, machineFingerprint: string, idempotencyKey: string): string {
  return `response|${tenantId}|${machineFingerprint}|${idempotencyKey}`;
}

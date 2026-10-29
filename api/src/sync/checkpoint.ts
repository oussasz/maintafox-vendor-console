import { createHmac, timingSafeEqual } from "node:crypto";

// ── v1: tenant-global checkpoint (unchanged wire format) ─────────────────────

/**
 * v1 checkpoint advancement rule: advance only when the client batch has zero permanent
 * validation failures. An empty outbox advances (pull-only / heartbeat exchange).
 */
export function shouldAdvanceCheckpoint(permanentRejectCount: number): boolean {
  return permanentRejectCount === 0;
}

export function nextCheckpointToken(tenantId: string, nextSeq: number): string {
  return `cp-${tenantId}-${nextSeq}`;
}

export function initialCheckpointToken(tenantId: string): string {
  return `cp-${tenantId}-0`;
}

// ── v2: signed per-device tokens ─────────────────────────────────────────────
//
// Format: `v2.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "v2." + payloadPart))>`.
// The `k` field separates token kinds so a snapshot page token can never pass as a checkpoint.

export type CheckpointClaims = { tenantId: string; machineFingerprint: string; seq: number };

export type SnapshotPageClaims = {
  tenantId: string;
  machineFingerprint: string;
  /** Snapshot high-water mark fixed on the first page. */
  highWater: number;
  scope: "all" | "user";
  /** SHA-256 of the sorted user list, so the page set cannot change mid-snapshot. */
  usersHash: string;
  /** Keyset position: last (entity_type, entity_sync_id) returned. */
  after: [string, string];
};

const TOKEN_PREFIX = "v2.";

function sign(secret: string, payloadPart: string): string {
  return createHmac("sha256", secret).update(TOKEN_PREFIX + payloadPart, "utf8").digest("base64url");
}

function encode(secret: string, payload: Record<string, unknown>): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${TOKEN_PREFIX}${payloadPart}.${sign(secret, payloadPart)}`;
}

/** Returns the verified payload, or null for any malformed or unsigned token. */
function decode(secret: string, token: string): Record<string, unknown> | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot !== rest.lastIndexOf(".")) return null;
  const payloadPart = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(secret, payloadPart), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function signCheckpointToken(secret: string, claims: CheckpointClaims): string {
  return encode(secret, {
    k: "cp",
    t: claims.tenantId,
    d: claims.machineFingerprint,
    s: claims.seq,
    i: new Date().toISOString(),
  });
}

export function verifyCheckpointToken(secret: string, token: string): CheckpointClaims | null {
  const p = decode(secret, token);
  if (!p || p["k"] !== "cp") return null;
  const seq = p["s"];
  if (typeof p["t"] !== "string" || typeof p["d"] !== "string") return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { tenantId: p["t"], machineFingerprint: p["d"], seq };
}

export function signSnapshotPageToken(secret: string, claims: SnapshotPageClaims): string {
  return encode(secret, {
    k: "snap",
    t: claims.tenantId,
    d: claims.machineFingerprint,
    h: claims.highWater,
    s: claims.scope,
    u: claims.usersHash,
    a: claims.after,
  });
}

export function verifySnapshotPageToken(secret: string, token: string): SnapshotPageClaims | null {
  const p = decode(secret, token);
  if (!p || p["k"] !== "snap") return null;
  const h = p["h"];
  const a = p["a"];
  if (typeof p["t"] !== "string" || typeof p["d"] !== "string" || typeof p["u"] !== "string") return null;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) return null;
  if (p["s"] !== "all" && p["s"] !== "user") return null;
  if (!Array.isArray(a) || a.length !== 2 || typeof a[0] !== "string" || typeof a[1] !== "string") return null;
  return {
    tenantId: p["t"],
    machineFingerprint: p["d"],
    highWater: h,
    scope: p["s"],
    usersHash: p["u"],
    after: [a[0], a[1]],
  };
}

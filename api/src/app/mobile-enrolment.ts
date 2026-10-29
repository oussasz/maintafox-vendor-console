/**
 * Admin-issued phone enrolment (migration 020, owner-approved 2026-10-29). An administrator on an
 * activated desktop issues an enrolment for one person at one site; the phone presents its
 * one-time secret (the QR token, or the 8-character typed code) instead of the licence key.
 *
 * The lifetime and the code format are part of the approved design, not customer settings.
 */
import { createHmac, randomBytes, randomInt } from "node:crypto";

import type express from "express";
import { z } from "zod";

import type { Database } from "../db/database.js";
import type { AuditAppender } from "./audit.js";
import { JWT_SECRET } from "./config.js";
import { newId, structuredLog } from "./runtime.js";
import { runAsSystem, tenantScope } from "./scope.js";

/** An enrolment can be used for this long after it is issued. */
export const ENROLMENT_TTL_SECONDS = 15 * 60;

/** QR token: 32 random bytes, base64url (43 characters). */
const TOKEN_BYTES = 32;

/**
 * Typed fallback code: 8 characters of Crockford base32 (40 bits), shown as XXXX-XXXX. Single use,
 * 15 minutes, and redeem attempts are rate-limited per address, so guessing one is impractical.
 */
export const CODE_LENGTH = 8;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newEnrolmentToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function newEnrolmentCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** The code as shown to the administrator. */
export function formatEnrolmentCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a person typed, in the alphabet's canonical form: case, spaces and dashes ignored, and the
 * letters Crockford base32 reads as digits (I, L -> 1; O -> 0). Null when it cannot be a code.
 */
export function normaliseEnrolmentCode(typed: string): string | null {
  const canonical = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (canonical.length !== CODE_LENGTH) return null;
  for (const ch of canonical) if (!CODE_ALPHABET.includes(ch)) return null;
  return canonical;
}

/**
 * Stored form of a secret: HMAC-SHA256 under a key derived from the server secret, with the kind
 * in the input so a token can never match a code. A copy of the database alone cannot test codes.
 */
export function enrolmentSecretHash(serverSecret: string, kind: "token" | "code", value: string): string {
  const key = createHmac("sha256", serverSecret).update("maintafox-mobile-enrolment-v1").digest();
  return createHmac("sha256", key).update(`${kind}:${value}`).digest("hex");
}

const Label = z.string().trim().min(1).max(128);
const SyncId = z.string().trim().min(1).max(128);

/** Desktop -> server: issue an enrolment (the desktop checked the user-admin right and step-up). */
export const IssueEnrolmentBody = z
  .object({
    person_sync_id: SyncId,
    person_label: Label,
    site_sync_id: SyncId,
    site_label: Label,
    issued_by_sync_id: SyncId,
    issued_by_label: Label,
  })
  .strict();

/** Desktop -> server: who cancels an enrolment or revokes a phone. */
export const ActorBody = z
  .object({
    actor_sync_id: SyncId,
    actor_label: Label,
  })
  .strict();

/** Desktop -> server: a disabled user's phones are all revoked. */
export const RevokePersonBody = ActorBody.extend({ person_sync_id: SyncId }).strict();

/** Phone -> server: exactly one of the QR token or the typed code. */
export const RedeemEnrolmentBody = z
  .object({
    token: z.string().min(16).max(128).optional(),
    code: z.string().min(1).max(32).optional(),
    machine_fingerprint: z.string().min(8).max(256),
    machine_label: z.string().max(128).optional(),
    app_version: z.string().max(32).optional(),
    device_class: z.literal("mobile"),
  })
  .strict()
  .refine((b) => (b.token === undefined) !== (b.code === undefined), {
    message: "Send exactly one of token or code.",
  });

/** 403 when a phone presents the licence key: phones are enrolled by an administrator only. */
export const MOBILE_ENROLMENT_REQUIRED_BODY = {
  error: "mobile_enrolment_required",
  message: "Phones are enrolled with a QR code issued by an administrator, not with the licence key.",
  device_class: "mobile",
} as const;

/** 404 for an unknown, used, cancelled or expired enrolment: the phone cannot tell which. */
export const ENROLMENT_INVALID_BODY = {
  error: "enrolment_invalid",
  message: "This enrolment code is not valid: it was used, cancelled or has expired. Ask your administrator for a new one.",
} as const;

/** 403 on every route but the final upload and the wipe confirmation, for a phone revoked by its administrator. */
export const DEVICE_WIPE_REQUIRED_BODY = {
  error: "device_wipe_required",
  message: "This phone was removed by your administrator. Pending work is uploaded, then the phone's data is erased.",
} as const;

/** 409 when an enrolled, active phone presents another enrolment. */
export const ALREADY_ENROLLED_BODY = {
  error: "already_enrolled",
  message: "This phone is already enrolled. Your administrator must remove it before it can be enrolled again.",
} as const;

/** An enrolment row as the redeem and desktop routes read it. */
export type EnrolmentRow = {
  id: string;
  tenant_id: string;
  license_id: string;
  person_sync_id: string;
  person_label: string;
  site_sync_id: string;
  site_label: string;
  issued_by_label: string;
  expires_at: string;
  cancelled_at: string | null;
  redeemed_at: string | null;
};

/** Stored hash of what a phone presents; null for a typed code that cannot be one. */
export function redeemSecretHash(input: { token?: string; code?: string }): string | null {
  if (input.token !== undefined) return enrolmentSecretHash(JWT_SECRET, "token", input.token.trim());
  const code = normaliseEnrolmentCode(input.code ?? "");
  return code ? enrolmentSecretHash(JWT_SECRET, "code", code) : null;
}

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>;

/**
 * Redeem presents only the secret: its tenant is resolved by the one cross-tenant lookup allowed
 * here (mfx_mobile_enrolment_tenant, migration 020) and the request runs in that tenant's scope. An
 * unknown secret gets no scope, so it finds nothing (404 enrolment_invalid).
 */
export function enrolmentSecretTenantScopeMiddleware(db: Database): Middleware {
  return async (req, _res, next) => {
    const body = req.body as { token?: unknown; code?: unknown } | undefined;
    const hash =
      typeof body?.token === "string" || typeof body?.code === "string"
        ? redeemSecretHash({
            token: typeof body.token === "string" ? body.token : undefined,
            code: typeof body.token === "string" ? undefined : (body.code as string),
          })
        : null;
    const row = hash
      ? await db.get<{ tenant_id: string | null }>("SELECT mfx_mobile_enrolment_tenant($1) AS tenant_id", hash)
      : undefined;
    if (row?.tenant_id) {
      db.runInScope(tenantScope(row.tenant_id), next);
      return;
    }
    next();
  };
}

/**
 * Appends an enrolment event to the vendor audit ledger. The ledger is written only in an
 * operator/system scope (migration 007), while enrolment requests run in their tenant's scope, so
 * the record is appended after the tenant transaction commits. The tenant rows keep the durable
 * trail of every step (mobile_enrolments: issued/cancelled/redeemed; machine_activations:
 * enrolled/revoked/wiped), and the customer's desktop and phone write their own audit; a ledger
 * failure is logged, never hidden, and does not undo a committed step.
 */
export async function appendEnrolmentAudit(
  db: Database,
  appendAuditRecord: AuditAppender["appendAuditRecord"],
  event: {
    action_code: string;
    actor: string;
    tenantId: string;
    licenseId: string;
    machineFingerprint?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await runAsSystem(db, "mobile-enrolment", () =>
      appendAuditRecord({
        actor_id: event.actor,
        action_code: event.action_code,
        action_category: "entitlement",
        correlation_id: newId("corr"),
        scope_tenant_id: event.tenantId,
        entity_refs: {
          tenant_id: event.tenantId,
          entitlement_id: event.licenseId,
          ...(event.machineFingerprint ? { machine_id: event.machineFingerprint } : {}),
        },
        payload: event.payload,
      }),
    );
  } catch (e) {
    structuredLog("mobile_enrolment_audit_failed", {
      action_code: event.action_code,
      tenant_id: event.tenantId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * POST /api/v1/notifications/email (deploy/NOTIFICATION_EMAIL.md): a desktop asks the server to
 * email one notification. The desktop never handles SMTP or addresses: the server resolves the
 * recipient from its own copy of the tenant's user accounts, renders plain text and sends.
 *
 * Contract (desktop src-tauri/src/notifications/email.rs): 202 {request_id, status: accepted |
 * duplicate}; 400 invalid body; 403 email not enabled for the tenant's edition; 404 recipient
 * unknown, inactive or without an address; 409 request_id reused with another body; 502 the SMTP
 * server refused or failed (the desktop retries); 503 email delivery not configured.
 */
import type express from "express";
import { z } from "zod";

import { EMAIL_CONFIG } from "../app/config.js";
import type { ApiContext } from "../app/context.js";
import { deviceRateLimiter, sendValidationError, type ActivationAuthContext } from "../app/http.js";
import { structuredLog } from "../app/runtime.js";
import { loadCapabilitiesJsonForSign } from "../edition-catalog-store.js";
import { createEmailSender, renderNotificationEmail } from "../notifications/email.js";
import { canonicalJson } from "../sync/exchange-v2.js";
import { getEntityState } from "../sync/store.js";
import { sha256Hex } from "../sync/types.js";

/** Edition capability that enables the email channel (off unless an operator turns it on). */
export const EMAIL_CAPABILITY = "notifications.email";

const NotificationEmailBody = z
  .object({
    request_id: z.string().min(1).max(256),
    notification_sync_id: z.string().min(1).max(256),
    recipient_user_sync_id: z.string().min(1).max(256),
    category_code: z.string().min(1).max(64),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(8000).nullable(),
    action_url: z.string().max(512).nullable(),
    occurred_at: z.string().datetime({ offset: true }),
    source_module: z.string().min(1).max(64),
    source_record_id: z.string().max(256).nullable(),
  })
  .strict();

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerNotificationsRoutes(app: express.Express, ctx: ApiContext): void {
  const { db, activationAuthMiddleware, payloadCipher } = ctx;
  const sender = EMAIL_CONFIG.mode === "smtp" ? createEmailSender(EMAIL_CONFIG) : null;

  app.post("/api/v1/notifications/email", activationAuthMiddleware, deviceRateLimiter, async (req, res) => {
    const act = (req as express.Request & { activation?: ActivationAuthContext }).activation!;
    if (!sender) {
      res.status(503).json({ error: "email_not_configured", message: "Email delivery is not configured on this server." });
      return;
    }
    const parsed = NotificationEmailBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed, "body");
      return;
    }
    const input = parsed.data;

    const tenant = await db.get<{ display_name: string; edition: string }>(
      "SELECT display_name, COALESCE(edition, 'core') AS edition FROM tenants WHERE id = ?",
      act.tenantId,
    );
    const capabilities = tenant ? await loadCapabilitiesJsonForSign(db, tenant.edition) : null;
    const enabled = capabilities ? (JSON.parse(capabilities.capabilities_json) as Record<string, unknown>)[EMAIL_CAPABILITY] === true : false;
    if (!tenant || !enabled) {
      res.status(403).json({ error: "email_not_enabled", message: `The edition does not enable ${EMAIL_CAPABILITY}.` });
      return;
    }

    const requestHash = sha256Hex(canonicalJson(input));
    const outcome = await db.tx(async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      // One sender per (tenant, request_id): devices holding the same notification send it once.
      await db.lockXact("notification-email", `${act.tenantId}:${input.request_id}`);
      const existing = await db.get<{ request_hash: string; status: string; attempts: number }>(
        "SELECT request_hash, status, attempts FROM notification_email_requests WHERE tenant_id = ? AND request_id = ?",
        act.tenantId,
        input.request_id,
      );
      if (existing && existing.request_hash !== requestHash) {
        return { status: 409, body: { error: "request_id_conflict", message: "request_id was already used with a different notification." } };
      }
      if (existing?.status === "sent") {
        return { status: 202, body: { request_id: input.request_id, status: "duplicate" } };
      }

      const state = await getEntityState(db, payloadCipher, act.tenantId, "user_accounts", input.recipient_user_sync_id);
      if (!state || state.deleted) {
        return { status: 404, body: { error: "recipient_not_found", message: "The recipient is not a user of this tenant." } };
      }
      let account: Record<string, unknown>;
      try {
        account = JSON.parse(state.payload_raw) as Record<string, unknown>;
      } catch {
        return { status: 404, body: { error: "recipient_not_found", message: "The recipient record cannot be read." } };
      }
      if (account["is_active"] === 0 || account["is_active"] === false) {
        return { status: 404, body: { error: "recipient_inactive", message: "The recipient's account is not active." } };
      }
      const address = typeof account["email"] === "string" ? account["email"].trim() : "";
      if (!EMAIL_ADDRESS.test(address)) {
        return { status: 404, body: { error: "recipient_has_no_email", message: "The recipient has no email address." } };
      }

      const mail = renderNotificationEmail({
        tenantName: tenant.display_name,
        severity: input.severity,
        title: input.title,
        body: input.body,
        categoryCode: input.category_code,
        sourceModule: input.source_module,
        occurredAt: input.occurred_at,
        actionUrl: input.action_url,
      });
      let error: string | null = null;
      try {
        await sender.send({ to: address, subject: mail.subject, text: mail.text });
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }
      await db.run(
        `INSERT INTO notification_email_requests
           (tenant_id, request_id, request_hash, notification_sync_id, recipient_user_sync_id, machine_fingerprint,
            status, attempts, last_error, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, now(), CASE WHEN ? = 'sent' THEN now() END)
         ON CONFLICT (tenant_id, request_id) DO UPDATE SET
           status = EXCLUDED.status,
           attempts = notification_email_requests.attempts + 1,
           last_error = EXCLUDED.last_error,
           machine_fingerprint = EXCLUDED.machine_fingerprint,
           sent_at = EXCLUDED.sent_at`,
        act.tenantId,
        input.request_id,
        requestHash,
        input.notification_sync_id,
        input.recipient_user_sync_id,
        act.machineFingerprint,
        error ? "failed" : "sent",
        error,
        error ? "failed" : "sent",
      );
      structuredLog(error ? "notification_email_failed" : "notification_email_sent", {
        tenant_id: act.tenantId,
        request_id: input.request_id,
        machine_fingerprint: act.machineFingerprint,
        ...(error ? { error } : {}),
      });
      return error
        ? { status: 502, body: { error: "email_send_failed", message: error } }
        : { status: 202, body: { request_id: input.request_id, status: "accepted" } };
    });
    res.status(outcome.status).json(outcome.body);
  });
}

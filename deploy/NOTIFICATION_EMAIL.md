# Notification email (desktop Phase 6.7 channel, server side)

`POST /api/v1/notifications/email` (device activation token). Contract: desktop
`src-tauri/src/notifications/email.rs`. Code: `api/src/routes/notifications.ts`,
`api/src/notifications/email.ts`, migration `010_notification_email.sql`.

- The desktop never sees SMTP or addresses: the server reads the recipient's `email` from its own
  copy of the tenant's `user_accounts` (decrypted for this one row; stored encrypted at rest).
- Answers: `202 {request_id, status: accepted | duplicate}`; `400` invalid body; `403
  email_not_enabled`; `404 recipient_not_found | recipient_inactive | recipient_has_no_email`; `409
  request_id_conflict`; `502 email_send_failed` (the desktop retries); `503 email_not_configured`.
- One email per `(tenant, request_id)`, even when several devices dispatch the same notification.
  `notification_email_requests` keeps status and attempts only: no address, no text.
- Plain text only (no HTML, no tracking).

## Turning it on (owner / main session)
1. Choose an SMTP provider (any: the company mail server, Brevo, Mailjet, Amazon SES, ...) and set
   in `.env`: `EMAIL_DELIVERY_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `EMAIL_FROM`, and
   `SMTP_USER` + `SMTP_PASSWORD` if the provider needs them. Configure SPF/DKIM for the `EMAIL_FROM`
   domain at the provider, or the mails land in spam.
2. Restart the API (`docker compose up -d api`).
3. In the console, Editions: turn on `notifications.email` for the editions that include email
   (off in every factory edition). Desktops pick it up with their next policy refresh.

Until then `EMAIL_DELIVERY_MODE=disabled`: the endpoint answers 503 and, since the capability is
off, desktops do not offer the channel.

Test: `node scripts/notification-email.integration.mjs` (real SMTP server on 127.0.0.1, in `test:all`).

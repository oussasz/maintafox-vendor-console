/**
 * Lost-authenticator recovery for a vendor-console operator (deploy/VENDOR_AUTH.md):
 *
 *   node dist/tools/vendor-mfa-reset.js --email <operator email> --reason "<why, at least 10 characters>"
 *
 * Run on the server, inside the control-api container (it uses the container's DATABASE_URL and
 * SYNC_PAYLOAD_ENCRYPTION_KEY). It removes the operator's TOTP secret and recovery codes and ends
 * all their sessions; their next login (password) leads them through TOTP enrolment again, which
 * needs the one-time `reset_code` printed here (so the password alone cannot claim the account).
 * The reset is appended to the audit ledger (actor `system:cli-vendor-mfa-reset`, with the reason
 * and the host user who ran it). The password is not changed. Prints one JSON report on stdout.
 */
import { userInfo } from "node:os";

import { createAuditAppender } from "../app/audit.js";
import { runAsSystem } from "../app/scope.js";
import { openDatabase } from "../db/database.js";
import { loadPayloadCipher } from "../sync/index.js";
import { createVendorAuth } from "../vendor-auth/service.js";

/** A reset is permanent evidence in the ledger: the reason must say something. */
export const MFA_RESET_REASON_MIN_LENGTH = 10;

type Args = { email: string; reason: string };

function parseArgs(argv: string[]): Args {
  let email: string | null = null;
  let reason: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--email") {
      email = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--reason") {
      reason = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown argument '${a}'`);
    }
  }
  if (!email || !reason) {
    throw new Error('usage: vendor-mfa-reset --email <operator email> --reason "<why>"');
  }
  if (reason.trim().length < MFA_RESET_REASON_MIN_LENGTH) {
    throw new Error(`--reason must be at least ${MFA_RESET_REASON_MIN_LENGTH} characters`);
  }
  return { email: email.trim(), reason: reason.trim() };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required (run this inside the control-api container)");
  const db = await openDatabase(databaseUrl, "maintafox-vendor-mfa-reset");
  try {
    const vendorAuth = createVendorAuth(db, loadPayloadCipher());
    const { appendAuditRecord } = createAuditAppender(db);
    const report = await runAsSystem(db, "cli-vendor-mfa-reset", async () => {
      const user = await vendorAuth.findUserByEmail(args.email);
      if (!user) throw new Error(`no vendor operator with email ${args.email}`);
      return db.tx(async () => {
        const { sessionsRevoked, resetCode } = await vendorAuth.resetMfa(user.id, "mfa_reset_cli");
        const auditRecordId = await appendAuditRecord({
          actor_id: "system:cli-vendor-mfa-reset",
          action_code: "mfa_reset",
          action_category: "vendor_auth",
          correlation_id: `cli-mfa-reset-${Date.now()}`,
          reason_code: args.reason,
          payload: {
            vendor_user_id: user.id,
            email: user.email,
            had_second_factor: user.totp_enrolled,
            sessions_revoked: sessionsRevoked,
            host_user: userInfo().username,
          },
        });
        // The code is printed once, never stored in clear and never written to the ledger.
        return {
          ok: true,
          user_id: user.id,
          email: user.email,
          sessions_revoked: sessionsRevoked,
          audit_record_id: auditRecordId,
          reset_code: resetCode,
          next_step: "Sign in with the password; when asked, enter this reset code, then scan the new QR code.",
        };
      });
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`vendor-mfa-reset failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

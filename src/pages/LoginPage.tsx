import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthApiError,
  confirmTotpEnrolment,
  login,
  startTotpEnrolment,
  verifyRecoveryCode,
  verifyTotp,
  type TotpEnrolment,
} from "@/services/vendor-auth-service";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { errorText } from "@/lib/error-text";

type Step =
  | { kind: "credentials" }
  | { kind: "resetCode"; mfaToken: string }
  | { kind: "enroll"; mfaToken: string; enrolment: TotpEnrolment; qrDataUrl: string }
  | { kind: "verify"; mfaToken: string; useRecovery: boolean }
  | { kind: "recoveryCodes"; codes: string[] }
  | { kind: "recoveryUsed"; remaining: number };

/** API error codes with their own message; anything else is shown with its code. */
const KNOWN_ERRORS = new Set([
  "invalid_credentials",
  "rate_limited",
  "invalid_mfa_code",
  "invalid_recovery_code",
  "mfa_token_invalid",
  "mfa_enrollment_required",
  "mfa_already_enrolled",
  "invalid_reset_code",
]);

/**
 * Operator sign-in (master plan Phase 4.1): password, then the second factor. On the first login
 * the operator enrols an authenticator app (QR code or key), confirms one code and receives
 * recovery codes, shown once. Nothing is kept in browser storage: the API sets an httpOnly
 * refresh cookie and the access token stays in memory.
 */
export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string; reason?: string } | null;
  const from = state?.from ?? "/vendor-console";
  const sessionExpired = state?.reason === "session_expired";
  const apiUnreachable = state?.reason === "api_unreachable";

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCode("");
    setRecoveryCode("");
    setResetCode("");
  }, [step.kind]);

  const describe = (err: unknown): string => {
    if (err instanceof AuthApiError) {
      if (KNOWN_ERRORS.has(err.code)) return t(`vendorLogin.error.${err.code}`);
      return t("vendorLogin.error.generic", { code: err.code, status: err.status });
    }
    if (err instanceof TypeError) return t("vendorLogin.error.network");
    return t("vendorLogin.error.generic", { code: errorText(err), status: "-" });
  };

  /** An expired MFA step cannot continue: back to the password form, with the reason shown. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof AuthApiError && (err.code === "mfa_token_invalid" || err.code === "mfa_enrollment_required")) {
        setStep({ kind: "credentials" });
        setPassword("");
      }
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => navigate(from, { replace: true });

  const onCredentials = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const next = await login(email.trim(), password);
      setPassword("");
      if (next.status === "mfa_required") {
        setStep({ kind: "verify", mfaToken: next.mfa_token, useRecovery: false });
        return;
      }
      if (next.reset_code_required) {
        setStep({ kind: "resetCode", mfaToken: next.mfa_token });
        return;
      }
      await beginEnrolment(next.mfa_token);
    });
  };

  const beginEnrolment = async (mfaToken: string, withResetCode?: string) => {
    const enrolment = await startTotpEnrolment(mfaToken, withResetCode);
    const qrDataUrl = await QRCode.toDataURL(enrolment.otpauth_uri, { margin: 1, width: 220 });
    setStep({ kind: "enroll", mfaToken, enrolment, qrDataUrl });
  };

  const onResetCode = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "resetCode") return;
    void run(() => beginEnrolment(step.mfaToken, resetCode.trim()));
  };

  const onEnrollConfirm = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "enroll") return;
    void run(async () => {
      const grant = await confirmTotpEnrolment(step.mfaToken, code.trim());
      setAcknowledged(false);
      setCopied(false);
      setStep({ kind: "recoveryCodes", codes: grant.recovery_codes ?? [] });
    });
  };

  const onVerify = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "verify") return;
    void run(async () => {
      if (step.useRecovery) {
        const grant = await verifyRecoveryCode(step.mfaToken, recoveryCode.trim());
        setStep({ kind: "recoveryUsed", remaining: grant.recovery_codes_remaining ?? 0 });
        return;
      }
      await verifyTotp(step.mfaToken, code.trim());
      finish();
    });
  };

  const copyCodes = async (codes: string[]) => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setError(t("vendorLogin.recovery.copyFailed"));
    }
  };

  const downloadCodes = (codes: string[]) => {
    const blob = new Blob([`${t("vendorLogin.recovery.fileHeader")}\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "maintafox-vendor-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const errorLine = error ? (
    <p role="alert" className="mt-4 text-sm text-text-danger">
      {error}
    </p>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-0 px-4">
      <LanguageSwitcher className="absolute right-4 top-4" />
      <div className="w-full max-w-md rounded-lg border border-surface-border bg-surface-1 p-6 shadow-panel">
        {step.kind === "credentials" ? (
          <form onSubmit={onCredentials}>
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("vendorLogin.subtitle")}</p>
            {sessionExpired ? (
              <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="status">
                <p className="font-medium">{t("session.expired.title")}</p>
                <p className="mt-1">{t("session.expired.message")}</p>
              </div>
            ) : null}
            {apiUnreachable ? (
              <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="status">
                {t("vendorLogin.apiUnreachable")}
              </p>
            ) : null}
            <div className="mt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("vendorLogin.email")}</Label>
                <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("vendorLogin.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            {errorLine}
            <Button type="submit" className="mt-6 w-full" disabled={busy || !email.trim() || !password}>
              {busy ? t("vendorLogin.submitting") : t("vendorLogin.submit")}
            </Button>
          </form>
        ) : null}

        {step.kind === "resetCode" ? (
          <form onSubmit={onResetCode}>
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.resetCode.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("vendorLogin.resetCode.intro")}</p>
            <div className="mt-4 space-y-2">
              <Label htmlFor="reset-code">{t("vendorLogin.resetCode.label")}</Label>
              <Input
                id="reset-code"
                autoComplete="off"
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                autoFocus
              />
            </div>
            {errorLine}
            <Button type="submit" className="mt-6 w-full" disabled={busy || resetCode.trim().length < 10}>
              {busy ? t("vendorLogin.verifying") : t("vendorLogin.continue")}
            </Button>
          </form>
        ) : null}

        {step.kind === "enroll" ? (
          <form onSubmit={onEnrollConfirm}>
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.enroll.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("vendorLogin.enroll.intro")}</p>
            <div className="mt-4 flex justify-center">
              <img src={step.qrDataUrl} alt={t("vendorLogin.enroll.qrAlt")} width={220} height={220} className="rounded bg-white p-2" />
            </div>
            <p className="mt-4 text-sm text-text-secondary">{t("vendorLogin.enroll.manual")}</p>
            <p className="mt-1 break-all rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary" data-testid="totp-secret">
              {step.enrolment.secret_base32.replace(/(.{4})/g, "$1 ").trim()}
            </p>
            <p className="mt-1 text-xs text-text-muted">{t("vendorLogin.enroll.account", { account: step.enrolment.account_name })}</p>
            <div className="mt-4 space-y-2">
              <Label htmlFor="enroll-code">{t("vendorLogin.codeLabel")}</Label>
              <Input
                id="enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </div>
            {errorLine}
            <Button type="submit" className="mt-6 w-full" disabled={busy || code.length !== 6}>
              {busy ? t("vendorLogin.verifying") : t("vendorLogin.enroll.confirm")}
            </Button>
          </form>
        ) : null}

        {step.kind === "recoveryCodes" ? (
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.recovery.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("vendorLogin.recovery.intro")}</p>
            <ul className="mt-4 grid grid-cols-2 gap-2 rounded bg-surface-2 p-3 font-mono text-sm text-text-primary" data-testid="recovery-codes">
              {step.codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copyCodes(step.codes)}>
                {copied ? t("vendorLogin.recovery.copied") : t("vendorLogin.recovery.copy")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => downloadCodes(step.codes)}>
                {t("vendorLogin.recovery.download")}
              </Button>
            </div>
            <div className="mt-4 flex items-start gap-2">
              <Checkbox id="recovery-ack" checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} />
              <Label htmlFor="recovery-ack" className="text-sm leading-snug">
                {t("vendorLogin.recovery.ack")}
              </Label>
            </div>
            {errorLine}
            <Button type="button" className="mt-6 w-full" disabled={!acknowledged} onClick={finish}>
              {t("vendorLogin.continue")}
            </Button>
          </div>
        ) : null}

        {step.kind === "verify" ? (
          <form onSubmit={onVerify}>
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.verify.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">
              {step.useRecovery ? t("vendorLogin.verify.recoveryIntro") : t("vendorLogin.verify.intro")}
            </p>
            <div className="mt-4 space-y-2">
              {step.useRecovery ? (
                <>
                  <Label htmlFor="recovery-code">{t("vendorLogin.verify.recoveryLabel")}</Label>
                  <Input
                    id="recovery-code"
                    autoComplete="off"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    autoFocus
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="verify-code">{t("vendorLogin.codeLabel")}</Label>
                  <Input
                    id="verify-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    autoFocus
                  />
                </>
              )}
            </div>
            {errorLine}
            <Button
              type="submit"
              className="mt-6 w-full"
              disabled={busy || (step.useRecovery ? recoveryCode.trim().length < 10 : code.length !== 6)}
            >
              {busy ? t("vendorLogin.verifying") : t("vendorLogin.verify.submit")}
            </Button>
            <Button
              type="button"
              variant="link"
              className="mt-2 w-full"
              onClick={() => {
                setError(null);
                setStep({ ...step, useRecovery: !step.useRecovery });
              }}
            >
              {step.useRecovery ? t("vendorLogin.verify.useCode") : t("vendorLogin.verify.useRecovery")}
            </Button>
          </form>
        ) : null}

        {step.kind === "recoveryUsed" ? (
          <div role="status">
            <h1 className="text-lg font-semibold text-text-primary">{t("vendorLogin.recoveryUsed.title")}</h1>
            <p className="mt-2 text-sm text-text-secondary">{t("vendorLogin.recoveryUsed.body", { count: step.remaining })}</p>
            <Button type="button" className="mt-6 w-full" onClick={finish}>
              {t("vendorLogin.continue")}
            </Button>
          </div>
        ) : null}

        {step.kind === "enroll" || step.kind === "verify" || step.kind === "resetCode" ? (
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full"
            onClick={() => {
              setError(null);
              setStep({ kind: "credentials" });
            }}
          >
            {t("vendorLogin.startOver")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

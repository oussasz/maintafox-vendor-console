import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestStepUpToken, type StepUpGrant } from "@/services/license-control-service";

export interface VendorConsoleStepUpDialogProps {
  open: boolean;
  actionLabel: string;
  onGranted: (grant: StepUpGrant) => void;
  onCancel: () => void;
}

/**
 * Step-up re-authentication for privileged vendor actions. The operator's password is verified
 * by the control API (POST /api/v1/auth/step-up), which issues a short-lived token bound to the
 * operator; privileged routes reject requests without it. Nothing is decided client-side.
 */
export function VendorConsoleStepUpDialog({ open, actionLabel, onGranted, onCancel }: VendorConsoleStepUpDialogProps) {
  const { t } = useTranslation("vendorConsole");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPassword("");
    setError(null);
    setBusy(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await requestStepUpToken(password);
      reset();
      onGranted(grant);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      if (lower.includes("invalid credentials") || lower.includes("(401)")) {
        setError(t("stepUp.errorInvalidPassword"));
      } else if (lower.includes("too many") || lower.includes("(429)")) {
        setError(t("stepUp.errorRateLimited"));
      } else {
        setError(t("stepUp.errorGeneric", { message }));
      }
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-md" aria-describedby="step-up-desc">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogHeader>
            <DialogTitle>{t("stepUp.title")}</DialogTitle>
            <DialogDescription id="step-up-desc">{t("stepUp.description", { action: actionLabel })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="step-up-password">{t("stepUp.passwordLabel")}</Label>
            <Input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-required
              aria-invalid={error != null}
              aria-describedby={error ? "step-up-error" : undefined}
              disabled={busy}
              autoFocus
            />
            {error ? (
              <p id="step-up-error" role="alert" className="text-sm text-text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                reset();
                onCancel();
              }}
            >
              {t("stepUp.cancel")}
            </Button>
            <Button type="submit" disabled={busy || password.length === 0}>
              {busy ? t("stepUp.verifying") : t("stepUp.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

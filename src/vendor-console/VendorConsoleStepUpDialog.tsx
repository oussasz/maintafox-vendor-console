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
import type { StepUpActionKind } from "@/lib/step-up-kinds";
import { AuthApiError, requestStepUp, type StepUpGrant } from "@/services/vendor-auth-service";
import { errorText } from "@/lib/error-text";

export interface VendorConsoleStepUpDialogProps {
  open: boolean;
  actionKind: StepUpActionKind | null;
  onGranted: (grant: StepUpGrant) => void;
  onCancel: () => void;
}

/**
 * Step-up for privileged vendor actions: the operator enters a fresh code from their authenticator
 * app and the control API (POST /api/v1/auth/step-up) issues a short-lived token valid for this
 * action kind only; privileged routes reject anything else. Nothing is decided client-side.
 */
export function VendorConsoleStepUpDialog({ open, actionKind, onGranted, onCancel }: VendorConsoleStepUpDialogProps) {
  const { t } = useTranslation("vendorConsole");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCode("");
    setError(null);
    setBusy(false);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!actionKind || code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const grant = await requestStepUp(actionKind, code);
      reset();
      onGranted(grant);
    } catch (err) {
      if (err instanceof AuthApiError && err.code === "invalid_mfa_code") {
        setError(t("stepUp.errorInvalidCode"));
      } else if (err instanceof AuthApiError && err.status === 429) {
        setError(t("stepUp.errorRateLimited"));
      } else {
        setError(t("stepUp.errorGeneric", { message: errorText(err) }));
      }
      setCode("");
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
            <DialogDescription id="step-up-desc">{t("stepUp.description", { action: actionKind ? t(`stepUp.kinds.${actionKind}`) : "" })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="step-up-code">{t("stepUp.codeLabel")}</Label>
            <Input
              id="step-up-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
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
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? t("stepUp.verifying") : t("stepUp.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

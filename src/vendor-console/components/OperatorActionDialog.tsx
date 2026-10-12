import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@/components/ui";
import { PRIVILEGED_REASON_MIN_LENGTH } from "@/services/license-control-service";

import { StepUpCancelledError } from "../VendorConsoleContext";

export interface OperatorActionDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Extra inputs (e.g. new fingerprint); `extraValid` gates the confirm button. */
  children?: ReactNode;
  extraValid?: boolean;
  /** Runs the action with the operator's reason (kept in the audit log); throw to show an error. */
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

/**
 * One audited operator action: a reason (sent as X-Operator-Reason and kept in the ledger), optional
 * extra fields, then the server call (which asks for a step-up code when the action needs one).
 * The dialog closes only when the server accepted; a refusal is shown in place.
 */
export function OperatorActionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  children,
  extraValid = true,
  onConfirm,
  onClose,
}: OperatorActionDialogProps) {
  const { t } = useTranslation("vendorConsole");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {children}
          <div className="grid gap-1">
            <Label htmlFor="operator-action-reason">{t("operatorAction.reasonLabel")}</Label>
            <Input id="operator-action-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("operatorAction.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={busy || !extraValid || reason.trim().length < PRIVILEGED_REASON_MIN_LENGTH}
            onClick={() => void confirm()}
          >
            {busy ? t("operatorAction.working") : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

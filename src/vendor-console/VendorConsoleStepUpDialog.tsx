import { useState } from "react";
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

export interface VendorConsoleStepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionLabel: string;
  onSatisfied: () => void;
}

/**
 * Step-up reauthentication for dangerous vendor actions.
 * Real verification is server-side; this UI exists for operator workflow and tests.
 */
export function VendorConsoleStepUpDialog({
  open,
  onOpenChange,
  actionLabel,
  onSatisfied,
}: VendorConsoleStepUpDialogProps) {
  const { t } = useTranslation("vendorConsole");
  const [code, setCode] = useState("");

  const handleConfirm = () => {
    if (!code.trim()) return;
    onSatisfied();
    setCode("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby="step-up-desc">
        <DialogHeader>
          <DialogTitle>{t("stepUp.title", "Confirm sensitive action")}</DialogTitle>
          <DialogDescription id="step-up-desc">
            {t("stepUp.description", { action: actionLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="step-up-code">{t("stepUp.codeLabel", "Confirmation code")}</Label>
          <Input
            id="step-up-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("stepUp.placeholder", "6-digit TOTP")}
            aria-required
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("stepUp.cancel", "Cancel")}
          </Button>
          <Button type="button" onClick={handleConfirm}>
            {t("stepUp.confirm", "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

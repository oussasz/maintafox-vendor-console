/**
 * Shows a freshly issued administrator recovery code once: the code (copy button), when it
 * expires, and how to hand it over. The server does not keep the code, so closing this dialog is
 * the last chance to copy it (a new one can be issued if it is lost).
 */
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui";
import type { AdminRecoveryCodeIssued } from "@/services/license-control-service";

import { formatDateTime } from "../ui/format";

export function AdminRecoveryCodeDialog({
  issued,
  deviceLabel,
  onClose,
}: {
  issued: AdminRecoveryCodeIssued | null;
  deviceLabel: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("vendorConsole");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [issued]);

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <Dialog open={issued !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("devices.recoveryCode.issuedTitle")}</DialogTitle>
          <DialogDescription>{t("devices.recoveryCode.issuedBody", { name: deviceLabel })}</DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="grid gap-3">
            <p
              data-testid="admin-recovery-code"
              className="select-all break-all rounded-md border border-surface-3 bg-surface-1 p-3 font-mono text-[13px] text-text-primary"
            >
              {issued.code}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
                {copied ? t("devices.recoveryCode.copied") : t("devices.recoveryCode.copy")}
              </Button>
              <span className="text-sm text-text-secondary">
                {t("devices.recoveryCode.expires", { at: formatDateTime(issued.expires_at) })}
              </span>
            </div>
            {copyFailed ? (
              <p role="alert" className="text-sm text-text-danger">
                {t("devices.recoveryCode.copyFailed")}
              </p>
            ) : null}
            <p className="rounded-md bg-surface-2 p-3 text-sm text-text-primary">{t("devices.recoveryCode.shownOnce")}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("devices.recoveryCode.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deleting a customer: the operator types its code to confirm, gives a reason, then an
 * authenticator code (step-up tenant_delete). Recorded in the audit log.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { deleteTenant, PRIVILEGED_REASON_MIN_LENGTH, type ControlTenant } from "@/services/license-control-service";

import { StepUpCancelledError, useVendorConsole } from "../VendorConsoleContext";
import { Notice } from "../ui/kit";

export function DeleteCustomerDialog({
  tenant,
  onClose,
  onDeleted,
}: {
  tenant: ControlTenant | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTyped("");
    setReason("");
    setError(null);
  }, [tenant]);

  const confirm = async () => {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTenant(tenant.id, {
        confirm_slug: typed.trim(),
        reason_code: reason.trim(),
        step_up_token: await requireStepUp(StepUpKinds.tenantDelete),
      });
      onDeleted();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={tenant !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("customers.confirmDeleteTitle")}</DialogTitle>
          <DialogDescription>{tenant ? t("customers.confirmDeleteBody", { name: tenant.display_name, slug: tenant.slug }) : null}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="delete-tenant-slug">{t("customers.deleteTypeSlug", { slug: tenant?.slug ?? "" })}</Label>
            <Input id="delete-tenant-slug" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="delete-tenant-reason">{t("customers.deleteReason")}</Label>
            <Input id="delete-tenant-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("operatorAction.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || typed.trim() !== tenant?.slug || reason.trim().length < PRIVILEGED_REASON_MIN_LENGTH}
            onClick={() => void confirm()}
          >
            {busy ? t("customers.deletingTenant") : t("customers.confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { KeyRound, LogOut, MonitorX, UserCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { PRIVILEGED_REASON_MIN_LENGTH } from "@/services/license-control-service";
import {
  getSessionInfo,
  logout,
  logoutEverywhere,
  regenerateRecoveryCodes,
  type VendorSessionInfo,
} from "@/services/vendor-auth-service";

import { StepUpCancelledError, useVendorConsole } from "./VendorConsoleContext";

/** Recovery codes are a lifeline: warn when this few are left. */
const LOW_RECOVERY_CODES = 3;

type OpenDialog = "none" | "logoutAll" | "regenerate" | "codes";

/**
 * Signed-in operator: who, recovery codes left, new recovery codes (step-up `own_mfa_change`),
 * log out of this browser, log out of every browser. Every action is a server call; logging out
 * ends the session on the server, not only in this tab.
 */
export function VendorConsoleAccountMenu() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [info, setInfo] = useState<VendorSessionInfo | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>("none");
  const [reason, setReason] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getSessionInfo()
      .then(setInfo)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const fail = (err: unknown) => {
    if (!(err instanceof StepUpCancelledError)) setError(err instanceof Error ? err.message : String(err));
  };

  const openDialog = (next: OpenDialog) => {
    setError(null);
    setDialog(next);
  };

  const onLogout = async () => {
    setBusy(true);
    try {
      await logout();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onLogoutAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await logoutEverywhere();
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const stepUpToken = await requireStepUp(StepUpKinds.ownMfaChange);
      const fresh = await regenerateRecoveryCodes({ reason: reason.trim(), stepUpToken });
      setCodes(fresh);
      setReason("");
      setDialog("codes");
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remaining = info?.mfa.recovery_codes_remaining;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="gap-2" aria-label={t("account.menuAria")}>
            <UserCircle className="h-4 w-4" aria-hidden />
            <span className="hidden max-w-[12rem] truncate lg:inline">{info?.user.email ?? ""}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="space-y-1">
            <span className="block truncate">{info?.user.email}</span>
            {info ? (
              <span className="block text-xs font-normal text-text-muted">
                {t("account.sessionUntil", { at: new Date(info.session.expires_at).toLocaleString() })}
              </span>
            ) : null}
            {remaining !== undefined ? (
              <span
                className={
                  remaining <= LOW_RECOVERY_CODES
                    ? "block text-xs font-normal text-text-danger"
                    : "block text-xs font-normal text-text-muted"
                }
              >
                {t("account.recoveryRemaining", { count: remaining })}
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openDialog("regenerate")}>
            <KeyRound className="mr-2 h-4 w-4" aria-hidden />
            {t("account.regenerate.menu")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => void onLogout()}>
            <LogOut className="mr-2 h-4 w-4" aria-hidden />
            {t("account.logout")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog("logoutAll")}>
            <MonitorX className="mr-2 h-4 w-4" aria-hidden />
            {t("account.logoutAll.menu")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && dialog === "none" ? (
        <p role="alert" className="max-w-xs truncate text-xs text-text-danger" title={error}>
          {error}
        </p>
      ) : null}

      <Dialog open={dialog === "logoutAll"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("account.logoutAll.title")}</DialogTitle>
            <DialogDescription>{t("account.logoutAll.body")}</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setDialog("none")} disabled={busy}>
              {t("account.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void onLogoutAll()} disabled={busy}>
              {t("account.logoutAll.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "regenerate"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("account.regenerate.title")}</DialogTitle>
            <DialogDescription>{t("account.regenerate.body")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="regenerate-reason">{t("account.regenerate.reasonLabel")}</Label>
            <Input id="regenerate-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setDialog("none")} disabled={busy}>
              {t("account.cancel")}
            </Button>
            <Button type="button" onClick={() => void onRegenerate()} disabled={busy || reason.trim().length < PRIVILEGED_REASON_MIN_LENGTH}>
              {t("account.regenerate.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "codes"} onOpenChange={(open) => !open && setDialog("none")}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("account.codes.title")}</DialogTitle>
            <DialogDescription>{t("account.codes.body")}</DialogDescription>
          </DialogHeader>
          <ul className="grid grid-cols-2 gap-2 rounded bg-surface-2 p-3 font-mono text-sm" data-testid="new-recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                setCodes([]);
                setDialog("none");
              }}
            >
              {t("account.codes.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

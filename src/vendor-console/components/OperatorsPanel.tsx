import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Badge,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  OPERATOR_ROLES,
  createOperator,
  deleteOperator,
  listOperators,
  resetOperatorMfa,
  updateOperator,
  type Operator,
  type OperatorRole,
} from "@/services/operators-service";
import { getSessionInfo } from "@/services/vendor-auth-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";
import { errorText } from "@/lib/error-text";

/** Same minimum as the API (routes/auth.ts OPERATOR_PASSWORD_MIN_LENGTH). */
const OPERATOR_PASSWORD_MIN_LENGTH = 12;

type PendingAction =
  | { kind: "create" }
  | { kind: "role"; operator: Operator; role: OperatorRole }
  | { kind: "toggle"; operator: Operator }
  | { kind: "mfaReset"; operator: Operator }
  | { kind: "delete"; operator: Operator };

const selectClass =
  "h-10 rounded-lg border border-input bg-white pl-3 pr-9 text-sm text-text-primary disabled:opacity-60";

/**
 * Console operators (owners only): who can sign in, with which role. Roles are enforced by the
 * server on every route; each change asks for a reason and a fresh authenticator code
 * (`vendor_user_admin`) and is audited. You cannot change your own access here.
 */
export function OperatorsPanel() {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [selfId, setSelfId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [oneTimeCode, setOneTimeCode] = useState<{ email: string; code: string; kind: "enrolment" | "reset" } | null>(null);
  const [form, setForm] = useState({ email: "", display_name: "", role: "auditor" as OperatorRole, initial_password: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, info] = await Promise.all([listOperators(), getSessionInfo()]);
      setOperators(list);
      setSelfId(info.user.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const privileged = async (reason: string) => ({
    reason_code: reason,
    step_up_token: await requireStepUp(StepUpKinds.vendorUserAdmin),
  });

  const run = async (reason: string) => {
    if (!pending) return;
    setSuccess(null);
    if (pending.kind === "create") {
      const created = await createOperator(
        { ...form, email: form.email.trim(), display_name: form.display_name.trim() },
        await privileged(reason),
      );
      setOneTimeCode({ email: created.operator.email, code: created.enrolment_code, kind: "enrolment" });
      setForm({ email: "", display_name: "", role: "auditor", initial_password: "" });
    } else if (pending.kind === "role") {
      await updateOperator(pending.operator.id, { role: pending.role }, await privileged(reason));
      setSuccess(t("operators.done.role", { email: pending.operator.email }));
    } else if (pending.kind === "toggle") {
      await updateOperator(pending.operator.id, { is_active: !pending.operator.is_active }, await privileged(reason));
      setSuccess(t(pending.operator.is_active ? "operators.done.disabled" : "operators.done.enabled", { email: pending.operator.email }));
    } else if (pending.kind === "mfaReset") {
      const code = await resetOperatorMfa(pending.operator.id, await privileged(reason));
      setOneTimeCode({ email: pending.operator.email, code, kind: "reset" });
    } else {
      await deleteOperator(pending.operator.id, await privileged(reason));
      setSuccess(t("operators.done.deleted", { email: pending.operator.email }));
    }
    await load();
  };

  const dialogKey = !pending
    ? "create"
    : pending.kind === "toggle"
      ? pending.operator.is_active
        ? "disable"
        : "enable"
      : pending.kind;
  const createValid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) &&
    form.display_name.trim().length > 0 &&
    form.initial_password.length >= OPERATOR_PASSWORD_MIN_LENGTH;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold text-text-primary">{t("operators.title")}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("operators.body")}</p>
        </div>
        <Button type="button" onClick={() => setPending({ kind: "create" })}>
          {t("operators.add")}
        </Button>
      </header>

      {error ? (
        <ConsoleStatusBanner tone="error" role="alert">
          {error}
        </ConsoleStatusBanner>
      ) : null}
      {success ? (
        <ConsoleStatusBanner tone="success" role="status">
          {success}
        </ConsoleStatusBanner>
      ) : null}

      <div className="rounded-lg border border-surface-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("operators.col.name")}</TableHead>
              <TableHead>{t("operators.col.role")}</TableHead>
              <TableHead>{t("operators.col.status")}</TableHead>
              <TableHead>{t("operators.col.lastLogin")}</TableHead>
              <TableHead className="text-right">{t("operators.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {operators.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-text-muted">
                  {loading ? t("operators.loading") : t("operators.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {operators.map((op) => {
              const self = op.id === selfId;
              return (
                <TableRow key={op.id} data-testid={`operator-${op.id}`}>
                  <TableCell>
                    <p className="font-medium">
                      {op.display_name ?? op.email}
                      {self ? <span className="ml-2 text-xs text-text-muted">{t("operators.you")}</span> : null}
                    </p>
                    <p className="text-xs text-text-muted">{op.email}</p>
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={t("operators.roleFor", { email: op.email })}
                      className={selectClass}
                      value={op.role}
                      disabled={self}
                      onChange={(e) => setPending({ kind: "role", operator: op, role: e.target.value as OperatorRole })}
                    >
                      {OPERATOR_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`operators.roles.${role}`)}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell className="space-x-1">
                    <Badge variant={op.is_active ? "default" : "secondary"}>
                      {op.is_active ? t("operators.status.active") : t("operators.status.disabled")}
                    </Badge>
                    <Badge variant={op.mfa_enrolled ? "default" : "secondary"}>
                      {op.mfa_enrolled ? t("operators.status.mfa") : t("operators.status.noMfa")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {op.last_login_at ? new Date(op.last_login_at).toLocaleString() : t("operators.never")}
                  </TableCell>
                  <TableCell className="text-right">
                    {self ? null : (
                      <div className="flex justify-end gap-1">
                        <Button type="button" size="sm" variant="outline" onClick={() => setPending({ kind: "toggle", operator: op })}>
                          {op.is_active ? t("operators.disable") : t("operators.enable")}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setPending({ kind: "mfaReset", operator: op })}>
                          {t("operators.mfaReset")}
                        </Button>
                        <Button type="button" size="sm" variant="destructive" onClick={() => setPending({ kind: "delete", operator: op })}>
                          {t("operators.delete")}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4 text-sm">
        <h2 className="font-semibold">{t("operators.rolesTitle")}</h2>
        <ul className="mt-2 space-y-1 text-text-secondary">
          {OPERATOR_ROLES.map((role) => (
            <li key={role}>
              <span className="font-medium text-text-primary">{t(`operators.roles.${role}`)}</span>: {t(`operators.roleHelp.${role}`)}
            </li>
          ))}
        </ul>
      </section>

      <OperatorActionDialog
        open={pending !== null}
        title={t(`operators.dialog.${dialogKey}.title`)}
        description={t(`operators.dialog.${dialogKey}.body`, {
          email: pending && pending.kind !== "create" ? pending.operator.email : "",
          role: pending?.kind === "role" ? t(`operators.roles.${pending.role}`) : "",
        })}
        confirmLabel={t(`operators.dialog.${dialogKey}.confirm`)}
        destructive={pending?.kind === "delete" || pending?.kind === "mfaReset" || (pending?.kind === "toggle" && pending.operator.is_active)}
        extraValid={pending?.kind !== "create" || createValid}
        onConfirm={run}
        onClose={() => setPending(null)}
      >
        {pending?.kind === "create" ? (
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="op-email">{t("operators.form.email")}</Label>
              <Input id="op-email" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="op-name">{t("operators.form.name")}</Label>
              <Input id="op-name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="op-role">{t("operators.form.role")}</Label>
              <select id="op-role" className={selectClass} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as OperatorRole })}>
                {OPERATOR_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`operators.roles.${role}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="op-password">{t("operators.form.password", { min: OPERATOR_PASSWORD_MIN_LENGTH })}</Label>
              <Input
                id="op-password"
                type="password"
                autoComplete="new-password"
                value={form.initial_password}
                onChange={(e) => setForm({ ...form, initial_password: e.target.value })}
              />
            </div>
          </div>
        ) : null}
      </OperatorActionDialog>

      <Dialog open={oneTimeCode !== null} onOpenChange={(open) => !open && setOneTimeCode(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{oneTimeCode ? t(`operators.code.${oneTimeCode.kind}.title`) : ""}</DialogTitle>
            <DialogDescription>
              {oneTimeCode ? t(`operators.code.${oneTimeCode.kind}.body`, { email: oneTimeCode.email }) : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="rounded bg-surface-2 px-3 py-2 text-center font-mono text-lg tracking-wider" data-testid="one-time-code">
            {oneTimeCode?.code}
          </p>
          <DialogFooter>
            <Button type="button" onClick={() => setOneTimeCode(null)}>
              {t("operators.code.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

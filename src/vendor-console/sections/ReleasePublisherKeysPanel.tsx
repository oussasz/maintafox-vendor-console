/**
 * Release workflow keys: the credentials the release workflow (CI) uses to upload a new desktop
 * version. A new key's token is shown once (the API keeps only its hash); creating or revoking a
 * key needs an audit reason and an authenticator code (step-up release_publisher_key).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePermissions } from "@/hooks/use-permissions";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  createPublisherKey,
  listPublisherKeys,
  PUBLISHER_KEY_LABEL_MAX_LENGTH,
  PUBLISHER_KEY_LABEL_MIN_LENGTH,
  revokePublisherKey,
  type CreatedPublisherKey,
  type PublisherKey,
} from "@/services/release-catalog-service";

import { OperatorActionDialog } from "../components/OperatorActionDialog";
import { useVendorConsole } from "../VendorConsoleContext";
import { formatDateTime } from "../ui/format";
import { EmptyState, Loading, LoadError, Notice, Panel, StatusPill } from "../ui/kit";

/** Name of the GitHub secret the release workflow reads the token from. */
export const RELEASE_PUBLISHER_SECRET_NAME = "MAINTAFOX_RELEASE_PUBLISHER_TOKEN";

export function ReleasePublisherKeysPanel() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();
  const canManage = can("rollout.manage");
  const { requireStepUp } = useVendorConsole();
  const [keys, setKeys] = useState<PublisherKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreatedPublisherKey | null>(null);
  const [revoking, setRevoking] = useState<PublisherKey | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setKeys(await listPublisherKeys());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOk = label.trim().length >= PUBLISHER_KEY_LABEL_MIN_LENGTH && label.trim().length <= PUBLISHER_KEY_LABEL_MAX_LENGTH;

  const create = async (reason: string) => {
    const stepUpToken = await requireStepUp(StepUpKinds.releasePublisherKey);
    const key = await createPublisherKey(label.trim(), { reason_code: reason, step_up_token: stepUpToken });
    setSuccess(null);
    setCreated(key);
    void load();
  };

  const revoke = async (reason: string) => {
    if (!revoking) return;
    const stepUpToken = await requireStepUp(StepUpKinds.releasePublisherKey);
    const next = await revokePublisherKey(revoking.key_id, { reason_code: reason, step_up_token: stepUpToken });
    setKeys((list) => (list ? list.map((k) => (k.key_id === next.key_id ? next : k)) : list));
    setSuccess(t("updates.keys.revoked", { label: next.label }));
  };

  return (
    <Panel
      title={t("updates.keys.title")}
      labelledBy="release-keys-h"
      aside={
        canManage ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setLabel("");
              setCreating(true);
            }}
          >
            {t("updates.keys.create")}
          </Button>
        ) : null
      }
    >
      <p className="text-[13px] text-text-secondary">{t("updates.keys.intro", { secret: RELEASE_PUBLISHER_SECRET_NAME })}</p>
      {created ? <TokenOnce created={created} onDone={() => setCreated(null)} /> : null}
      {success ? <Notice tone="ok">{success}</Notice> : null}
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {keys === null && !error ? <Loading /> : null}
      {keys && keys.length === 0 ? <EmptyState title={t("updates.keys.empty")} body={t("updates.keys.emptyBody")} /> : null}
      {keys && keys.length > 0 ? (
        <ul className="flex flex-col divide-y divide-surface-border" aria-label={t("updates.keys.listAria")}>
          {keys.map((k) => (
            <li key={k.key_id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                  {k.label}
                  {k.revoked_at ? (
                    <StatusPill tone="danger">{t("updates.keys.statusRevoked")}</StatusPill>
                  ) : (
                    <StatusPill tone="ok">{t("updates.keys.statusActive")}</StatusPill>
                  )}
                </span>
                <span className="text-[13px] text-text-secondary">
                  {t("updates.keys.createdBy", { date: formatDateTime(k.created_at), by: k.created_by })}
                  {" · "}
                  {k.last_used_at ? t("updates.keys.lastUsed", { date: formatDateTime(k.last_used_at) }) : t("updates.keys.neverUsed")}
                </span>
                {k.revoked_at ? (
                  <span className="text-[13px] text-text-secondary">
                    {t("updates.keys.revokedBy", { date: formatDateTime(k.revoked_at), by: k.revoked_by ?? "—" })}
                  </span>
                ) : null}
              </div>
              {canManage && !k.revoked_at ? (
                <Button type="button" size="sm" variant="destructive" onClick={() => setRevoking(k)}>
                  {t("updates.keys.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <OperatorActionDialog
        open={creating}
        title={t("updates.keys.createTitle")}
        description={t("updates.keys.createBody")}
        confirmLabel={t("updates.keys.createConfirm")}
        extraValid={labelOk}
        onConfirm={create}
        onClose={() => setCreating(false)}
      >
        <div className="grid gap-1">
          <Label htmlFor="release-key-label">{t("updates.keys.labelField")}</Label>
          <Input
            id="release-key-label"
            autoComplete="off"
            maxLength={PUBLISHER_KEY_LABEL_MAX_LENGTH}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      </OperatorActionDialog>
      <OperatorActionDialog
        open={revoking !== null}
        title={t("updates.keys.revokeTitle", { label: revoking?.label ?? "" })}
        description={t("updates.keys.revokeBody")}
        confirmLabel={t("updates.keys.revokeConfirm")}
        destructive
        onConfirm={revoke}
        onClose={() => setRevoking(null)}
      />
    </Panel>
  );
}

/** The new key's token, shown only until the operator closes it. */
function TokenOnce({ created, onDone }: { created: CreatedPublisherKey; onDone: () => void }) {
  const { t } = useTranslation("vendorConsole");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-attention/40 bg-attention-bg px-4 py-3.5" role="status">
      <p className="text-sm font-bold text-attention-text">{t("updates.keys.tokenTitle", { label: created.label })}</p>
      <p className="text-[13px] text-attention-text">{t("updates.keys.tokenWarning", { secret: RELEASE_PUBLISHER_SECRET_NAME })}</p>
      <Label htmlFor="release-key-token" className="sr-only">
        {t("updates.keys.tokenLabel")}
      </Label>
      <Input id="release-key-token" readOnly className="font-mono text-xs" value={created.token} onFocus={(e) => e.currentTarget.select()} />
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="button" size="sm" variant="outline" onClick={() => void copyToken()}>
          {t("updates.keys.copy")}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          {t("updates.keys.tokenDone")}
        </Button>
        {copy === "copied" ? <span className="text-[13px] text-ok-text">{t("updates.keys.copied")}</span> : null}
        {copy === "failed" ? <span className="text-[13px] text-danger">{t("updates.keys.copyFailed")}</span> : null}
      </div>
    </div>
  );
}

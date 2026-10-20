import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Label } from "@/components/ui";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  listDeletedAttachments,
  restoreDeletedAttachment,
  type AttachmentState,
  type DeletedAttachment,
} from "@/services/vendor-ops-telemetry-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";

const selectClass = "h-11 rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";
/** Periods offered for the time filter (days; 0 = all time). */
const PERIOD_DAYS = [0, 7, 30, 90] as const;

/**
 * Photos, attachments and document links deleted or replaced for one customer. Every replacement
 * of a live version is archived (device deletes and overwrites, and restores that replace a live
 * row), so any archived version can be brought back, any time, as often as needed. The sync server
 * knows the device that sent a change, not the person. Restore (reason + step-up
 * `sync_attachment_restore`, audited) sends the entity's current version from this listing; the
 * server refuses if it changed since, and the list is reloaded so the operator sees what will be
 * replaced. Files uploaded to the server are never deleted; for an equipment / request / work order
 * attachment the file comes back through its "Photo or file" companion entry, shown next to it.
 */
export function DeletedAttachmentsPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [items, setItems] = useState<DeletedAttachment[] | null>(null);
  const [filter, setFilter] = useState<"relevant" | "all">("relevant");
  const [periodDays, setPeriodDays] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<DeletedAttachment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const since = periodDays > 0 ? new Date(Date.now() - periodDays * 86_400_000).toISOString() : undefined;
      setItems(await listDeletedAttachments(tenantId, { filter, since }));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId, filter, periodDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (reason: string) => {
    if (!restoring) return;
    try {
      await restoreDeletedAttachment(tenantId, restoring.id, restoring.current, {
        reason_code: reason,
        step_up_token: await requireStepUp(StepUpKinds.syncAttachmentRestore),
      });
    } catch (err) {
      // A refusal (e.g. the entity changed since this listing): show the latest state behind the dialog.
      await load();
      throw err;
    }
    setSuccess(t("sync.deletedAttachments.restored", { id: restoring.entity_sync_id }));
    await load();
  };

  const stateText = (state: AttachmentState | null) =>
    state === null
      ? t("sync.deletedAttachments.current.none")
      : state.deleted
        ? t("sync.deletedAttachments.current.deleted", { version: state.row_version })
        : t("sync.deletedAttachments.current.live", { version: state.row_version });

  const kindLabel = (item: DeletedAttachment) =>
    item.change_kind === "delete"
      ? t("sync.deletedAttachments.state.deleted")
      : item.change_kind === "restore"
        ? t("sync.deletedAttachments.state.replacedByRestore")
        : t("sync.deletedAttachments.state.replaced");

  return (
    <section className="space-y-3" aria-labelledby="sync-deleted-attachments">
      <h2 id="sync-deleted-attachments" className="text-sm font-semibold">
        {t("sync.deletedAttachments.title")}
      </h2>
      <p className="text-xs text-text-secondary">{t("sync.deletedAttachments.body")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-filter">{t("sync.deletedAttachments.filter.label")}</Label>
          <select
            id="deleted-attachments-filter"
            className={selectClass}
            value={filter}
            onChange={(e) => setFilter(e.target.value === "all" ? "all" : "relevant")}
          >
            <option value="relevant">{t("sync.deletedAttachments.filter.relevant")}</option>
            <option value="all">{t("sync.deletedAttachments.filter.all")}</option>
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-period">{t("sync.deletedAttachments.period.label")}</Label>
          <select
            id="deleted-attachments-period"
            className={selectClass}
            value={periodDays}
            onChange={(e) => setPeriodDays(Number(e.target.value))}
          >
            {PERIOD_DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? t("sync.deletedAttachments.period.all") : t("sync.deletedAttachments.period.days", { count: d })}
              </option>
            ))}
          </select>
        </div>
      </div>
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
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full min-w-[820px] text-left text-sm" data-testid="deleted-attachments">
          <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.deletedAt")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.item")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.device")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.state")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.now")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t("sync.deletedAttachments.col.action")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-text-muted">
                  {t("sync.deletedAttachments.loading")}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-sm text-text-muted">
                  {t("sync.deletedAttachments.empty")}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b border-surface-border align-top last:border-0">
                  <td className="px-3 py-2 text-xs">{new Date(item.changed_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{t(`sync.deletedAttachments.type.${item.entity_type}`)}</div>
                    <div className="break-all font-mono text-text-muted">{item.entity_sync_id}</div>
                    <div className="text-text-muted">
                      {item.file_on_server === null
                        ? t("sync.deletedAttachments.file.unknown")
                        : item.file_on_server
                          ? t("sync.deletedAttachments.file.onServer")
                          : t("sync.deletedAttachments.file.notOnServer")}
                    </div>
                    {item.companion ? (
                      <div className="text-text-muted" data-testid={`companion-${item.id}`}>
                        {item.companion.live
                          ? t("sync.deletedAttachments.companion.live", { id: item.companion.entity_sync_id })
                          : item.companion.archive_id
                            ? t("sync.deletedAttachments.companion.archived", { id: item.companion.entity_sync_id })
                            : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="break-all px-3 py-2 font-mono text-xs">
                    {item.changed_by.operator
                      ? t("sync.deletedAttachments.byOperator", { operator: item.changed_by.operator })
                      : item.changed_by.machine_fingerprint}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="space-y-1">
                      <Badge variant={item.change_kind === "delete" ? "destructive" : "outline"}>{kindLabel(item)}</Badge>
                      <div className="text-text-muted">
                        {item.prior_row_version !== null
                          ? t("sync.deletedAttachments.archivedVersion", { version: item.prior_row_version })
                          : t(`sync.deletedAttachments.prior.${item.prior_state}`)}
                      </div>
                      {item.restores.map((r) => (
                        <div key={r.audit_record_id} className="text-text-muted">
                          {t("sync.deletedAttachments.restoredBy", { at: new Date(r.at).toLocaleString(), by: r.by })}
                          {r.reason ? <span className="text-text-secondary"> · {r.reason}</span> : null}
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs" data-testid={`current-${item.id}`}>
                    {stateText(item.current)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {item.restorable ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => setRestoring(item)}>
                        {t("sync.deletedAttachments.restore")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <OperatorActionDialog
        open={restoring !== null}
        title={t("sync.deletedAttachments.restoreTitle")}
        description={t("sync.deletedAttachments.restoreBody", {
          id: restoring?.entity_sync_id ?? "",
          archived: restoring?.prior_row_version ?? "",
          at: restoring ? new Date(restoring.changed_at).toLocaleString() : "",
          current: stateText(restoring?.current ?? null),
        })}
        confirmLabel={t("sync.deletedAttachments.restoreConfirm")}
        onConfirm={restore}
        onClose={() => setRestoring(null)}
      />
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button } from "@/components/ui";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { listDeletedAttachments, restoreDeletedAttachment, type DeletedAttachment } from "@/services/vendor-ops-telemetry-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";

/**
 * Photos and attachments deleted by synchronisation for one customer (the server archived the row
 * when it accepted the delete). The sync server knows the device that sent the delete, not the
 * person. Restore puts the row back on every device (reason + step-up `sync_attachment_restore`,
 * audited); the file itself was never deleted from storage.
 */
export function DeletedAttachmentsPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [items, setItems] = useState<DeletedAttachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<DeletedAttachment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listDeletedAttachments(tenantId));
    } catch (err) {
      setError(errorText(err));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (reason: string) => {
    if (!restoring) return;
    await restoreDeletedAttachment(tenantId, restoring.id, {
      reason_code: reason,
      step_up_token: await requireStepUp(StepUpKinds.syncAttachmentRestore),
    });
    setSuccess(t("sync.deletedAttachments.restored", { id: restoring.entity_sync_id }));
    await load();
  };

  return (
    <section className="space-y-3" aria-labelledby="sync-deleted-attachments">
      <h2 id="sync-deleted-attachments" className="text-sm font-semibold">
        {t("sync.deletedAttachments.title")}
      </h2>
      <p className="text-xs text-text-secondary">{t("sync.deletedAttachments.body")}</p>
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
        <table className="w-full min-w-[720px] text-left text-sm" data-testid="deleted-attachments">
          <thead className="border-b border-surface-border bg-surface-2 text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.deletedAt")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.item")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.device")}</th>
              <th className="px-3 py-2">{t("sync.deletedAttachments.col.state")}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t("sync.deletedAttachments.col.action")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-sm text-text-muted">
                  {t("sync.deletedAttachments.loading")}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-sm text-text-muted">
                  {t("sync.deletedAttachments.empty")}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-b border-surface-border align-top last:border-0">
                  <td className="px-3 py-2 text-xs">{new Date(item.deleted_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{t(`sync.deletedAttachments.type.${item.entity_type}`)}</div>
                    <div className="break-all font-mono text-text-muted">{item.entity_sync_id}</div>
                  </td>
                  <td className="break-all px-3 py-2 font-mono text-xs">{item.deleted_by.machine_fingerprint}</td>
                  <td className="px-3 py-2 text-xs">
                    {item.restored ? (
                      <div className="space-y-1">
                        <Badge variant="secondary">{t("sync.deletedAttachments.state.restored")}</Badge>
                        <div className="text-text-muted">
                          {t("sync.deletedAttachments.restoredBy", {
                            at: new Date(item.restored.at).toLocaleString(),
                            by: item.restored.by ?? "-",
                          })}
                        </div>
                        {item.restored.reason ? <div className="text-text-secondary">{item.restored.reason}</div> : null}
                      </div>
                    ) : item.restore_blocker ? (
                      <Badge variant="outline">{t(`sync.deletedAttachments.blocker.${item.restore_blocker}`)}</Badge>
                    ) : (
                      <Badge variant="destructive">{t("sync.deletedAttachments.state.deleted")}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {item.restored === null && item.restore_blocker === null ? (
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
          device: restoring?.deleted_by.machine_fingerprint ?? "",
        })}
        confirmLabel={t("sync.deletedAttachments.restoreConfirm")}
        onConfirm={restore}
        onClose={() => setRestoring(null)}
      />
    </section>
  );
}

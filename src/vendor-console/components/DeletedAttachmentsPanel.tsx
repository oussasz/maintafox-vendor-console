import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Input, Label } from "@/components/ui";
import { errorText } from "@/lib/error-text";
import { StepUpKinds } from "@/lib/step-up-kinds";
import {
  listDeletedAttachments,
  restoreDeletedAttachment,
  RestoreConflictError,
  type AttachmentState,
  type DeletedAttachment,
  type DeletedAttachmentsQuery,
  type KeptGroup,
  type NothingKeptGroup,
} from "@/services/vendor-ops-telemetry-service";

import { useVendorConsole } from "../VendorConsoleContext";
import { ConsoleStatusBanner } from "./ConsoleStatusBanner";
import { OperatorActionDialog } from "./OperatorActionDialog";

const selectClass = "h-11 rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary";
/** Periods offered for the time filter (days; 0 = all time). */
const PERIOD_DAYS = [0, 7, 30, 90] as const;
/** Entries per page ("Load more" fetches the next one). */
const PAGE_SIZE = 100;
/** The archived types (api/src/sync/attachment-archive.ts), for the type filter. */
const ARCHIVED_TYPES = [
  "media_attachments",
  "asset_photos",
  "di_attachments",
  "work_order_attachments",
  "library_documents",
  "asset_document_links",
  "inventory_document_links",
] as const;
type View = NonNullable<DeletedAttachmentsQuery["view"]>;

/** Start of the day after `yyyy-mm-dd` (local time): the exclusive upper bound of "up to that date". */
function dayAfter(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * Photos, attachments and document links deleted or replaced for one customer. Every replacement
 * of a live version is archived (device deletes and overwrites, and restores that replace a live
 * row), so any archived version can be brought back, any time, as often as needed. The sync server
 * knows the device that sent a change, not the person. By default the kept view shows only changes
 * of a version another device wrote, so a device cannot bury a real entry under entries about rows
 * it wrote and deleted itself. Restore (reason + step-up `sync_attachment_restore`, audited) sends
 * the entity's current version from this listing; when the server refuses because it changed, the
 * open dialog takes the state from the refusal (the loaded pages stay as they are). Files uploaded
 * to the server are never deleted; for an equipment / request / work order attachment the file
 * comes back through its "Photo or file" companion entry, shown next to it.
 */
export function DeletedAttachmentsPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [items, setItems] = useState<DeletedAttachment[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<NothingKeptGroup[]>([]);
  const [keptSummary, setKeptSummary] = useState<KeptGroup[]>([]);
  const [view, setView] = useState<View>("kept");
  const [crossDevice, setCrossDevice] = useState(true);
  const [device, setDevice] = useState("");
  const [entityType, setEntityType] = useState("");
  const [periodDays, setPeriodDays] = useState<number>(0);
  const [beforeDate, setBeforeDate] = useState("");
  const [search, setSearch] = useState("");
  const [itemId, setItemId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<DeletedAttachment | null>(null);
  /** Bumped whenever the filters (re)load page 1: a Load more answer for older filters is dropped. */
  const generation = useRef(0);

  const query = useCallback(
    (cursor?: string): DeletedAttachmentsQuery => ({
      view,
      since: periodDays > 0 ? new Date(Date.now() - periodDays * 86_400_000).toISOString() : undefined,
      before: beforeDate ? dayAfter(beforeDate) : undefined,
      entity_type: entityType || undefined,
      entity_sync_id: itemId || undefined,
      machine_fingerprint: device || undefined,
      cross_device: view === "kept" && crossDevice ? "1" : undefined,
      limit: PAGE_SIZE,
      cursor,
    }),
    [view, periodDays, beforeDate, entityType, itemId, device, crossDevice],
  );

  /** First page again. */
  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    setError(null);
    try {
      const page = await listDeletedAttachments(tenantId, query());
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
      setSummary(page.nothing_kept_summary);
      setKeptSummary(page.kept_summary);
    } catch (err) {
      if (mine === generation.current) setError(errorText(err));
    }
  }, [tenantId, query]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const mine = generation.current;
    try {
      const page = await listDeletedAttachments(tenantId, query(nextCursor));
      if (mine !== generation.current) return; // the filters changed meanwhile
      setItems((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (mine === generation.current) setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  /** Every loaded entry of the same item gets the state the server reported. */
  const patchCurrent = (target: DeletedAttachment, current: AttachmentState | null) => {
    const same = (i: DeletedAttachment) => i.entity_type === target.entity_type && i.entity_sync_id === target.entity_sync_id;
    setItems((list) => list?.map((i) => (same(i) ? { ...i, current } : i)) ?? list);
    setRestoring((open) => (open && same(open) ? { ...open, current } : open));
  };

  const restore = async (reason: string) => {
    if (!restoring) return;
    try {
      await restoreDeletedAttachment(tenantId, restoring.id, restoring.current, {
        reason_code: reason,
        step_up_token: await requireStepUp(StepUpKinds.syncAttachmentRestore),
      });
    } catch (err) {
      // The entity changed since the listing: show its state now (from the refusal) in the dialog
      // and the list, so confirming again replaces what the operator sees.
      if (err instanceof RestoreConflictError) patchCurrent(restoring, err.current);
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

  const devices = [...new Set([...keptSummary.map((g) => g.machine_fingerprint), ...summary.map((g) => g.machine_fingerprint)])].sort();

  return (
    <section className="space-y-3" aria-labelledby="sync-deleted-attachments">
      <h2 id="sync-deleted-attachments" className="text-sm font-semibold">
        {t("sync.deletedAttachments.title")}
      </h2>
      <p className="text-xs text-text-secondary">{t("sync.deletedAttachments.body")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-view">{t("sync.deletedAttachments.view.label")}</Label>
          <select
            id="deleted-attachments-view"
            className={selectClass}
            value={view}
            onChange={(e) => setView(e.target.value === "nothing_kept" ? "nothing_kept" : e.target.value === "all" ? "all" : "kept")}
          >
            <option value="kept">{t("sync.deletedAttachments.view.kept")}</option>
            <option value="nothing_kept">{t("sync.deletedAttachments.view.nothing_kept")}</option>
            <option value="all">{t("sync.deletedAttachments.view.all")}</option>
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-device">{t("sync.deletedAttachments.device.label")}</Label>
          <select id="deleted-attachments-device" className={selectClass} value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">{t("sync.deletedAttachments.device.all")}</option>
            {devices.map((fp) => (
              <option key={fp} value={fp}>
                {fp}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-type">{t("sync.deletedAttachments.typeFilter.label")}</Label>
          <select id="deleted-attachments-type" className={selectClass} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">{t("sync.deletedAttachments.typeFilter.all")}</option>
            {ARCHIVED_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`sync.deletedAttachments.type.${type}`)}
              </option>
            ))}
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
        <div className="grid gap-1">
          <Label htmlFor="deleted-attachments-before">{t("sync.deletedAttachments.before.label")}</Label>
          <Input id="deleted-attachments-before" type="date" value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)} />
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setItemId(search.trim());
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="deleted-attachments-search">{t("sync.deletedAttachments.search.label")}</Label>
            <Input id="deleted-attachments-search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button type="submit" variant="outline">
            {t("sync.deletedAttachments.search.submit")}
          </Button>
        </form>
      </div>
      {view === "kept" ? (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={crossDevice} onChange={(e) => setCrossDevice(e.target.checked)} />
            {t("sync.deletedAttachments.crossDevice.label")}
          </label>
          <p className="text-xs text-text-secondary">{t("sync.deletedAttachments.crossDevice.help")}</p>
        </div>
      ) : null}
      {keptSummary.length > 0 && view === "kept" ? (
        <ul className="space-y-1 text-xs text-text-secondary" data-testid="kept-summary">
          {keptSummary.map((g) => (
            <li key={g.machine_fingerprint}>
              {t("sync.deletedAttachments.keptSummary", { count: g.count, cross: g.cross_device_count, device: g.machine_fingerprint })}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.length > 0 && view === "kept" ? (
        <ul className="space-y-1 text-xs text-text-secondary" data-testid="nothing-kept-summary">
          {summary.map((g) => (
            <li key={`${g.machine_fingerprint}-${g.entity_type}`}>
              {t("sync.deletedAttachments.nothingKept.summary", {
                count: g.count,
                type: t(`sync.deletedAttachments.type.${g.entity_type}`),
                device: g.machine_fingerprint,
              })}
            </li>
          ))}
          <li>
            <Button type="button" size="sm" variant="outline" onClick={() => setView("nothing_kept")}>
              {t("sync.deletedAttachments.nothingKept.show")}
            </Button>
          </li>
        </ul>
      ) : null}
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
                    {item.prior_origin ? (
                      <div className="font-sans text-text-muted">{t("sync.deletedAttachments.priorOrigin", { device: item.prior_origin })}</div>
                    ) : null}
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
      {nextCursor ? (
        <Button type="button" variant="outline" onClick={() => void loadMore()}>
          {t("sync.deletedAttachments.loadMore")}
        </Button>
      ) : null}

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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  MODULE_CAPABILITY_KEYS,
  createEdition,
  deleteEdition,
  listEditions,
  updateEdition,
  type CapabilitiesMap,
  type EditionCatalogEntry,
  type ModuleCapabilityKey,
} from "@/services/license-control-service";
import { errorText } from "@/lib/error-text";

const MODULE_GROUPS: Array<{ key: string; labelKey: string; modules: ModuleCapabilityKey[] }> = [
  {
    key: "operations",
    labelKey: "editions.groups.operations",
    modules: ["equipment", "requests", "work_orders", "inventory", "personnel", "organization", "reference"],
  },
  {
    key: "planning",
    labelKey: "editions.groups.planning",
    modules: ["planning", "pm"],
  },
  {
    key: "compliance",
    labelKey: "editions.groups.compliance",
    modules: ["permits", "inspections", "training"],
  },
  {
    key: "analytics",
    labelKey: "editions.groups.analytics",
    modules: ["reports", "rams", "finance"],
  },
  {
    key: "control",
    labelKey: "editions.groups.control",
    modules: ["sync", "erp", "notifications.email"],
  },
];

function emptyCapabilities(allFalse = true): CapabilitiesMap {
  const out = {} as CapabilitiesMap;
  for (const key of MODULE_CAPABILITY_KEYS) {
    out[key] = !allFalse;
  }
  return out;
}

function cloneCapabilities(source: CapabilitiesMap): CapabilitiesMap {
  const out = {} as CapabilitiesMap;
  for (const key of MODULE_CAPABILITY_KEYS) {
    out[key] = source[key] === true;
  }
  return out;
}

function enabledSummary(caps: CapabilitiesMap): string {
  return MODULE_CAPABILITY_KEYS.filter((k) => caps[k]).join(", ") || "—";
}

type EditorMode = "create" | "edit";

export function VendorConsoleEditionsPage() {
  const { t } = useTranslation("vendorConsole");
  const [items, setItems] = useState<EditionCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [editing, setEditing] = useState<EditionCatalogEntry | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftCaps, setDraftCaps] = useState<CapabilitiesMap>(emptyCapabilities());
  const [expectedVersion, setExpectedVersion] = useState(1);
  const [cloneFromId, setCloneFromId] = useState("professional");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EditionCatalogEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listEditions());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    const source = items.find((e) => e.id === cloneFromId) ?? items[0];
    setEditorMode("create");
    setEditing(null);
    setDraftId("");
    setDraftLabel("");
    setDraftCaps(source ? cloneCapabilities(source.capabilities) : emptyCapabilities());
    setExpectedVersion(1);
    setEditorOpen(true);
    setError(null);
    setSuccess(null);
  };

  const openEdit = (entry: EditionCatalogEntry) => {
    setEditorMode("edit");
    setEditing(entry);
    setDraftId(entry.id);
    setDraftLabel(entry.label);
    setDraftCaps(cloneCapabilities(entry.capabilities));
    setExpectedVersion(entry.row_version);
    setEditorOpen(true);
    setError(null);
    setSuccess(null);
  };

  const toggleModule = (key: ModuleCapabilityKey, checked: boolean) => {
    setDraftCaps((prev) => ({ ...prev, [key]: checked }));
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (editorMode === "create") {
        const created = await createEdition({
          id: draftId.trim(),
          label: draftLabel.trim(),
          capabilities: draftCaps,
          clone_from: cloneFromId || undefined,
        });
        setSuccess(t("editions.created", { id: created.id }));
      } else if (editing) {
        await updateEdition(editing.id, {
          label: draftLabel.trim(),
          capabilities: draftCaps,
          expected_row_version: expectedVersion,
        });
        setSuccess(t("editions.updated", { id: editing.id }));
      }
      setEditorOpen(false);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteEdition(deleteTarget.id);
      setSuccess(t("editions.deleted", { id: deleteTarget.id }));
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDeleting(false);
    }
  };

  const cloneOptions = useMemo(() => items, [items]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[17px] font-bold text-text-primary">{t("editions.pageTitle")}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t("editions.pageBody")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("editions.create")}
          </Button>
          <Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>
            {loading ? t("editions.refreshing") : t("editions.refresh")}
          </Button>
        </div>
      </header>

      <div
        className="rounded-md border border-attention/40 bg-attention-bg px-3 py-2 text-xs text-amber-100"
        role="status"
      >
        {t("editions.reissueBanner")}
      </div>

      {error ? <p className="text-sm text-text-danger">{error}</p> : null}
      {success ? <p className="text-sm text-ok-text">{success}</p> : null}

      <div className="rounded-lg border border-surface-border bg-surface-1">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("editions.columns.id")}</TableHead>
              <TableHead>{t("editions.columns.label")}</TableHead>
              <TableHead>{t("editions.columns.type")}</TableHead>
              <TableHead>{t("editions.columns.modules")}</TableHead>
              <TableHead>{t("editions.columns.version")}</TableHead>
              <TableHead className="w-[120px]">{t("editions.columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-text-muted">
                  {t("editions.empty")}
                </TableCell>
              </TableRow>
            ) : null}
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-xs">{entry.id}</TableCell>
                <TableCell>{entry.label}</TableCell>
                <TableCell>
                  {entry.is_system ? (
                    <Badge variant="outline">{t("editions.system")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("editions.custom")}</Badge>
                  )}
                </TableCell>
                <TableCell className="max-w-md truncate text-xs text-text-secondary">
                  {enabledSummary(entry.capabilities)}
                </TableCell>
                <TableCell className="font-mono text-xs">{entry.row_version}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(entry)} aria-label={t("editions.editTitle")}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {!entry.is_system ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(entry)}
                        aria-label={t("editions.deleteTitle")}
                      >
                        <Trash2 className="h-4 w-4 text-text-danger" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editorMode === "create"
                ? t("editions.createTitle")
                : t("editions.editTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("editions.editorHint")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {editorMode === "create" ? (
              <>
                <div>
                  <Label htmlFor="edition-id">{t("editions.fields.id")}</Label>
                  <Input
                    id="edition-id"
                    className="mt-1 font-mono"
                    value={draftId}
                    onChange={(e) => setDraftId(e.target.value.toLowerCase())}
                    placeholder="professional-ops"
                  />
                </div>
                <div>
                  <Label htmlFor="clone-from">{t("editions.fields.cloneFrom")}</Label>
                  <select
                    id="clone-from"
                    className="mt-1 flex h-11 w-full rounded-lg border border-input bg-white pl-3 pr-9 text-sm text-text-primary"
                    value={cloneFromId}
                    onChange={(e) => {
                      setCloneFromId(e.target.value);
                      const src = items.find((x) => x.id === e.target.value);
                      if (src) setDraftCaps(cloneCapabilities(src.capabilities));
                    }}
                  >
                    {cloneOptions.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label} ({e.id})
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <div>
                <Label>{t("editions.fields.id")}</Label>
                <p className="mt-1 font-mono text-sm text-text-secondary">{draftId}</p>
              </div>
            )}

            <div>
              <Label htmlFor="edition-label">{t("editions.fields.label")}</Label>
              <Input
                id="edition-label"
                className="mt-1"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
              />
            </div>

            {MODULE_GROUPS.map((group) => (
              <fieldset key={group.key} className="rounded-md border border-surface-border p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t(group.labelKey)}
                </legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {group.modules.map((mod) => (
                    <label key={mod} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draftCaps[mod] === true}
                        onCheckedChange={(v) => toggleModule(mod, v === true)}
                      />
                      <span className="font-mono text-xs">{mod}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              {t("editions.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void onSave()}
              disabled={saving || !draftLabel.trim() || (editorMode === "create" && !draftId.trim())}
            >
              {saving ? t("editions.saving") : t("editions.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editions.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t(
                "editions.deleteBody",
                { id: deleteTarget?.id ?? "" },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t("editions.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void onDelete()} disabled={deleting}>
              {deleting ? t("editions.deleting") : t("editions.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

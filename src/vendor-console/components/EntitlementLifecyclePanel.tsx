import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";

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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { useVendorConsole } from "../VendorConsoleContext";
import {
  issueLicense,
  listEditions,
  listTenantLicenses,
  listTenants,
  PRIVILEGED_REASON_MIN_LENGTH,
  revokeLicense,
  updateLicense,
  type ControlLicense,
  type ControlTenant,
  type EditionCatalogEntry,
} from "@/services/license-control-service";
import { errorText } from "@/lib/error-text";

type LicenseState = "active" | "revoked" | "expired";
type LicenseFilter = "all" | "active" | "revoked" | "expired";
type LicenseSortKey = "created_at" | "expires_at" | "max_machines";
type LicenseSortDirection = "asc" | "desc";

type IssueForm = {
  max_machines: string;
  update_channel: "stable" | "pilot" | "internal";
  expires_at: string;
  operator_reason_code: string;
  operator_rationale: string;
};

type IssueFormErrors = {
  max_machines?: string;
  expires_at?: string;
  operator_reason_code?: string;
  operator_rationale?: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `datetime-local` value ~30 days ahead (local) to avoid immediate expiry validation failures. */
function defaultExpiryDatetimeLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  d.setSeconds(0, 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const DEFAULT_ISSUE_FORM: IssueForm = {
  max_machines: "1",
  update_channel: "stable",
  expires_at: "",
  operator_reason_code: "",
  operator_rationale: "",
};

function deriveLicenseState(license: ControlLicense): LicenseState {
  if (license.revoked_at) return "revoked";
  if (license.expires_at) {
    const expiresAt = Date.parse(license.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
      return "expired";
    }
  }
  return "active";
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

/** Field problems as translation keys (vendorConsole `entitlement.validation.*`). */
function validateIssueForm(form: IssueForm): IssueFormErrors {
  const errors: IssueFormErrors = {};
  const maxMachines = Number.parseInt(form.max_machines, 10);
  if (Number.isNaN(maxMachines) || maxMachines < 1 || maxMachines > 1000) {
    errors.max_machines = "entitlement.validation.maxMachines";
  }

  if (form.expires_at.trim()) {
    const parsed = Date.parse(form.expires_at);
    if (Number.isNaN(parsed)) {
      errors.expires_at = "entitlement.validation.expiryInvalid";
    } else if (parsed < Date.now()) {
      errors.expires_at = "entitlement.validation.expiryPast";
    }
  }

  if (form.operator_reason_code.trim() && form.operator_reason_code.trim().length < 2) {
    errors.operator_reason_code = "entitlement.validation.reasonCode";
  }

  if (form.operator_rationale.trim().length < 8) {
    errors.operator_rationale = "entitlement.validation.rationale";
  }
  return errors;
}

export type EntitlementLifecyclePanelHandle = {
  openIssueDialog: () => void;
  refreshLicenses: () => Promise<void>;
};

export type EntitlementLifecyclePanelCapabilities = {
  canIssueKey: boolean;
  loadingLicenses: boolean;
};

type EntitlementLifecyclePanelProps = {
  /** When true, the Add/Refresh buttons are not rendered in the panel (e.g. shown in the page header). */
  hideSectionToolbar?: boolean;
  onCapabilitiesChange?: (capabilities: EntitlementLifecyclePanelCapabilities) => void;
  /** Shown inside a customer page: that customer only, no customer selector. */
  fixedTenantId?: string;
};

export const EntitlementLifecyclePanel = forwardRef<EntitlementLifecyclePanelHandle, EntitlementLifecyclePanelProps>(
  function EntitlementLifecyclePanel({ hideSectionToolbar = false, onCapabilitiesChange, fixedTenantId }, ref) {
  const { t } = useTranslation("vendorConsole");
  const { requireStepUp } = useVendorConsole();
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(fixedTenantId ?? "");
  const [licenses, setLicenses] = useState<ControlLicense[]>([]);
  const [selectedLicenseId, setSelectedLicenseId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<LicenseFilter>("all");
  const [sortKey, setSortKey] = useState<LicenseSortKey>("created_at");
  const [sortDirection, setSortDirection] = useState<LicenseSortDirection>("desc");
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [loadingLicenses, setLoadingLicenses] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationSuccess, setMutationSuccess] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingLicense, setEditingLicense] = useState<ControlLicense | null>(null);
  const [deleteConfirmLicense, setDeleteConfirmLicense] = useState<ControlLicense | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [updatingLicense, setUpdatingLicense] = useState(false);
  const [deletingLicense, setDeletingLicense] = useState(false);
  const [issueForm, setIssueForm] = useState<IssueForm>(DEFAULT_ISSUE_FORM);
  const [revokeReason, setRevokeReason] = useState("");
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const [editionCatalog, setEditionCatalog] = useState<EditionCatalogEntry[]>([]);

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  const selectedEditionEntry = useMemo(() => {
    const editionId = selectedTenant?.edition ?? "core";
    return editionCatalog.find((entry) => entry.id === editionId) ?? null;
  }, [editionCatalog, selectedTenant?.edition]);

  const enabledModules = useMemo(() => {
    if (!selectedEditionEntry) return [] as string[];
    return Object.entries(selectedEditionEntry.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort();
  }, [selectedEditionEntry]);

  const selectedLicense = useMemo(
    () => licenses.find((license) => license.id === selectedLicenseId) ?? null,
    [licenses, selectedLicenseId],
  );

  const selectedLicenseState = selectedLicense ? deriveLicenseState(selectedLicense) : null;

  const loadTenants = useCallback(async () => {
    setLoadingTenants(true);
    setLoadError(null);
    try {
      const [rows, editions] = await Promise.all([listTenants(), listEditions()]);
      setTenants(rows);
      setEditionCatalog(editions);
      if (rows.length === 0) {
        setSelectedTenantId("");
        setLicenses([]);
        return;
      }
      setSelectedTenantId((previous) => {
        if (fixedTenantId) return fixedTenantId;
        if (previous && rows.some((tenant) => tenant.id === previous)) {
          return previous;
        }
        return rows[0]?.id ?? "";
      });
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoadingTenants(false);
    }
  }, [fixedTenantId]);

  const loadLicenses = useCallback(
    async (tenantId: string, preferredLicenseId?: string) => {
      if (!tenantId) {
        setLicenses([]);
        setSelectedLicenseId("");
        return;
      }
      setLoadingLicenses(true);
      setLoadError(null);
      try {
        const rows = await listTenantLicenses(tenantId);
        setLicenses(rows);
        if (rows.length === 0) {
          setSelectedLicenseId("");
          return;
        }
        const hasPreferred = preferredLicenseId && rows.some((license) => license.id === preferredLicenseId);
        const hasSelected = selectedLicenseId && rows.some((license) => license.id === selectedLicenseId);
        const nextSelected = hasPreferred
          ? preferredLicenseId
          : hasSelected
            ? selectedLicenseId
            : rows[0]?.id;
        setSelectedLicenseId(nextSelected ?? "");
      } catch (err) {
        setLoadError(errorText(err));
      } finally {
        setLoadingLicenses(false);
      }
    },
    [selectedLicenseId],
  );

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    void loadLicenses(selectedTenantId);
  }, [selectedTenantId, loadLicenses]);

  useEffect(() => {
    onCapabilitiesChange?.({
      canIssueKey: Boolean(selectedTenant),
      loadingLicenses,
    });
  }, [onCapabilitiesChange, selectedTenant, loadingLicenses]);

  const filteredAndSortedLicenses = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const rows = licenses.filter((license) => {
      const state = deriveLicenseState(license);
      if (stateFilter !== "all" && state !== stateFilter) {
        return false;
      }
      if (!normalizedSearch) return true;
      return [
        license.id,
        license.license_key,
        license.tenant_id,
        license.update_channel ?? "",
        license.max_machines.toString(),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);
    });

    const sorted = [...rows].sort((left, right) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      if (sortKey === "max_machines") {
        return (left.max_machines - right.max_machines) * direction;
      }
      if (sortKey === "expires_at") {
        return (Date.parse(left.expires_at ?? "") - Date.parse(right.expires_at ?? "")) * direction;
      }
      return (Date.parse(left.created_at ?? "") - Date.parse(right.created_at ?? "")) * direction;
    });
    return sorted;
  }, [licenses, searchQuery, stateFilter, sortKey, sortDirection]);

  const issueValidationErrors = useMemo(() => validateIssueForm(issueForm), [issueForm]);
  const issueFormIsValid = Object.keys(issueValidationErrors).length === 0;
  const issueBlockingSummaries = useMemo(
    () => Object.values(issueValidationErrors).filter(Boolean),
    [issueValidationErrors],
  );

  const openDetail = (licenseId: string) => {
    setSelectedLicenseId(licenseId);
    setMutationError(null);
    setMutationSuccess(null);
    setDetailOpen(true);
  };

  const openIssueDialog = useCallback(() => {
    setIssueForm({
      ...DEFAULT_ISSUE_FORM,
      update_channel: selectedTenant?.update_channel ?? "stable",
      expires_at: defaultExpiryDatetimeLocal(),
    });
    setMutationError(null);
    setIssueOpen(true);
  }, [selectedTenant?.update_channel]);

  const openEditDialog = (license: ControlLicense) => {
    if (license.revoked_at) return;
    setEditingLicense(license);
    setIssueForm({
      max_machines: String(license.max_machines),
      update_channel: (license.update_channel ?? selectedTenant?.update_channel ?? "stable") as IssueForm["update_channel"],
      expires_at: license.expires_at ? isoToDatetimeLocal(license.expires_at) : "",
      operator_reason_code: "",
      operator_rationale: "",
    });
    setMutationError(null);
    setEditOpen(true);
  };

  useImperativeHandle(
    ref,
    () => ({
      openIssueDialog,
      refreshLicenses: async () => {
        await loadLicenses(selectedTenantId);
      },
    }),
    [openIssueDialog, selectedTenantId, loadLicenses],
  );

  const exportOnboardingPacket = (license: ControlLicense) => {
    const packet = {
      tenant_id: license.tenant_id,
      tenant_display_name: selectedTenant?.display_name ?? null,
      license_id: license.id,
      activation_key: license.license_key,
      issued_at: license.created_at ?? null,
      expires_at: license.expires_at ?? null,
      update_channel: license.update_channel ?? selectedTenant?.update_channel ?? "stable",
      max_machines: license.max_machines,
      state: deriveLicenseState(license),
      onboarding_note: t("entitlement.packetNote"),
    };
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${license.id}-onboarding-packet.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMutationSuccess(t("entitlement.packetExported", { id: license.id }));
  };

  const issueDisabledReason = !selectedTenant ? t("entitlement.selectTenantFirst") : null;

  const canRevokeSelected = Boolean(selectedLicense) && selectedLicenseState !== "revoked";
  const revokeDisabledReason = !selectedLicense
    ? t("entitlement.selectKeyFirst")
    : selectedLicenseState === "revoked"
      ? t("entitlement.alreadyRevoked")
      : null;

  const noRows = !loadingLicenses && !loadError && licenses.length === 0;
  const noFilterMatches = !loadingLicenses && !loadError && licenses.length > 0 && filteredAndSortedLicenses.length === 0;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t("entitlement.listTitle")}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {t("entitlement.listHint")}
            </p>
          </div>
          {!hideSectionToolbar ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={openIssueDialog} disabled={!selectedTenant}>
                {t("entitlement.addKey")}
              </Button>
              <Button type="button" variant="outline" disabled={loadingLicenses} onClick={() => void loadLicenses(selectedTenantId)}>
                {loadingLicenses ? t("entitlement.refreshing") : t("entitlement.refresh")}
              </Button>
            </div>
          ) : null}
        </div>
        {!selectedTenant ? (
          <p className="mt-2 text-xs text-attention-text">{t("entitlement.selectTenantHint")}</p>
        ) : null}
        {issueDisabledReason ? <p className="mt-2 text-xs text-text-muted">{issueDisabledReason}</p> : null}

        {selectedTenant ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-text-primary">
              {t("editions.modulesTitle")} —{" "}
              {selectedEditionEntry?.label ?? selectedTenant.edition ?? "core"}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              {t("editions.modulesHint")}
            </p>
            <p className="mt-2 text-xs text-text-muted">
              {enabledModules.length > 0 ? enabledModules.join(", ") : "—"}
            </p>
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 lg:grid-cols-5">
          {fixedTenantId ? null : (
          <div>
            <Label htmlFor="tenant">{t("entitlement.tenant")}</Label>
            <select
              id="tenant"
              className="mt-1 flex h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary"
              value={selectedTenantId}
              disabled={loadingTenants}
              onChange={(event) => setSelectedTenantId(event.target.value)}
            >
              {tenants.length === 0 ? <option value="">{t("entitlement.noTenants")}</option> : null}
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.display_name} ({tenant.slug})
                </option>
              ))}
            </select>
          </div>
          )}
          <div>
            <Label htmlFor="key-search">{t("entitlement.search")}</Label>
            <Input
              id="key-search"
              className="mt-1"
              placeholder={t("entitlement.searchPlaceholder")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="state-filter">{t("entitlement.stateFilter")}</Label>
            <select
              id="state-filter"
              className="mt-1 flex h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as LicenseFilter)}
            >
              <option value="all">{t("entitlement.state.all")}</option>
              <option value="active">{t("entitlement.state.active")}</option>
              <option value="expired">{t("entitlement.state.expired")}</option>
              <option value="revoked">{t("entitlement.state.revoked")}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="sort-key">{t("entitlement.sortBy")}</Label>
            <select
              id="sort-key"
              className="mt-1 flex h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as LicenseSortKey)}
            >
              <option value="created_at">{t("entitlement.col.issuedAt")}</option>
              <option value="expires_at">{t("entitlement.col.expiry")}</option>
              <option value="max_machines">{t("entitlement.col.slots")}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="sort-direction">{t("entitlement.sortDirection")}</Label>
            <Button
              id="sort-direction"
              type="button"
              className="mt-1 w-full"
              variant="outline"
              onClick={() => setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))}
            >
              {sortDirection === "asc" ? t("customers.sortAsc") : t("customers.sortDesc")}
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="mt-4 rounded-md border border-danger-border bg-danger-bg p-3 text-sm text-danger" role="alert">
            <p>{loadError}</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="outline" onClick={() => void loadTenants()}>
                {t("entitlement.retryTenants")}
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadLicenses(selectedTenantId)}>
                {t("entitlement.retryKeys")}
              </Button>
            </div>
          </div>
        ) : null}

        {loadingLicenses && licenses.length === 0 ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            {t("entitlement.loading")}
          </div>
        ) : null}

        {noRows ? (
          <div className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            <p>{t("entitlement.noLicenses")}</p>
            <p className="mt-2 text-xs text-text-muted">
              {t("entitlement.noLicensesHint")}
            </p>
          </div>
        ) : null}

        {noFilterMatches ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            <p>{t("entitlement.noMatches")}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setSearchQuery("");
                setStateFilter("all");
              }}
            >
              {t("customers.clearFilters")}
            </Button>
          </div>
        ) : null}

        {filteredAndSortedLicenses.length > 0 ? (
          <div className="mt-4 rounded-md border border-surface-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("entitlement.col.keyId")}</TableHead>
                  <TableHead>{t("entitlement.col.licenseKey")}</TableHead>
                  <TableHead>{t("entitlement.col.issued")}</TableHead>
                  <TableHead>{t("entitlement.col.expiry")}</TableHead>
                  <TableHead>{t("entitlement.col.state")}</TableHead>
                  <TableHead>{t("entitlement.col.slotsShort")}</TableHead>
                  <TableHead className="w-[1%] whitespace-nowrap text-right">{t("entitlement.col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSortedLicenses.map((license) => {
                  const state = deriveLicenseState(license);
                  const canMutate = !license.revoked_at;
                  return (
                    <TableRow
                      key={license.id}
                      className="cursor-pointer"
                      aria-selected={license.id === selectedLicenseId}
                      data-state={license.id === selectedLicenseId ? "selected" : undefined}
                      onClick={() => openDetail(license.id)}
                    >
                      <TableCell className="font-mono text-xs">{license.id}</TableCell>
                      <TableCell className="font-mono text-xs">{license.license_key}</TableCell>
                      <TableCell>{formatDateTime(license.created_at)}</TableCell>
                      <TableCell>{formatDateTime(license.expires_at)}</TableCell>
                      <TableCell>{t(`entitlement.state.${state}`)}</TableCell>
                      <TableCell>{license.max_machines}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 px-2"
                            disabled={!canMutate}
                            title={canMutate ? t("entitlement.editKeyTitle") : t("entitlement.revokedNotEditable")}
                            onClick={() => openEditDialog(license)}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                            <span className="sr-only">{t("entitlement.editKeyTitle")}</span>
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 border-danger-border px-2 text-danger hover:bg-danger-bg"
                            disabled={!canMutate}
                            title={canMutate ? t("entitlement.revokeKey") : t("entitlement.alreadyRevoked")}
                            onClick={() => setDeleteConfirmLicense(license)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                            <span className="sr-only">{t("entitlement.revokeKey")}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      {mutationSuccess ? (
        <div className="rounded-md border border-ok-border bg-ok-bg px-3 py-2 text-sm text-ok-text">
          {mutationSuccess}
        </div>
      ) : null}
      {mutationError && !issueOpen && !editOpen ? (
        <div className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {mutationError}
        </div>
      ) : null}

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) {
            setEditingLicense(null);
            setMutationError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("entitlement.editKey")}</DialogTitle>
            <DialogDescription>
              {t("entitlement.editHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="edit-key-id">{t("entitlement.col.keyId")}</Label>
              <Input id="edit-key-id" value={editingLicense?.id ?? ""} readOnly className="font-mono text-xs" />
            </div>
            <div>
              <Label htmlFor="edit-slots">{t("entitlement.col.slots")}</Label>
              <Input
                id="edit-slots"
                value={issueForm.max_machines}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, max_machines: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.max_machines)}
              />
              {issueValidationErrors.max_machines ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.max_machines)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="edit-channel">{t("entitlement.col.channel")}</Label>
              <select
                id="edit-channel"
                className="mt-1 flex h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary"
                value={issueForm.update_channel}
                onChange={(event) =>
                  setIssueForm((previous) => ({
                    ...previous,
                    update_channel: event.target.value as "stable" | "pilot" | "internal",
                  }))
                }
              >
                <option value="stable">stable</option>
                <option value="pilot">pilot</option>
                <option value="internal">internal</option>
              </select>
            </div>
            <div>
              <Label htmlFor="edit-expiry">{t("entitlement.expiryOptional")}</Label>
              <Input
                id="edit-expiry"
                type="datetime-local"
                value={issueForm.expires_at}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, expires_at: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.expires_at)}
              />
              {issueValidationErrors.expires_at ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.expires_at)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="edit-rationale">{t("entitlement.rationale")}</Label>
              <Textarea
                id="edit-rationale"
                value={issueForm.operator_rationale}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, operator_rationale: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.operator_rationale)}
              />
              {issueValidationErrors.operator_rationale ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.operator_rationale)}
                </p>
              ) : null}
            </div>
            {mutationError && editOpen ? (
              <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger" role="alert">
                {mutationError}
              </p>
            ) : null}
            {!issueFormIsValid && issueBlockingSummaries.length > 0 ? (
              <div className="rounded-md border border-surface-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                <p className="font-medium text-text-primary">{t("entitlement.completeBeforeSaving")}</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {issueBlockingSummaries.map((line, index) => (
                    <li key={`${index}-${line}`}>{t(line)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditOpen(false);
                setEditingLicense(null);
              }}
              disabled={updatingLicense}
            >
              {t("operatorAction.cancel")}
            </Button>
            <Button
              type="button"
              disabled={updatingLicense || !editingLicense || !issueFormIsValid}
              onClick={async () => {
                const errors = validateIssueForm(issueForm);
                if (Object.keys(errors).length > 0 || !editingLicense) return;
                setUpdatingLicense(true);
                setMutationError(null);
                setMutationSuccess(null);
                try {
                  const lic = editingLicense;
                  await updateLicense(lic.id, {
                    max_machines: Number.parseInt(issueForm.max_machines, 10),
                    update_channel: issueForm.update_channel,
                    expires_at: issueForm.expires_at ? new Date(issueForm.expires_at).toISOString() : null,
                    operator_rationale: issueForm.operator_rationale.trim(),
                  });
                  await loadLicenses(lic.tenant_id, lic.id);
                  setMutationSuccess(t("entitlement.updated", { id: lic.id }));
                  setEditOpen(false);
                  setEditingLicense(null);
                  setSelectedLicenseId(lic.id);
                  setDetailOpen(true);
                } catch (err) {
                  setMutationError(errorText(err));
                } finally {
                  setUpdatingLicense(false);
                }
              }}
            >
              {updatingLicense ? t("customers.savingTenant") : t("customers.saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteConfirmLicense !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmLicense(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("entitlement.confirmRevokeTitle")}</DialogTitle>
            <DialogDescription>
              {deleteConfirmLicense
                ? t("entitlement.confirmRevokeBody", {
                    id: deleteConfirmLicense.id,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-revoke-reason">{t("entitlement.revokeReason")}</Label>
            <Input
              id="confirm-revoke-reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder={t("entitlement.revokeReasonPh")}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmLicense(null)} disabled={deletingLicense}>
              {t("operatorAction.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingLicense || revokeReason.trim().length < PRIVILEGED_REASON_MIN_LENGTH}
              onClick={async () => {
                if (!deleteConfirmLicense) return;
                const target = deleteConfirmLicense;
                setDeletingLicense(true);
                setMutationError(null);
                setMutationSuccess(null);
                try {
                  const reason = revokeReason.trim();
                  await revokeLicense(target.id, reason, {
                    reason_code: reason,
                    step_up_token: await requireStepUp(StepUpKinds.entitlementSuspension),
                  });
                  await loadLicenses(target.tenant_id, target.id);
                  setMutationSuccess(t("entitlement.revoked", { id: target.id }));
                  setDeleteConfirmLicense(null);
                  setSelectedLicenseId(target.id);
                  setDetailOpen(true);
                } catch (err) {
                  setMutationError(errorText(err));
                } finally {
                  setDeletingLicense(false);
                }
              }}
            >
              {deletingLicense ? t("entitlement.revoking") : t("entitlement.revokeKey")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("entitlement.addKey")}</DialogTitle>
            <DialogDescription>
              {t("entitlement.issueHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="issue-tenant">{t("entitlement.tenant")}</Label>
              <Input
                id="issue-tenant"
                value={selectedTenant ? `${selectedTenant.display_name} (${selectedTenant.slug})` : t("entitlement.noTenantSelected")}
                readOnly
              />
            </div>
            <div>
              <Label htmlFor="issue-slots">{t("entitlement.col.slots")}</Label>
              <Input
                id="issue-slots"
                value={issueForm.max_machines}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, max_machines: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.max_machines)}
              />
              {issueValidationErrors.max_machines ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.max_machines)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-channel">{t("entitlement.col.channel")}</Label>
              <select
                id="issue-channel"
                className="mt-1 flex h-11 w-full rounded-lg border border-input bg-surface-1 pl-3 pr-9 text-sm text-text-primary"
                value={issueForm.update_channel}
                onChange={(event) =>
                  setIssueForm((previous) => ({
                    ...previous,
                    update_channel: event.target.value as "stable" | "pilot" | "internal",
                  }))
                }
              >
                <option value="stable">stable</option>
                <option value="pilot">pilot</option>
                <option value="internal">internal</option>
              </select>
            </div>
            <div>
              <Label htmlFor="issue-expiry">{t("entitlement.expiryOptional")}</Label>
              <p className="mt-0.5 text-xs text-text-muted">{t("entitlement.expiryHint")}</p>
              <Input
                id="issue-expiry"
                type="datetime-local"
                value={issueForm.expires_at}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, expires_at: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.expires_at)}
              />
              {issueValidationErrors.expires_at ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.expires_at)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-reason-code">{t("entitlement.reasonCodeOptional")}</Label>
              <Input
                id="issue-reason-code"
                placeholder="ONBOARDING-NEW-TENANT"
                value={issueForm.operator_reason_code}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, operator_reason_code: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.operator_reason_code)}
              />
              {issueValidationErrors.operator_reason_code ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.operator_reason_code)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-rationale">{t("entitlement.rationale")}</Label>
              <Textarea
                id="issue-rationale"
                placeholder={t("entitlement.rationalePh")}
                value={issueForm.operator_rationale}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, operator_rationale: event.target.value }));
                }}
                aria-invalid={Boolean(issueValidationErrors.operator_rationale)}
              />
              {issueValidationErrors.operator_rationale ? (
                <p className="mt-1 text-xs text-danger" role="alert">
                  {t(issueValidationErrors.operator_rationale)}
                </p>
              ) : null}
            </div>
            {mutationError && issueOpen ? (
              <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger" role="alert">
                {mutationError}
              </p>
            ) : null}
            {!issueFormIsValid && issueBlockingSummaries.length > 0 ? (
              <div className="rounded-md border border-surface-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                <p className="font-medium text-text-primary">{t("entitlement.completeBeforeIssuing")}</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {issueBlockingSummaries.map((line, index) => (
                    <li key={`${index}-${line}`}>{t(line)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIssueOpen(false)} disabled={issuing}>
              {t("operatorAction.cancel")}
            </Button>
            <Button
              type="button"
              disabled={issuing || !selectedTenant || !issueFormIsValid}
              onClick={async () => {
                const errors = validateIssueForm(issueForm);
                if (Object.keys(errors).length > 0) return;
                if (!selectedTenant) return;

                setIssuing(true);
                setMutationError(null);
                setMutationSuccess(null);
                try {
                  const created = await issueLicense({
                    tenant_id: selectedTenant.id,
                    max_machines: Number.parseInt(issueForm.max_machines, 10),
                    update_channel: issueForm.update_channel,
                    expires_at: issueForm.expires_at
                      ? new Date(issueForm.expires_at).toISOString()
                      : null,
                    operator_reason_code: issueForm.operator_reason_code.trim() || null,
                    operator_rationale: issueForm.operator_rationale.trim(),
                  });
                  await loadLicenses(selectedTenant.id, created.id);
                  setMutationSuccess(t("entitlement.issued", { id: created.id }));
                  setIssueOpen(false);
                  setSelectedLicenseId(created.id);
                  setDetailOpen(true);
                } catch (err) {
                  setMutationError(errorText(err));
                } finally {
                  setIssuing(false);
                }
              }}
            >
              {issuing ? t("entitlement.issuing") : t("entitlement.issueKey")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("entitlement.detailTitle")}</DialogTitle>
            <DialogDescription>
              {t("entitlement.detailBody")}
            </DialogDescription>
          </DialogHeader>

          {!selectedLicense ? (
            <p className="text-sm text-text-secondary">{t("entitlement.selectKeyDetail")}</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>{t("entitlement.col.keyId")}</Label>
                  <Input value={selectedLicense.id} readOnly className="font-mono text-xs" />
                </div>
                <div>
                  <Label>{t("entitlement.col.licenseKey")}</Label>
                  <Input value={selectedLicense.license_key} readOnly className="font-mono text-xs" />
                </div>
                <div>
                  <Label>{t("entitlement.tenant")}</Label>
                  <Input
                    value={selectedTenant ? `${selectedTenant.display_name} (${selectedTenant.id})` : selectedLicense.tenant_id}
                    readOnly
                  />
                </div>
                <div>
                  <Label>{t("entitlement.col.issuedAt")}</Label>
                  <Input value={formatDateTime(selectedLicense.created_at)} readOnly />
                </div>
                <div>
                  <Label>{t("entitlement.col.expiry")}</Label>
                  <Input value={formatDateTime(selectedLicense.expires_at)} readOnly />
                </div>
                <div>
                  <Label>{t("entitlement.col.channel")}</Label>
                  <Input value={selectedLicense.update_channel ?? selectedTenant?.update_channel ?? "stable"} readOnly />
                </div>
                <div>
                  <Label>{t("entitlement.col.slots")}</Label>
                  <Input value={String(selectedLicense.max_machines)} readOnly />
                </div>
                <div>
                  <Label>{t("entitlement.col.state")}</Label>
                  <Input value={selectedLicenseState ? t(`entitlement.state.${selectedLicenseState}`) : ""} readOnly />
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-surface-border p-3">
                <p className="text-xs text-text-secondary">
                  {t("entitlement.handoffHint")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={clipboardBusy}
                    onClick={async () => {
                      if (!selectedLicense) return;
                      setClipboardBusy(true);
                      setMutationError(null);
                      setMutationSuccess(null);
                      try {
                        await navigator.clipboard.writeText(selectedLicense.license_key);
                        setMutationSuccess(t("entitlement.copied", { id: selectedLicense.id }));
                      } catch {
                        // The browser refused the clipboard (permission or insecure context).
                        setMutationError(t("common:errors.clipboard"));
                      } finally {
                        setClipboardBusy(false);
                      }
                    }}
                  >
                    {clipboardBusy ? t("entitlement.copying") : t("entitlement.copyKey")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!selectedLicense) return;
                      exportOnboardingPacket(selectedLicense);
                    }}
                  >
                    {t("entitlement.exportPacket")}
                  </Button>
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-surface-border p-3">
                <Label htmlFor="revoke-reason">{t("entitlement.revokeReason")}</Label>
                <Input
                  id="revoke-reason"
                  placeholder={t("entitlement.revokeReasonPh")}
                  value={revokeReason}
                  onChange={(event) => setRevokeReason(event.target.value)}
                  disabled={!canRevokeSelected}
                />
                {!canRevokeSelected && revokeDisabledReason ? (
                  <p className="text-xs text-text-muted">{revokeDisabledReason}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!canRevokeSelected || revoking || revokeReason.trim().length < PRIVILEGED_REASON_MIN_LENGTH}
                  onClick={async () => {
                    if (!selectedLicense) return;
                    setRevoking(true);
                    setMutationError(null);
                    setMutationSuccess(null);
                    try {
                      const reason = revokeReason.trim();
                      await revokeLicense(selectedLicense.id, reason, {
                        reason_code: reason,
                        step_up_token: await requireStepUp(StepUpKinds.entitlementSuspension),
                      });
                      await loadLicenses(selectedLicense.tenant_id, selectedLicense.id);
                      setMutationSuccess(t("entitlement.revoked", { id: selectedLicense.id }));
                    } catch (err) {
                      setMutationError(errorText(err));
                    } finally {
                      setRevoking(false);
                    }
                  }}
                >
                  {revoking ? t("entitlement.revoking") : t("entitlement.revokeKey")}
                </Button>
                <p className="w-full text-xs text-text-muted">
                  {t("entitlement.actionsHint")}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
  },
);

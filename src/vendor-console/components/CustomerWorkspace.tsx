import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";

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
import type { BulkEntitlementOperationRequestV1 } from "@maintafox/contracts";

import { channelPolicyConsistent } from "@/services/customer-entitlement-machine-contracts";
import { StepUpKinds } from "@/lib/step-up-kinds";
import { StepUpCancelledError, useVendorConsole } from "../VendorConsoleContext";
import { OperatorActionDialog } from "./OperatorActionDialog";
import {
  createTenant,
  deleteTenant,
  resumeTenant,
  suspendTenant,
  PRIVILEGED_REASON_MIN_LENGTH,
  getCohortUpdatePolicy,
  getTenantUpdatePolicy,
  listEditions,
  listTenants,
  rollbackCohortUpdatePolicy,
  rollbackTenantUpdatePolicy,
  updateCohortUpdatePolicy,
  updateTenant,
  updateTenantUpdatePolicy,
  type ControlTenant,
  type EditionCatalogEntry,
  type EditionId,
} from "@/services/license-control-service";
import { ApiRequestError } from "@/lib/api-error";
import { errorText } from "@/lib/error-text";

type TenantChannelFilter = "all" | "stable" | "pilot" | "internal";
type SortKey = "slug" | "display_name" | "rollout_cohort" | "update_channel" | "edition" | "created_at";
type SortDirection = "asc" | "desc";

type AddTenantForm = {
  slug: string;
  display_name: string;
  rollout_cohort: string;
  update_channel: "stable" | "pilot" | "internal";
  edition: EditionId;
};

type AddTenantErrors = Partial<Record<keyof AddTenantForm, string>>;

const DEFAULT_ADD_FORM: AddTenantForm = {
  slug: "",
  display_name: "",
  rollout_cohort: "stable-main",
  update_channel: "stable",
  edition: "core",
};

function compareNullable(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

/** Field problems as translation keys (vendorConsole `customers.validation.*`). */
function validateAddTenantForm(form: AddTenantForm): AddTenantErrors {
  const nextErrors: AddTenantErrors = {};
  const slug = form.slug.trim();
  const displayName = form.display_name.trim();
  const cohort = form.rollout_cohort.trim();

  if (!slug) {
    nextErrors.slug = "customers.validation.slugRequired";
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    nextErrors.slug = "customers.validation.slugFormat";
  } else if (slug.length < 3 || slug.length > 64) {
    nextErrors.slug = "customers.validation.slugLength";
  }

  if (!displayName) {
    nextErrors.display_name = "customers.validation.nameRequired";
  } else if (displayName.length < 2 || displayName.length > 120) {
    nextErrors.display_name = "customers.validation.nameLength";
  }

  if (!cohort) {
    nextErrors.rollout_cohort = "customers.validation.cohortRequired";
  } else if (cohort.length > 64) {
    nextErrors.rollout_cohort = "customers.validation.cohortLength";
  }

  return nextErrors;
}

export function CustomerWorkspace() {
  const { t } = useTranslation("vendorConsole");
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [editionCatalog, setEditionCatalog] = useState<EditionCatalogEntry[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenantSuccess, setTenantSuccess] = useState<string | null>(null);
  /** `add` | `edit` — unified create/update dialog */
  const [tenantDialogMode, setTenantDialogMode] = useState<"add" | "edit" | null>(null);
  const [editingTenantId, setEditingTenantId] = useState<string | null>(null);
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [deleteConfirmTenant, setDeleteConfirmTenant] = useState<ControlTenant | null>(null);
  const [deletingTenant, setDeletingTenant] = useState(false);
  const [deleteSlugTyped, setDeleteSlugTyped] = useState("");
  const [suspension, setSuspension] = useState<{ tenant: ControlTenant; action: "suspend" | "resume" } | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [createTenantError, setCreateTenantError] = useState<string | null>(null);
  /** Set when POST /tenants returns 409 for duplicate slug (shown on slug field). */
  const [slugConflictError, setSlugConflictError] = useState<string | null>(null);
  const [addTenantForm, setAddTenantForm] = useState<AddTenantForm>(DEFAULT_ADD_FORM);
  const [searchQuery, setSearchQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<TenantChannelFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("slug");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [rollingBackPolicy, setRollingBackPolicy] = useState(false);
  const [tenantIds, setTenantIds] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [channel, setChannel] = useState<"stable" | "pilot" | "internal">("stable");
  const [rolloutChannel, setRolloutChannel] = useState<"stable" | "pilot" | "internal">("stable");
  const [tenantPolicyVersion, setTenantPolicyVersion] = useState("");
  const [tenantPolicyMode, setTenantPolicyMode] = useState<"off" | "required" | "emergency" | "inherit">("inherit");
  const [tenantPolicyReason, setTenantPolicyReason] = useState("");
  const [cohortPolicyVersion, setCohortPolicyVersion] = useState("");
  const [cohortPolicyMode, setCohortPolicyMode] = useState<"off" | "required" | "emergency">("off");
  const [cohortPolicyReason, setCohortPolicyReason] = useState("");
  const [operatorReasonCode, setOperatorReasonCode] = useState("");
  const { requireStepUp } = useVendorConsole();
  const [bulkPreviewJson, setBulkPreviewJson] = useState<string | null>(null);

  const consistent = channelPolicyConsistent(channel, rolloutChannel);

  const loadTenants = useCallback(async (preferredTenantId?: string) => {
    setLoadingTenants(true);
    setTenantError(null);
    try {
      const [rows, editions] = await Promise.all([listTenants(), listEditions()]);
      setTenants(rows);
      setEditionCatalog(editions);
      setTenantIds(rows.map((r) => r.id).join(", "));
      if (rows.length === 0) {
        setSelectedTenantId("");
        return;
      }
      const hasPreferred = preferredTenantId && rows.some((tenant) => tenant.id === preferredTenantId);
      const hasCurrent = selectedTenantId && rows.some((tenant) => tenant.id === selectedTenantId);
      const nextSelection = hasPreferred
        ? preferredTenantId
        : hasCurrent
          ? selectedTenantId
          : rows[0]?.id;
      if (nextSelection) {
        setSelectedTenantId(nextSelection);
      }
    } catch (err) {
      setTenantError(errorText(err));
    } finally {
      setLoadingTenants(false);
    }
  }, [selectedTenantId]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  const visibleTenants = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const filtered = tenants.filter((tenant) => {
      if (channelFilter !== "all" && tenant.update_channel !== channelFilter) {
        return false;
      }
      if (!normalizedSearch) return true;
      return [
        tenant.id,
        tenant.slug,
        tenant.display_name,
        tenant.rollout_cohort ?? "",
        tenant.update_channel ?? "",
        tenant.edition ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearch);
    });

    const sorted = [...filtered].sort((left, right) => {
      const direction = sortDirection === "asc" ? 1 : -1;
      if (sortKey === "created_at") {
        return compareNullable(left.created_at, right.created_at) * direction;
      }
      if (sortKey === "display_name") {
        return compareNullable(left.display_name, right.display_name) * direction;
      }
      if (sortKey === "rollout_cohort") {
        return compareNullable(left.rollout_cohort, right.rollout_cohort) * direction;
      }
      if (sortKey === "update_channel") {
        return compareNullable(left.update_channel, right.update_channel) * direction;
      }
      if (sortKey === "edition") {
        return compareNullable(left.edition, right.edition) * direction;
      }
      return compareNullable(left.slug, right.slug) * direction;
    });

    return sorted;
  }, [tenants, searchQuery, channelFilter, sortKey, sortDirection]);

  const loadPolicies = useCallback(async (tenant: ControlTenant) => {
    setLoadingPolicy(true);
    setPolicyError(null);
    try {
      const [tenantPolicy, cohortPolicy] = await Promise.all([
        getTenantUpdatePolicy(tenant.id),
        getCohortUpdatePolicy(tenant.update_channel ?? "stable", tenant.rollout_cohort ?? "stable-main"),
      ]);
      setTenantPolicyVersion(tenantPolicy.force_min_app_version ?? "");
      setTenantPolicyMode(tenantPolicy.force_update_mode);
      setTenantPolicyReason(tenantPolicy.force_update_reason ?? "");
      setCohortPolicyVersion(cohortPolicy.force_min_app_version ?? "");
      setCohortPolicyMode(cohortPolicy.force_update_mode);
      setCohortPolicyReason(cohortPolicy.force_update_reason ?? "");
    } catch (err) {
      setPolicyError(errorText(err));
    } finally {
      setLoadingPolicy(false);
    }
  }, []);

  useEffect(() => {
    const selected = tenants.find((tenant) => tenant.id === selectedTenantId);
    if (!selected) return;
    void loadPolicies(selected);
  }, [selectedTenantId, tenants, loadPolicies]);

  const addTenantValidation = useMemo(() => validateAddTenantForm(addTenantForm), [addTenantForm]);
  const createFormIsValid = Object.keys(addTenantValidation).length === 0;
  const addFormBlockingSummaries = useMemo(
    () => Object.values(addTenantValidation).filter(Boolean),
    [addTenantValidation],
  );

  const buildRequest = (): BulkEntitlementOperationRequestV1 => ({
    dry_run: dryRun,
    tenant_ids: tenantIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    target_channel: channel,
    expected_lineage_version_by_tenant: tenantIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tenantId) => [tenantId, 1]),
  });

  const resetAddDialog = () => {
    setAddTenantForm(DEFAULT_ADD_FORM);
    setCreateTenantError(null);
    setSlugConflictError(null);
    setEditingTenantId(null);
    setTenantDialogMode(null);
  };

  const handleOpenAddDialog = () => {
    resetAddDialog();
    setTenantDialogMode("add");
  };

  const handleOpenEditDialog = (tenant: ControlTenant) => {
    setCreateTenantError(null);
    setSlugConflictError(null);
    setEditingTenantId(tenant.id);
    setAddTenantForm({
      slug: tenant.slug,
      display_name: tenant.display_name,
      rollout_cohort: tenant.rollout_cohort ?? "stable-main",
      update_channel: (tenant.update_channel ?? "stable") as AddTenantForm["update_channel"],
      edition: (tenant.edition ?? "core") as EditionId,
    });
    setTenantDialogMode("edit");
  };

  const handleSaveTenant = async () => {
    const nextErrors = validateAddTenantForm(addTenantForm);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    setCreatingTenant(true);
    setCreateTenantError(null);
    setSlugConflictError(null);
    try {
      if (tenantDialogMode === "edit" && editingTenantId) {
        const updated = await updateTenant(editingTenantId, {
          slug: addTenantForm.slug.trim(),
          display_name: addTenantForm.display_name.trim(),
          rollout_cohort: addTenantForm.rollout_cohort.trim(),
          update_channel: addTenantForm.update_channel,
          edition: addTenantForm.edition,
        });
        setTenantSuccess(t("customers.updatedDone", { name: updated.display_name }));
        await loadTenants(updated.id);
        setTenantDialogMode(null);
        resetAddDialog();
      } else {
        const created = await createTenant({
          slug: addTenantForm.slug.trim(),
          display_name: addTenantForm.display_name.trim(),
          rollout_cohort: addTenantForm.rollout_cohort.trim(),
          update_channel: addTenantForm.update_channel,
          edition: addTenantForm.edition,
        });
        setTenantSuccess(t("customers.addedDone", { name: created.display_name }));
        setSearchQuery("");
        setChannelFilter("all");
        await loadTenants(created.id);
        setTenantDialogMode(null);
        resetAddDialog();
      }
    } catch (err) {
      const message = errorText(err);
      if (err instanceof ApiRequestError && err.code === "tenant_conflict") {
        setSlugConflictError(message);
        setCreateTenantError(null);
      } else {
        setSlugConflictError(null);
        setCreateTenantError(message);
      }
    } finally {
      setCreatingTenant(false);
    }
  };

  /** Soft suspend (step-up entitlement_suspension) or resume (tenant_restore); audited. */
  const runSuspension = async (reason: string) => {
    if (!suspension) return;
    const { tenant, action } = suspension;
    const privileged = {
      reason_code: reason,
      step_up_token: await requireStepUp(action === "suspend" ? StepUpKinds.entitlementSuspension : StepUpKinds.tenantRestore),
    };
    if (action === "suspend") await suspendTenant(tenant.id, privileged);
    else await resumeTenant(tenant.id, privileged);
    setTenantSuccess(t(`customers.${action}Done`, { name: tenant.display_name }));
    await loadTenants();
  };

  const handleConfirmDeleteTenant = async () => {
    if (!deleteConfirmTenant) return;
    setDeletingTenant(true);
    setTenantError(null);
    try {
      await deleteTenant(deleteConfirmTenant.id, {
        confirm_slug: deleteSlugTyped.trim(),
        reason_code: deleteReason.trim(),
        step_up_token: await requireStepUp(StepUpKinds.tenantDelete),
      });
      setDeleteSlugTyped("");
      setDeleteReason("");
      setTenantSuccess(t("customers.deletedDone", { name: deleteConfirmTenant.display_name }));
      setDeleteConfirmTenant(null);
      if (selectedTenantId === deleteConfirmTenant.id) {
        setSelectedTenantId("");
      }
      await loadTenants();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) {
        setTenantError(errorText(err));
      }
    } finally {
      setDeletingTenant(false);
    }
  };

  // Server requires X-Operator-Reason (min 4 chars); the step-up password prompt opens on click.
  const canRunPrivilegedPolicyAction = operatorReasonCode.trim().length >= PRIVILEGED_REASON_MIN_LENGTH;
  const listHasNoRows = !loadingTenants && !tenantError && tenants.length === 0;
  const noVisibleRows = !loadingTenants && !tenantError && tenants.length > 0 && visibleTenants.length === 0;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("customers.title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t("customers.workspaceIntro")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleOpenAddDialog}>
            {t("customers.addCompany")}
          </Button>
          <Button type="button" variant="outline" disabled={loadingTenants} onClick={() => void loadTenants()}>
            {loadingTenants ? t("customers.refreshing") : t("customers.refreshTenants")}
          </Button>
        </div>
      </header>

      {tenantSuccess ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {tenantSuccess}
        </div>
      ) : null}

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.listTitle")}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t("customers.listHint")}
        </p>

        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          <div>
            <Label htmlFor="customer-search">{t("customers.searchLabel")}</Label>
            <Input
              id="customer-search"
              className="mt-1"
              placeholder={t("customers.searchPlaceholder")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="customer-channel-filter">{t("customers.channelFilter")}</Label>
            <select
              id="customer-channel-filter"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={channelFilter}
              onChange={(event) => setChannelFilter(event.target.value as TenantChannelFilter)}
            >
              <option value="all">{t("customers.filterAllChannels")}</option>
              <option value="stable">stable</option>
              <option value="pilot">pilot</option>
              <option value="internal">internal</option>
            </select>
          </div>
          <div>
            <Label htmlFor="customer-sort-key">{t("customers.sortBy")}</Label>
            <select
              id="customer-sort-key"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="slug">{t("customers.columns.slug")}</option>
              <option value="display_name">{t("customers.columns.company")}</option>
              <option value="rollout_cohort">{t("customers.columns.cohort")}</option>
              <option value="edition">{t("customers.columns.edition")}</option>
              <option value="update_channel">{t("customers.columns.channel")}</option>
              <option value="created_at">{t("customers.columns.created")}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="customer-sort-direction">{t("customers.sortDirection")}</Label>
            <Button
              id="customer-sort-direction"
              type="button"
              variant="outline"
              className="mt-1 w-full"
              onClick={() => setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))}
            >
              {sortDirection === "asc"
                ? t("customers.sortAsc")
                : t("customers.sortDesc")}
            </Button>
          </div>
        </div>

        {tenantError ? (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
            <p>{tenantError}</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => void loadTenants()}>
              {t("customers.retry")}
            </Button>
          </div>
        ) : null}

        {loadingTenants && tenants.length === 0 ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            {t("customers.loading")}
          </div>
        ) : null}

        {listHasNoRows ? (
          <div className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-5 text-sm text-text-secondary">
            <p>{t("customers.empty")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" onClick={handleOpenAddDialog}>
                {t("customers.addFirstCompany")}
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadTenants()}>
                {t("customers.retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {noVisibleRows ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            <p>{t("customers.noResults")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearchQuery("");
                  setChannelFilter("all");
                }}
              >
                {t("customers.clearFilters")}
              </Button>
            </div>
          </div>
        ) : null}

        {visibleTenants.length > 0 ? (
          <div className="mt-4 rounded-md border border-surface-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("customers.columns.slug")}</TableHead>
                  <TableHead>{t("customers.columns.company")}</TableHead>
                  <TableHead>{t("customers.columns.id")}</TableHead>
                  <TableHead>{t("customers.columns.edition")}</TableHead>
                  <TableHead>{t("customers.columns.cohort")}</TableHead>
                  <TableHead>{t("customers.columns.channel")}</TableHead>
                  <TableHead className="w-[1%] whitespace-nowrap text-right">
                    {t("customers.columns.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleTenants.map((tenant) => (
                  <TableRow
                    key={tenant.id}
                    data-state={tenant.id === selectedTenantId ? "selected" : undefined}
                    className="cursor-pointer"
                    aria-selected={tenant.id === selectedTenantId}
                    onClick={() => {
                      setSelectedTenantId(tenant.id);
                      setTenantSuccess(null);
                    }}
                  >
                    <TableCell className="font-medium">
                      {tenant.slug}
                      {tenant.suspended_at ? (
                        <span
                          className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-200"
                          title={tenant.suspended_reason ?? undefined}
                        >
                          {t("customers.suspended")}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>{tenant.display_name}</TableCell>
                    <TableCell className="font-mono text-xs">{tenant.id}</TableCell>
                    <TableCell>
                      {editionCatalog.find((e) => e.id === (tenant.edition ?? "core"))?.label ??
                        tenant.edition ??
                        "core"}
                    </TableCell>
                    <TableCell>{tenant.rollout_cohort ?? "—"}</TableCell>
                    <TableCell>{tenant.update_channel ?? "stable"}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 px-2"
                          title={t("customers.editTenant")}
                          onClick={() => handleOpenEditDialog(tenant)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                          <span className="sr-only">{t("customers.editTenant")}</span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 px-2"
                          title={tenant.suspended_at ? t("customers.resumeTenant") : t("customers.suspendTenant")}
                          onClick={() => setSuspension({ tenant, action: tenant.suspended_at ? "resume" : "suspend" })}
                        >
                          {tenant.suspended_at ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
                          <span className="sr-only">
                            {tenant.suspended_at ? t("customers.resumeTenant") : t("customers.suspendTenant")}
                          </span>
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 border-red-500/40 px-2 text-red-200 hover:bg-red-500/10"
                          title={t("customers.deleteTenant")}
                          onClick={() => setDeleteConfirmTenant(tenant)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                          <span className="sr-only">{t("customers.deleteTenant")}</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.metadata")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t("customers.metadataHint")}
        </p>
        {!selectedTenant ? (
          <p className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            {t("customers.selectTenantFirst")}
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tenant-id">{t("customers.columns.id")}</Label>
              <Input id="tenant-id" value={selectedTenant.id} className="mt-1 font-mono text-xs" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-slug">{t("customers.tenantSlug")}</Label>
              <Input id="tenant-slug" value={selectedTenant.slug} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="cohort">{t("customers.cohort")}</Label>
              <Input id="cohort" value={selectedTenant.rollout_cohort ?? "—"} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-edition">{t("customers.edition")}</Label>
              <Input
                id="tenant-edition"
                value={
                  editionCatalog.find((e) => e.id === (selectedTenant.edition ?? "core"))?.label ??
                  selectedTenant.edition ??
                  "core"
                }
                className="mt-1"
                readOnly
              />
            </div>
            <div>
              <Label htmlFor="tenant-name">{t("customers.tenantName")}</Label>
              <Input id="tenant-name" value={selectedTenant.display_name ?? "—"} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-channel">{t("customers.tenantChannel")}</Label>
              <Input id="tenant-channel" value={selectedTenant.update_channel ?? "stable"} className="mt-1" readOnly />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.policy.title")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t("customers.policy.body")}
        </p>
        {loadingPolicy && selectedTenant ? <p className="mt-3 text-xs text-text-secondary">{t("customers.policy.loading")}</p> : null}
        {policyError ? (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <p>{policyError}</p>
            {selectedTenant ? (
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void loadPolicies(selectedTenant)}>
                {t("customers.policy.retry")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!selectedTenant ? (
          <p className="mt-3 text-xs text-text-muted">{t("customers.policy.selectTenant")}</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 rounded-md border border-surface-border p-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="operator-reason">{t("customers.policy.auditReason")}</Label>
                <Input
                  id="operator-reason"
                  value={operatorReasonCode}
                  onChange={(e) => setOperatorReasonCode(e.target.value)}
                  className="mt-1"
                  placeholder="INC-2026-042"
                />
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-surface-border p-3">
                <p className="text-xs font-medium text-text-secondary">{t("customers.policy.tenantOverride", { slug: selectedTenant.slug })}</p>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="tenant-min-version">{t("customers.policy.minVersion")}</Label>
                    <Input
                      id="tenant-min-version"
                      value={tenantPolicyVersion}
                      onChange={(e) => setTenantPolicyVersion(e.target.value)}
                      className="mt-1"
                      placeholder="1.8.0"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tenant-force-mode">{t("customers.policy.mode")}</Label>
                    <select
                      id="tenant-force-mode"
                      className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                      value={tenantPolicyMode}
                      onChange={(e) => setTenantPolicyMode(e.target.value as "off" | "required" | "emergency" | "inherit")}
                    >
                      <option value="inherit">{t("customers.policy.modes.inherit")}</option>
                      <option value="off">{t("customers.policy.modes.off")}</option>
                      <option value="required">{t("customers.policy.modes.required")}</option>
                      <option value="emergency">{t("customers.policy.modes.emergency")}</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="tenant-force-reason">{t("customers.policy.userReason")}</Label>
                    <Input
                      id="tenant-force-reason"
                      value={tenantPolicyReason}
                      onChange={(e) => setTenantPolicyReason(e.target.value)}
                      className="mt-1"
                      placeholder="INC-2026-042"
                    />
                  </div>
                  {!canRunPrivilegedPolicyAction ? (
                    <p className="text-xs text-text-muted">
                      {t("customers.policy.needReason")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={savingPolicy || !canRunPrivilegedPolicyAction}
                      onClick={async () => {
                        if (!selectedTenant) return;
                        setSavingPolicy(true);
                        setPolicyError(null);
                        try {
                          const updated = await updateTenantUpdatePolicy(
                            selectedTenant.id,
                            {
                              force_min_app_version: tenantPolicyVersion.trim() || null,
                              force_update_mode: tenantPolicyMode,
                              force_update_reason: tenantPolicyReason.trim() || null,
                            },
                            {
                              reason_code: operatorReasonCode.trim(),
                              step_up_token: await requireStepUp(StepUpKinds.rolloutPublish),
                            },
                          );
                          setTenantPolicyVersion(updated.force_min_app_version ?? "");
                          setTenantPolicyMode(updated.force_update_mode);
                          setTenantPolicyReason(updated.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(errorText(err));
                        } finally {
                          setSavingPolicy(false);
                        }
                      }}
                    >
                      {savingPolicy ? t("customers.savingTenant") : t("customers.policy.applyTenant")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rollingBackPolicy || !canRunPrivilegedPolicyAction}
                      onClick={async () => {
                        if (!selectedTenant) return;
                        setRollingBackPolicy(true);
                        setPolicyError(null);
                        try {
                          const rolledBack = await rollbackTenantUpdatePolicy(selectedTenant.id, {
                            reason_code: operatorReasonCode.trim(),
                            step_up_token: await requireStepUp(StepUpKinds.forcedRollback),
                          });
                          setTenantPolicyVersion(rolledBack.force_min_app_version ?? "");
                          setTenantPolicyMode(rolledBack.force_update_mode);
                          setTenantPolicyReason(rolledBack.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(errorText(err));
                        } finally {
                          setRollingBackPolicy(false);
                        }
                      }}
                    >
                      {t("customers.policy.rollbackTenant")}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-surface-border p-3">
                <p className="text-xs font-medium text-text-secondary">
                  {t("customers.policy.cohortBaseline", {
                    channel: selectedTenant.update_channel ?? "stable",
                    cohort: selectedTenant.rollout_cohort ?? "stable-main",
                  })}
                </p>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="cohort-min-version">{t("customers.policy.minVersion")}</Label>
                    <Input
                      id="cohort-min-version"
                      value={cohortPolicyVersion}
                      onChange={(e) => setCohortPolicyVersion(e.target.value)}
                      className="mt-1"
                      placeholder="1.8.0"
                    />
                  </div>
                  <div>
                    <Label htmlFor="cohort-force-mode">{t("customers.policy.mode")}</Label>
                    <select
                      id="cohort-force-mode"
                      className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                      value={cohortPolicyMode}
                      onChange={(e) => setCohortPolicyMode(e.target.value as "off" | "required" | "emergency")}
                    >
                      <option value="off">{t("customers.policy.modes.off")}</option>
                      <option value="required">{t("customers.policy.modes.required")}</option>
                      <option value="emergency">{t("customers.policy.modes.emergency")}</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="cohort-force-reason">{t("customers.policy.userReason")}</Label>
                    <Input
                      id="cohort-force-reason"
                      value={cohortPolicyReason}
                      onChange={(e) => setCohortPolicyReason(e.target.value)}
                      className="mt-1"
                      placeholder="INC-2026-042"
                    />
                  </div>
                  {!canRunPrivilegedPolicyAction ? (
                    <p className="text-xs text-text-muted">
                      {t("customers.policy.needReason")}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={savingPolicy || !canRunPrivilegedPolicyAction}
                      onClick={async () => {
                        if (!selectedTenant.rollout_cohort || !selectedTenant.update_channel) return;
                        setSavingPolicy(true);
                        setPolicyError(null);
                        try {
                          const updated = await updateCohortUpdatePolicy(
                            selectedTenant.update_channel,
                            selectedTenant.rollout_cohort,
                            {
                              force_min_app_version: cohortPolicyVersion.trim() || null,
                              force_update_mode: cohortPolicyMode,
                              force_update_reason: cohortPolicyReason.trim() || null,
                            },
                            {
                              reason_code: operatorReasonCode.trim(),
                              step_up_token: await requireStepUp(StepUpKinds.rolloutPublish),
                            },
                          );
                          setCohortPolicyVersion(updated.force_min_app_version ?? "");
                          setCohortPolicyMode(updated.force_update_mode);
                          setCohortPolicyReason(updated.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(errorText(err));
                        } finally {
                          setSavingPolicy(false);
                        }
                      }}
                    >
                      {savingPolicy ? t("customers.savingTenant") : t("customers.policy.applyCohort")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rollingBackPolicy || !canRunPrivilegedPolicyAction}
                      onClick={async () => {
                        if (!selectedTenant.rollout_cohort || !selectedTenant.update_channel) return;
                        setRollingBackPolicy(true);
                        setPolicyError(null);
                        try {
                          const rolledBack = await rollbackCohortUpdatePolicy(
                            selectedTenant.update_channel,
                            selectedTenant.rollout_cohort,
                            {
                              reason_code: operatorReasonCode.trim(),
                              step_up_token: await requireStepUp(StepUpKinds.forcedRollback),
                            },
                          );
                          setCohortPolicyVersion(rolledBack.force_min_app_version ?? "");
                          setCohortPolicyMode(rolledBack.force_update_mode);
                          setCohortPolicyReason(rolledBack.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(errorText(err));
                        } finally {
                          setRollingBackPolicy(false);
                        }
                      }}
                    >
                      {t("customers.policy.rollbackCohort")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.bulk.title")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t("customers.bulk.hint")}
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="bulk-tenants">{t("customers.bulk.tenantIds")}</Label>
            <Input
              id="bulk-tenants"
              value={tenantIds}
              onChange={(e) => setTenantIds(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("customers.bulk.licenseChannel")}</Label>
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                value={channel}
                onChange={(e) => setChannel(e.target.value as "stable" | "pilot" | "internal")}
              >
                <option value="stable">stable</option>
                <option value="pilot">pilot</option>
                <option value="internal">internal</option>
              </select>
            </div>
            <div>
              <Label>{t("customers.bulk.rolloutChannel")}</Label>
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                value={rolloutChannel}
                onChange={(e) => setRolloutChannel(e.target.value as "stable" | "pilot" | "internal")}
              >
                <option value="stable">stable</option>
                <option value="pilot">pilot</option>
                <option value="internal">internal</option>
              </select>
            </div>
          </div>
          {!consistent ? (
            <p className="text-sm text-amber-800 dark:text-amber-200" role="alert">
              {t("customers.bulk.channelMismatch")}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox id="dry-run" checked={dryRun} onCheckedChange={(c) => setDryRun(c === true)} />
            <Label htmlFor="dry-run" className="font-normal">
              {t("customers.bulk.dryRun")}
            </Label>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={!consistent}
            onClick={() => {
              setBulkPreviewJson(JSON.stringify(buildRequest(), null, 2));
            }}
          >
            {t("customers.bulk.buildPreview")}
          </Button>
          {bulkPreviewJson ? (
            <pre className="overflow-auto rounded-md border border-surface-border bg-surface-2 p-3 text-xs">
              {bulkPreviewJson}
            </pre>
          ) : null}
        </div>
      </section>

      <Dialog
        open={tenantDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            resetAddDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tenantDialogMode === "edit"
                ? t("customers.editCompany")
                : t("customers.addCompany")}
            </DialogTitle>
            <DialogDescription>
              {tenantDialogMode === "edit"
                ? t("customers.editDescription")
                : t("customers.addDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="add-company-name">{t("customers.companyName")}</Label>
              <Input
                id="add-company-name"
                value={addTenantForm.display_name}
                onChange={(event) => {
                  setAddTenantForm((previous) => ({ ...previous, display_name: event.target.value }));
                }}
                aria-invalid={Boolean(addTenantValidation.display_name)}
              />
              {addTenantValidation.display_name ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {t(addTenantValidation.display_name)}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="add-company-slug">{t("customers.tenantSlug")}</Label>
              <Input
                id="add-company-slug"
                value={addTenantForm.slug}
                onChange={(event) => {
                  const next = event.target.value.replace(/\s+/g, "-");
                  setSlugConflictError(null);
                  setAddTenantForm((previous) => ({ ...previous, slug: next }));
                }}
                aria-invalid={Boolean(addTenantValidation.slug ?? slugConflictError)}
                placeholder="acme-industries"
              />
              {addTenantValidation.slug || slugConflictError ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {addTenantValidation.slug ? t(addTenantValidation.slug) : slugConflictError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="add-company-channel">{t("customers.columns.channel")}</Label>
                <select
                  id="add-company-channel"
                  className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                  value={addTenantForm.update_channel}
                  onChange={(event) =>
                    setAddTenantForm((previous) => ({
                      ...previous,
                      update_channel: event.target.value as AddTenantForm["update_channel"],
                    }))
                  }
                >
                  <option value="stable">stable</option>
                  <option value="pilot">pilot</option>
                  <option value="internal">internal</option>
                </select>
              </div>
              <div>
                <Label htmlFor="add-company-edition">{t("customers.edition")}</Label>
                <select
                  id="add-company-edition"
                  className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                  value={addTenantForm.edition}
                  onChange={(event) =>
                    setAddTenantForm((previous) => ({
                      ...previous,
                      edition: event.target.value as EditionId,
                    }))
                  }
                >
                  {editionCatalog.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="add-company-cohort">{t("customers.cohort")}</Label>
                <Input
                  id="add-company-cohort"
                  value={addTenantForm.rollout_cohort}
                  onChange={(event) => {
                    setAddTenantForm((previous) => ({ ...previous, rollout_cohort: event.target.value }));
                  }}
                  aria-invalid={Boolean(addTenantValidation.rollout_cohort)}
                />
                {addTenantValidation.rollout_cohort ? (
                  <p className="mt-1 text-xs text-red-300" role="alert">
                    {t(addTenantValidation.rollout_cohort)}
                  </p>
                ) : null}
              </div>
            </div>
            {createTenantError ? (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
                {createTenantError}
              </p>
            ) : null}
            {!createFormIsValid && addFormBlockingSummaries.length > 0 ? (
              <div className="rounded-md border border-surface-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
                <p className="font-medium text-text-primary">
                  {tenantDialogMode === "edit"
                    ? t("entitlement.completeBeforeSaving")
                    : t("customers.completeBeforeAdding")}
                </p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {addFormBlockingSummaries.map((line, index) => (
                    <li key={`${index}-${line}`}>{t(line)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => resetAddDialog()} disabled={creatingTenant}>
              {t("stepUp.cancel")}
            </Button>
            <Button type="button" onClick={() => void handleSaveTenant()} disabled={creatingTenant || !createFormIsValid}>
              {creatingTenant
                ? tenantDialogMode === "edit"
                  ? t("customers.savingTenant")
                  : t("customers.creatingTenant")
                : tenantDialogMode === "edit"
                  ? t("customers.saveChanges")
                  : t("customers.addCompany")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteConfirmTenant !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirmTenant(null);
            setDeleteSlugTyped("");
            setDeleteReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("customers.confirmDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {deleteConfirmTenant
                ? t("customers.confirmDeleteBody", {
                    name: deleteConfirmTenant.display_name,
                    slug: deleteConfirmTenant.slug,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="delete-tenant-slug">
                {t("customers.deleteTypeSlug", { slug: deleteConfirmTenant?.slug ?? "" })}
              </Label>
              <Input
                id="delete-tenant-slug"
                autoComplete="off"
                value={deleteSlugTyped}
                onChange={(e) => setDeleteSlugTyped(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="delete-tenant-reason">{t("customers.deleteReason")}</Label>
              <Input id="delete-tenant-reason" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmTenant(null)} disabled={deletingTenant}>
              {t("stepUp.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                deletingTenant ||
                deleteSlugTyped.trim() !== deleteConfirmTenant?.slug ||
                deleteReason.trim().length < PRIVILEGED_REASON_MIN_LENGTH
              }
              onClick={() => void handleConfirmDeleteTenant()}
            >
              {deletingTenant ? t("customers.deletingTenant") : t("customers.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OperatorActionDialog
        open={suspension !== null}
        title={suspension ? t(`customers.${suspension.action}Dialog.title`) : ""}
        description={suspension ? t(`customers.${suspension.action}Dialog.body`, { name: suspension.tenant.display_name }) : ""}
        confirmLabel={suspension ? t(`customers.${suspension.action}Dialog.confirm`) : ""}
        destructive={suspension?.action === "suspend"}
        onConfirm={runSuspension}
        onClose={() => setSuspension(null)}
      />
    </div>
  );
}

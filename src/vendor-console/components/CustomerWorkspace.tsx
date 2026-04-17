import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import type { BulkEntitlementOperationRequestV1 } from "@shared/ipc-types";

import { channelPolicyConsistent } from "@/services/customer-entitlement-machine-contracts";
import {
  createTenant,
  getCohortUpdatePolicy,
  getTenantUpdatePolicy,
  listTenants,
  rollbackCohortUpdatePolicy,
  rollbackTenantUpdatePolicy,
  updateCohortUpdatePolicy,
  updateTenantUpdatePolicy,
  type ControlTenant,
} from "@/services/license-control-service";

type TenantChannelFilter = "all" | "stable" | "pilot" | "internal";
type SortKey = "slug" | "display_name" | "rollout_cohort" | "update_channel" | "created_at";
type SortDirection = "asc" | "desc";

type AddTenantForm = {
  slug: string;
  display_name: string;
  rollout_cohort: string;
  update_channel: "stable" | "pilot" | "internal";
};

type AddTenantErrors = Partial<Record<keyof AddTenantForm, string>>;

const DEFAULT_ADD_FORM: AddTenantForm = {
  slug: "",
  display_name: "",
  rollout_cohort: "stable-main",
  update_channel: "stable",
};

function compareNullable(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

function validateAddTenantForm(form: AddTenantForm): AddTenantErrors {
  const nextErrors: AddTenantErrors = {};
  const slug = form.slug.trim();
  const displayName = form.display_name.trim();
  const cohort = form.rollout_cohort.trim();

  if (!slug) {
    nextErrors.slug = "Slug is required.";
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    nextErrors.slug = "Use lowercase letters, numbers, and dashes only.";
  } else if (slug.length < 3 || slug.length > 64) {
    nextErrors.slug = "Slug must be between 3 and 64 characters.";
  }

  if (!displayName) {
    nextErrors.display_name = "Company name is required.";
  } else if (displayName.length < 2 || displayName.length > 120) {
    nextErrors.display_name = "Company name must be between 2 and 120 characters.";
  }

  if (!cohort) {
    nextErrors.rollout_cohort = "Rollout cohort is required.";
  } else if (cohort.length > 64) {
    nextErrors.rollout_cohort = "Rollout cohort must be 64 characters or fewer.";
  }

  return nextErrors;
}

export function CustomerWorkspace() {
  const { t } = useTranslation("vendorConsole");
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [tenantSuccess, setTenantSuccess] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [createTenantError, setCreateTenantError] = useState<string | null>(null);
  const [addTenantForm, setAddTenantForm] = useState<AddTenantForm>(DEFAULT_ADD_FORM);
  const [addTenantErrors, setAddTenantErrors] = useState<AddTenantErrors>({});
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
  const [stepUpToken, setStepUpToken] = useState("");
  const [bulkPreviewJson, setBulkPreviewJson] = useState<string | null>(null);

  const consistent = channelPolicyConsistent(channel, rolloutChannel);

  const loadTenants = useCallback(async (preferredTenantId?: string) => {
    setLoadingTenants(true);
    setTenantError(null);
    try {
      const rows = await listTenants();
      setTenants(rows);
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
      setTenantError(err instanceof Error ? err.message : "Failed to load tenants");
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
      setPolicyError(err instanceof Error ? err.message : "Failed to load update policy");
    } finally {
      setLoadingPolicy(false);
    }
  }, []);

  useEffect(() => {
    const selected = tenants.find((tenant) => tenant.id === selectedTenantId);
    if (!selected) return;
    void loadPolicies(selected);
  }, [selectedTenantId, tenants, loadPolicies]);

  const createFormIsValid = useMemo(
    () => Object.keys(validateAddTenantForm(addTenantForm)).length === 0,
    [addTenantForm],
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
    setAddTenantErrors({});
    setCreateTenantError(null);
  };

  const handleOpenAddDialog = () => {
    resetAddDialog();
    setIsAddDialogOpen(true);
  };

  const handleCreateTenant = async () => {
    const nextErrors = validateAddTenantForm(addTenantForm);
    setAddTenantErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    setCreatingTenant(true);
    setCreateTenantError(null);
    try {
      const created = await createTenant({
        slug: addTenantForm.slug.trim(),
        display_name: addTenantForm.display_name.trim(),
        rollout_cohort: addTenantForm.rollout_cohort.trim(),
        update_channel: addTenantForm.update_channel,
      });
      setTenantSuccess(`Customer "${created.display_name}" was added successfully.`);
      setSearchQuery("");
      setChannelFilter("all");
      await loadTenants(created.id);
      setIsAddDialogOpen(false);
      resetAddDialog();
    } catch (err) {
      setCreateTenantError(err instanceof Error ? err.message : "Create tenant failed");
    } finally {
      setCreatingTenant(false);
    }
  };

  const canRunPrivilegedPolicyAction = operatorReasonCode.trim().length > 0 && stepUpToken.trim().length > 0;
  const listHasNoRows = !loadingTenants && !tenantError && tenants.length === 0;
  const noVisibleRows = !loadingTenants && !tenantError && tenants.length > 0 && visibleTenants.length === 0;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("customers.title", "Customers")}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              "customers.workspaceIntro",
              "Tenant identity, deployment metadata, cohort, and environment flags. Mutations require customer.manage and server-side checks.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleOpenAddDialog}>
            {t("customers.addCompany", "Add customer/company")}
          </Button>
          <Button type="button" variant="outline" disabled={loadingTenants} onClick={() => void loadTenants()}>
            {loadingTenants ? t("customers.refreshing", "Refreshing…") : t("customers.refreshTenants", "Refresh")}
          </Button>
        </div>
      </header>

      {tenantSuccess ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {tenantSuccess}
        </div>
      ) : null}

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.listTitle", "Customer list")}</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            "customers.listHint",
            "Search, filter, sort, and select a customer before editing tenant-level settings.",
          )}
        </p>

        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          <div>
            <Label htmlFor="customer-search">{t("customers.searchLabel", "Search customers")}</Label>
            <Input
              id="customer-search"
              className="mt-1"
              placeholder={t("customers.searchPlaceholder", "Search by slug, company, id, cohort")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="customer-channel-filter">{t("customers.channelFilter", "Channel filter")}</Label>
            <select
              id="customer-channel-filter"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={channelFilter}
              onChange={(event) => setChannelFilter(event.target.value as TenantChannelFilter)}
            >
              <option value="all">{t("customers.filterAllChannels", "All channels")}</option>
              <option value="stable">stable</option>
              <option value="pilot">pilot</option>
              <option value="internal">internal</option>
            </select>
          </div>
          <div>
            <Label htmlFor="customer-sort-key">{t("customers.sortBy", "Sort by")}</Label>
            <select
              id="customer-sort-key"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
            >
              <option value="slug">{t("customers.columns.slug", "Slug")}</option>
              <option value="display_name">{t("customers.columns.company", "Company")}</option>
              <option value="rollout_cohort">{t("customers.columns.cohort", "Cohort")}</option>
              <option value="update_channel">{t("customers.columns.channel", "Channel")}</option>
              <option value="created_at">{t("customers.columns.created", "Created")}</option>
            </select>
          </div>
          <div>
            <Label htmlFor="customer-sort-direction">{t("customers.sortDirection", "Sort direction")}</Label>
            <Button
              id="customer-sort-direction"
              type="button"
              variant="outline"
              className="mt-1 w-full"
              onClick={() => setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))}
            >
              {sortDirection === "asc"
                ? t("customers.sortAsc", "Ascending")
                : t("customers.sortDesc", "Descending")}
            </Button>
          </div>
        </div>

        {tenantError ? (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
            <p>{tenantError}</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => void loadTenants()}>
              {t("customers.retry", "Retry")}
            </Button>
          </div>
        ) : null}

        {loadingTenants && tenants.length === 0 ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            {t("customers.loading", "Loading customers…")}
          </div>
        ) : null}

        {listHasNoRows ? (
          <div className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-5 text-sm text-text-secondary">
            <p>{t("customers.empty", "No customers found.")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" onClick={handleOpenAddDialog}>
                {t("customers.addFirstCompany", "Add first customer/company")}
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadTenants()}>
                {t("customers.retry", "Retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {noVisibleRows ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            <p>{t("customers.noResults", "No customers match the current filters.")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearchQuery("");
                  setChannelFilter("all");
                }}
              >
                {t("customers.clearFilters", "Clear filters")}
              </Button>
            </div>
          </div>
        ) : null}

        {visibleTenants.length > 0 ? (
          <div className="mt-4 rounded-md border border-surface-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("customers.columns.slug", "Slug")}</TableHead>
                  <TableHead>{t("customers.columns.company", "Company")}</TableHead>
                  <TableHead>{t("customers.columns.id", "Tenant ID")}</TableHead>
                  <TableHead>{t("customers.columns.cohort", "Cohort")}</TableHead>
                  <TableHead>{t("customers.columns.channel", "Channel")}</TableHead>
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
                    <TableCell className="font-medium">{tenant.slug}</TableCell>
                    <TableCell>{tenant.display_name}</TableCell>
                    <TableCell className="font-mono text-xs">{tenant.id}</TableCell>
                    <TableCell>{tenant.rollout_cohort ?? "—"}</TableCell>
                    <TableCell>{tenant.update_channel ?? "stable"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.metadata", "Workspace metadata")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            "customers.metadataHint",
            "Tenant metadata is loaded from the control-plane API and stays authoritative for operations.",
          )}
        </p>
        {!selectedTenant ? (
          <p className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            {t("customers.selectTenantFirst", "Select a customer row to view tenant metadata and policies.")}
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tenant-id">{t("customers.columns.id", "Tenant ID")}</Label>
              <Input id="tenant-id" value={selectedTenant.id} className="mt-1 font-mono text-xs" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-slug">{t("customers.tenantSlug", "Tenant slug")}</Label>
              <Input id="tenant-slug" value={selectedTenant.slug} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="cohort">{t("customers.cohort", "Rollout cohort")}</Label>
              <Input id="cohort" value={selectedTenant.rollout_cohort ?? "—"} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-name">{t("customers.tenantName", "Tenant display name")}</Label>
              <Input id="tenant-name" value={selectedTenant.display_name ?? "—"} className="mt-1" readOnly />
            </div>
            <div>
              <Label htmlFor="tenant-channel">{t("customers.tenantChannel", "Tenant update channel")}</Label>
              <Input id="tenant-channel" value={selectedTenant.update_channel ?? "stable"} className="mt-1" readOnly />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">Force-update governance</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Enforce minimum desktop versions per tenant or cohort. Emergency mode blocks operations until clients update.
        </p>
        {loadingPolicy && selectedTenant ? <p className="mt-3 text-xs text-text-secondary">Loading policy details…</p> : null}
        {policyError ? (
          <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
            <p>{policyError}</p>
            {selectedTenant ? (
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void loadPolicies(selectedTenant)}>
                Retry policy load
              </Button>
            ) : null}
          </div>
        ) : null}
        {!selectedTenant ? (
          <p className="mt-3 text-xs text-text-muted">Select a tenant to manage update governance.</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 rounded-md border border-surface-border p-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="operator-reason">Audit reason code (header)</Label>
                <Input
                  id="operator-reason"
                  value={operatorReasonCode}
                  onChange={(e) => setOperatorReasonCode(e.target.value)}
                  className="mt-1"
                  placeholder="INC-2026-042"
                />
              </div>
              <div>
                <Label htmlFor="step-up-token">Step-up token (header)</Label>
                <Input
                  id="step-up-token"
                  value={stepUpToken}
                  onChange={(e) => setStepUpToken(e.target.value)}
                  className="mt-1"
                  placeholder="stepup-approval-token"
                />
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-surface-border p-3">
                <p className="text-xs font-medium text-text-secondary">Tenant override ({selectedTenant.slug})</p>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="tenant-min-version">Minimum app version</Label>
                    <Input
                      id="tenant-min-version"
                      value={tenantPolicyVersion}
                      onChange={(e) => setTenantPolicyVersion(e.target.value)}
                      className="mt-1"
                      placeholder="ex: 1.8.0"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tenant-force-mode">Mode</Label>
                    <select
                      id="tenant-force-mode"
                      className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                      value={tenantPolicyMode}
                      onChange={(e) => setTenantPolicyMode(e.target.value as "off" | "required" | "emergency" | "inherit")}
                    >
                      <option value="inherit">inherit cohort policy</option>
                      <option value="off">off</option>
                      <option value="required">required (version gate)</option>
                      <option value="emergency">emergency override</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="tenant-force-reason">Operator reason</Label>
                    <Input
                      id="tenant-force-reason"
                      value={tenantPolicyReason}
                      onChange={(e) => setTenantPolicyReason(e.target.value)}
                      className="mt-1"
                      placeholder="Incident INC-2026-042"
                    />
                  </div>
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
                              step_up_token: stepUpToken.trim(),
                            },
                          );
                          setTenantPolicyVersion(updated.force_min_app_version ?? "");
                          setTenantPolicyMode(updated.force_update_mode);
                          setTenantPolicyReason(updated.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(err instanceof Error ? err.message : "Failed to update tenant policy");
                        } finally {
                          setSavingPolicy(false);
                        }
                      }}
                    >
                      {savingPolicy ? "Saving…" : "Apply tenant policy"}
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
                            step_up_token: stepUpToken.trim(),
                          });
                          setTenantPolicyVersion(rolledBack.force_min_app_version ?? "");
                          setTenantPolicyMode(rolledBack.force_update_mode);
                          setTenantPolicyReason(rolledBack.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(err instanceof Error ? err.message : "Tenant policy rollback failed");
                        } finally {
                          setRollingBackPolicy(false);
                        }
                      }}
                    >
                      Rollback tenant policy
                    </Button>
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-surface-border p-3">
                <p className="text-xs font-medium text-text-secondary">
                  Cohort baseline ({selectedTenant.update_channel ?? "stable"} / {selectedTenant.rollout_cohort ?? "stable-main"})
                </p>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label htmlFor="cohort-min-version">Minimum app version</Label>
                    <Input
                      id="cohort-min-version"
                      value={cohortPolicyVersion}
                      onChange={(e) => setCohortPolicyVersion(e.target.value)}
                      className="mt-1"
                      placeholder="ex: 1.8.0"
                    />
                  </div>
                  <div>
                    <Label htmlFor="cohort-force-mode">Mode</Label>
                    <select
                      id="cohort-force-mode"
                      className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
                      value={cohortPolicyMode}
                      onChange={(e) => setCohortPolicyMode(e.target.value as "off" | "required" | "emergency")}
                    >
                      <option value="off">off</option>
                      <option value="required">required (version gate)</option>
                      <option value="emergency">emergency override</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="cohort-force-reason">Operator reason</Label>
                    <Input
                      id="cohort-force-reason"
                      value={cohortPolicyReason}
                      onChange={(e) => setCohortPolicyReason(e.target.value)}
                      className="mt-1"
                      placeholder="Release rollback after canary failure"
                    />
                  </div>
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
                              step_up_token: stepUpToken.trim(),
                            },
                          );
                          setCohortPolicyVersion(updated.force_min_app_version ?? "");
                          setCohortPolicyMode(updated.force_update_mode);
                          setCohortPolicyReason(updated.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(err instanceof Error ? err.message : "Failed to update cohort policy");
                        } finally {
                          setSavingPolicy(false);
                        }
                      }}
                    >
                      {savingPolicy ? "Saving…" : "Apply cohort policy"}
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
                              step_up_token: stepUpToken.trim(),
                            },
                          );
                          setCohortPolicyVersion(rolledBack.force_min_app_version ?? "");
                          setCohortPolicyMode(rolledBack.force_update_mode);
                          setCohortPolicyReason(rolledBack.force_update_reason ?? "");
                        } catch (err) {
                          setPolicyError(err instanceof Error ? err.message : "Cohort policy rollback failed");
                        } finally {
                          setRollingBackPolicy(false);
                        }
                      }}
                    >
                      Rollback cohort policy
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <h2 className="text-sm font-semibold">{t("customers.bulk.title", "Bulk channel reassignment (dry-run)")}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          {t(
            "customers.bulk.hint",
            "Safe bulk: dry-run first, per-tenant lineage version for optimistic concurrency, channel alignment with rollout.",
          )}
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="bulk-tenants">{t("customers.bulk.tenantIds", "Tenant IDs (comma-separated)")}</Label>
            <Input
              id="bulk-tenants"
              value={tenantIds}
              onChange={(e) => setTenantIds(e.target.value)}
              className="mt-1 font-mono text-sm"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t("customers.bulk.licenseChannel", "License / entitlement channel")}</Label>
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
              <Label>{t("customers.bulk.rolloutChannel", "Rollout channel (must match)")}</Label>
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
              {t(
                "customers.bulk.channelMismatch",
                "License channel and rollout channel differ — resolve before apply.",
              )}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox id="dry-run" checked={dryRun} onCheckedChange={(c) => setDryRun(c === true)} />
            <Label htmlFor="dry-run" className="font-normal">
              {t("customers.bulk.dryRun", "Dry run (no mutations)")}
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
            {t("customers.bulk.buildPreview", "Build request payload")}
          </Button>
          {bulkPreviewJson ? (
            <pre className="overflow-auto rounded-md border border-surface-border bg-surface-2 p-3 text-xs">
              {bulkPreviewJson}
            </pre>
          ) : null}
        </div>
      </section>

      <Dialog
        open={isAddDialogOpen}
        onOpenChange={(open) => {
          setIsAddDialogOpen(open);
          if (!open) {
            resetAddDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("customers.addCompany", "Add customer/company")}</DialogTitle>
            <DialogDescription>
              {t(
                "customers.addDescription",
                "Create a new customer company. Fields are validated before sending to the control-plane API.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="add-company-name">{t("customers.companyName", "Company name")}</Label>
              <Input
                id="add-company-name"
                value={addTenantForm.display_name}
                onChange={(event) => {
                  setAddTenantForm((previous) => ({ ...previous, display_name: event.target.value }));
                  setAddTenantErrors((previous) => ({ ...previous, display_name: undefined }));
                }}
                aria-invalid={Boolean(addTenantErrors.display_name)}
              />
              {addTenantErrors.display_name ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {addTenantErrors.display_name}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="add-company-slug">{t("customers.tenantSlug", "Tenant slug")}</Label>
              <Input
                id="add-company-slug"
                value={addTenantForm.slug}
                onChange={(event) => {
                  setAddTenantForm((previous) => ({ ...previous, slug: event.target.value }));
                  setAddTenantErrors((previous) => ({ ...previous, slug: undefined }));
                }}
                aria-invalid={Boolean(addTenantErrors.slug)}
                placeholder="acme-industries"
              />
              {addTenantErrors.slug ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {addTenantErrors.slug}
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="add-company-channel">{t("customers.columns.channel", "Channel")}</Label>
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
                <Label htmlFor="add-company-cohort">{t("customers.cohort", "Rollout cohort")}</Label>
                <Input
                  id="add-company-cohort"
                  value={addTenantForm.rollout_cohort}
                  onChange={(event) => {
                    setAddTenantForm((previous) => ({ ...previous, rollout_cohort: event.target.value }));
                    setAddTenantErrors((previous) => ({ ...previous, rollout_cohort: undefined }));
                  }}
                  aria-invalid={Boolean(addTenantErrors.rollout_cohort)}
                />
                {addTenantErrors.rollout_cohort ? (
                  <p className="mt-1 text-xs text-red-300" role="alert">
                    {addTenantErrors.rollout_cohort}
                  </p>
                ) : null}
              </div>
            </div>
            {createTenantError ? (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200" role="alert">
                {createTenantError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)} disabled={creatingTenant}>
              {t("stepUp.cancel", "Cancel")}
            </Button>
            <Button type="button" onClick={() => void handleCreateTenant()} disabled={creatingTenant || !createFormIsValid}>
              {creatingTenant ? t("customers.creatingTenant", "Creating…") : t("customers.addCompany", "Add customer/company")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

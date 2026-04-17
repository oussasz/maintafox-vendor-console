import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import {
  issueLicense,
  listTenantLicenses,
  listTenants,
  revokeLicense,
  type ControlLicense,
  type ControlTenant,
} from "@/services/license-control-service";

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

function validateIssueForm(form: IssueForm): IssueFormErrors {
  const errors: IssueFormErrors = {};
  const maxMachines = Number.parseInt(form.max_machines, 10);
  if (Number.isNaN(maxMachines) || maxMachines < 1 || maxMachines > 1000) {
    errors.max_machines = "Slot limit must be a number between 1 and 1000.";
  }

  if (form.expires_at.trim()) {
    const parsed = Date.parse(form.expires_at);
    if (Number.isNaN(parsed)) {
      errors.expires_at = "Expiry must be a valid date/time.";
    }
  }

  if (form.operator_reason_code.trim() && form.operator_reason_code.trim().length < 2) {
    errors.operator_reason_code = "Reason code must be at least 2 characters.";
  }

  if (form.operator_rationale.trim().length < 8) {
    errors.operator_rationale = "Operator rationale must be at least 8 characters.";
  }
  return errors;
}

export function EntitlementLifecyclePanel() {
  const { t } = useTranslation("vendorConsole");
  const [tenants, setTenants] = useState<ControlTenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
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
  const [revoking, setRevoking] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueForm, setIssueForm] = useState<IssueForm>(DEFAULT_ISSUE_FORM);
  const [issueFormErrors, setIssueFormErrors] = useState<IssueFormErrors>({});
  const [revokeReason, setRevokeReason] = useState("");
  const [clipboardBusy, setClipboardBusy] = useState(false);

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
    [tenants, selectedTenantId],
  );

  const selectedLicense = useMemo(
    () => licenses.find((license) => license.id === selectedLicenseId) ?? null,
    [licenses, selectedLicenseId],
  );

  const selectedLicenseState = selectedLicense ? deriveLicenseState(selectedLicense) : null;

  const loadTenants = useCallback(async () => {
    setLoadingTenants(true);
    setLoadError(null);
    try {
      const rows = await listTenants();
      setTenants(rows);
      if (rows.length === 0) {
        setSelectedTenantId("");
        setLicenses([]);
        return;
      }
      setSelectedTenantId((previous) => {
        if (previous && rows.some((tenant) => tenant.id === previous)) {
          return previous;
        }
        return rows[0]?.id ?? "";
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load tenants");
    } finally {
      setLoadingTenants(false);
    }
  }, []);

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
        setLoadError(err instanceof Error ? err.message : "Failed to load entitlements");
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

  const issueFormIsValid = useMemo(
    () => Object.keys(validateIssueForm(issueForm)).length === 0,
    [issueForm],
  );

  const openDetail = (licenseId: string) => {
    setSelectedLicenseId(licenseId);
    setMutationError(null);
    setMutationSuccess(null);
    setDetailOpen(true);
  };

  const openIssueDialog = () => {
    setIssueForm({
      ...DEFAULT_ISSUE_FORM,
      update_channel: selectedTenant?.update_channel ?? "stable",
    });
    setIssueFormErrors({});
    setMutationError(null);
    setIssueOpen(true);
  };

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
      onboarding_note: "Share securely with customer onboarding contact only.",
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
    setMutationSuccess(`Onboarding packet exported for ${license.id}.`);
  };

  const issueDisabledReason = !selectedTenant
    ? "Select a tenant first."
    : issueFormIsValid
      ? null
      : "Fix validation errors before issuing a key.";

  const canRevokeSelected = Boolean(selectedLicense) && selectedLicenseState !== "revoked";
  const revokeDisabledReason = !selectedLicense
    ? "Select a key row first."
    : selectedLicenseState === "revoked"
      ? "This key is already revoked."
      : null;

  const updateDisabledReason = "Update key metadata is unavailable: no API endpoint exists for license update.";
  const deleteDisabledReason = "Delete is unavailable: policy requires revocation for auditability.";

  const noRows = !loadingLicenses && !loadError && licenses.length === 0;
  const noFilterMatches = !loadingLicenses && !loadError && licenses.length > 0 && filteredAndSortedLicenses.length === 0;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-surface-border bg-surface-1 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t("entitlement.listTitle", "Entitlement keys")}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {t(
                "entitlement.listHint",
                "Find and inspect key records quickly. Every row opens full key metadata and lifecycle actions.",
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={openIssueDialog} disabled={!selectedTenant}>
              {t("entitlement.addKey", "Add/Issue key")}
            </Button>
            <Button type="button" variant="outline" disabled={loadingLicenses} onClick={() => void loadLicenses(selectedTenantId)}>
              {loadingLicenses ? t("entitlement.refreshing", "Refreshing…") : t("entitlement.refresh", "Refresh")}
            </Button>
          </div>
        </div>
        {!selectedTenant ? (
          <p className="mt-2 text-xs text-amber-300">Select a tenant to issue or manage entitlement keys.</p>
        ) : null}
        {!selectedTenant && issueDisabledReason ? (
          <p className="mt-2 text-xs text-text-muted">{issueDisabledReason}</p>
        ) : null}

        <div className="mt-4 grid gap-3 lg:grid-cols-5">
          <div>
            <Label htmlFor="tenant">{t("entitlement.tenant", "Tenant")}</Label>
            <select
              id="tenant"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={selectedTenantId}
              disabled={loadingTenants}
              onChange={(event) => setSelectedTenantId(event.target.value)}
            >
              {tenants.length === 0 ? <option value="">{t("entitlement.noTenants", "No tenants available")}</option> : null}
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.display_name} ({tenant.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="key-search">{t("entitlement.search", "Search keys")}</Label>
            <Input
              id="key-search"
              className="mt-1"
              placeholder={t("entitlement.searchPlaceholder", "Search by key, id, tenant")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="state-filter">{t("entitlement.stateFilter", "State filter")}</Label>
            <select
              id="state-filter"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as LicenseFilter)}
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="revoked">Revoked</option>
            </select>
          </div>
          <div>
            <Label htmlFor="sort-key">{t("entitlement.sortBy", "Sort by")}</Label>
            <select
              id="sort-key"
              className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as LicenseSortKey)}
            >
              <option value="created_at">Issued at</option>
              <option value="expires_at">Expiry</option>
              <option value="max_machines">Slot limit</option>
            </select>
          </div>
          <div>
            <Label htmlFor="sort-direction">{t("entitlement.sortDirection", "Sort direction")}</Label>
            <Button
              id="sort-direction"
              type="button"
              className="mt-1 w-full"
              variant="outline"
              onClick={() => setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"))}
            >
              {sortDirection === "asc" ? "Ascending" : "Descending"}
            </Button>
          </div>
        </div>

        {loadError ? (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
            <p>{loadError}</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="outline" onClick={() => void loadTenants()}>
                Retry tenant load
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadLicenses(selectedTenantId)}>
                Retry key load
              </Button>
            </div>
          </div>
        ) : null}

        {loadingLicenses && licenses.length === 0 ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            {t("entitlement.loading", "Loading entitlement keys…")}
          </div>
        ) : null}

        {noRows ? (
          <div className="mt-4 rounded-md border border-dashed border-surface-border bg-surface-2 p-4 text-sm text-text-secondary">
            <p>{t("entitlement.noLicenses", "No keys have been issued for this tenant.")}</p>
            <div className="mt-3 flex gap-2">
              <Button type="button" onClick={openIssueDialog} disabled={!selectedTenant}>
                {t("entitlement.addKey", "Add/Issue key")}
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadLicenses(selectedTenantId)}>
                {t("entitlement.refresh", "Refresh")}
              </Button>
            </div>
          </div>
        ) : null}

        {noFilterMatches ? (
          <div className="mt-4 rounded-md border border-surface-border bg-surface-2 p-3 text-sm text-text-secondary">
            <p>{t("entitlement.noMatches", "No keys match the current filters.")}</p>
            <Button
              type="button"
              variant="outline"
              className="mt-2"
              onClick={() => {
                setSearchQuery("");
                setStateFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : null}

        {filteredAndSortedLicenses.length > 0 ? (
          <div className="mt-4 rounded-md border border-surface-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key ID</TableHead>
                  <TableHead>License key</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Slots</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAndSortedLicenses.map((license) => {
                  const state = deriveLicenseState(license);
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
                      <TableCell>{state}</TableCell>
                      <TableCell>{license.max_machines}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      {mutationSuccess ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {mutationSuccess}
        </div>
      ) : null}
      {mutationError ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
          {mutationError}
        </div>
      ) : null}

      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("entitlement.addKey", "Add/Issue key")}</DialogTitle>
            <DialogDescription>
              {t(
                "entitlement.issueHint",
                "Issue a new entitlement key for the selected tenant. This action creates a real key in the control-plane API.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="issue-tenant">Tenant</Label>
              <Input
                id="issue-tenant"
                value={selectedTenant ? `${selectedTenant.display_name} (${selectedTenant.slug})` : "No tenant selected"}
                readOnly
              />
            </div>
            <div>
              <Label htmlFor="issue-slots">Slot limit</Label>
              <Input
                id="issue-slots"
                value={issueForm.max_machines}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, max_machines: event.target.value }));
                  setIssueFormErrors((previous) => ({ ...previous, max_machines: undefined }));
                }}
                aria-invalid={Boolean(issueFormErrors.max_machines)}
              />
              {issueFormErrors.max_machines ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {issueFormErrors.max_machines}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-channel">Channel</Label>
              <select
                id="issue-channel"
                className="mt-1 flex h-10 w-full rounded-md border border-surface-border bg-surface-0 px-3 text-sm"
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
              <Label htmlFor="issue-expiry">Expiry (optional)</Label>
              <Input
                id="issue-expiry"
                type="datetime-local"
                value={issueForm.expires_at}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, expires_at: event.target.value }));
                  setIssueFormErrors((previous) => ({ ...previous, expires_at: undefined }));
                }}
                aria-invalid={Boolean(issueFormErrors.expires_at)}
              />
              {issueFormErrors.expires_at ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {issueFormErrors.expires_at}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-reason-code">Operator reason code (optional)</Label>
              <Input
                id="issue-reason-code"
                placeholder="ONBOARDING-NEW-TENANT"
                value={issueForm.operator_reason_code}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, operator_reason_code: event.target.value }));
                  setIssueFormErrors((previous) => ({ ...previous, operator_reason_code: undefined }));
                }}
                aria-invalid={Boolean(issueFormErrors.operator_reason_code)}
              />
              {issueFormErrors.operator_reason_code ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {issueFormErrors.operator_reason_code}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="issue-rationale">Operator rationale</Label>
              <Textarea
                id="issue-rationale"
                placeholder="Explain why this key is being issued for onboarding."
                value={issueForm.operator_rationale}
                onChange={(event) => {
                  setIssueForm((previous) => ({ ...previous, operator_rationale: event.target.value }));
                  setIssueFormErrors((previous) => ({ ...previous, operator_rationale: undefined }));
                }}
                aria-invalid={Boolean(issueFormErrors.operator_rationale)}
              />
              {issueFormErrors.operator_rationale ? (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {issueFormErrors.operator_rationale}
                </p>
              ) : null}
            </div>
            {!issueFormIsValid && issueDisabledReason ? (
              <p className="text-xs text-text-muted">{issueDisabledReason}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIssueOpen(false)} disabled={issuing}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={issuing || !selectedTenant || !issueFormIsValid}
              onClick={async () => {
                const errors = validateIssueForm(issueForm);
                setIssueFormErrors(errors);
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
                  setMutationSuccess(`Key ${created.id} was issued successfully.`);
                  setIssueOpen(false);
                  setSelectedLicenseId(created.id);
                  setDetailOpen(true);
                } catch (err) {
                  setMutationError(err instanceof Error ? err.message : "Issue key failed");
                } finally {
                  setIssuing(false);
                }
              }}
            >
              {issuing ? "Issuing…" : "Issue key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Entitlement key detail</DialogTitle>
            <DialogDescription>
              Review key metadata and run available lifecycle actions. Unsupported actions are disabled with explicit policy/API reasons.
            </DialogDescription>
          </DialogHeader>

          {!selectedLicense ? (
            <p className="text-sm text-text-secondary">Select a key row to view details.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>Key ID</Label>
                  <Input value={selectedLicense.id} readOnly className="font-mono text-xs" />
                </div>
                <div>
                  <Label>License key</Label>
                  <Input value={selectedLicense.license_key} readOnly className="font-mono text-xs" />
                </div>
                <div>
                  <Label>Tenant</Label>
                  <Input
                    value={selectedTenant ? `${selectedTenant.display_name} (${selectedTenant.id})` : selectedLicense.tenant_id}
                    readOnly
                  />
                </div>
                <div>
                  <Label>Issued at</Label>
                  <Input value={formatDateTime(selectedLicense.created_at)} readOnly />
                </div>
                <div>
                  <Label>Expiry</Label>
                  <Input value={formatDateTime(selectedLicense.expires_at)} readOnly />
                </div>
                <div>
                  <Label>Channel</Label>
                  <Input value={selectedLicense.update_channel ?? selectedTenant?.update_channel ?? "stable"} readOnly />
                </div>
                <div>
                  <Label>Slot limit</Label>
                  <Input value={String(selectedLicense.max_machines)} readOnly />
                </div>
                <div>
                  <Label>State</Label>
                  <Input value={selectedLicenseState ?? "unknown"} readOnly />
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-surface-border p-3">
                <p className="text-xs text-text-secondary">
                  Use copy/export actions below to hand off key material safely to customer onboarding contacts.
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
                        setMutationSuccess(`Activation key copied for ${selectedLicense.id}.`);
                      } catch (err) {
                        setMutationError(
                          err instanceof Error
                            ? err.message
                            : "Clipboard copy failed. Use the export packet action instead.",
                        );
                      } finally {
                        setClipboardBusy(false);
                      }
                    }}
                  >
                    {clipboardBusy ? "Copying…" : "Copy activation key"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!selectedLicense) return;
                      exportOnboardingPacket(selectedLicense);
                    }}
                  >
                    Export onboarding packet
                  </Button>
                </div>
              </div>

              <div className="space-y-2 rounded-md border border-surface-border p-3">
                <Label htmlFor="revoke-reason">Revoke reason</Label>
                <Input
                  id="revoke-reason"
                  placeholder="Optional reason for audit trail"
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
                  disabled={!canRevokeSelected || revoking}
                  onClick={async () => {
                    if (!selectedLicense) return;
                    setRevoking(true);
                    setMutationError(null);
                    setMutationSuccess(null);
                    try {
                      await revokeLicense(selectedLicense.id, revokeReason.trim() || "Revoked by operator");
                      await loadLicenses(selectedLicense.tenant_id, selectedLicense.id);
                      setMutationSuccess(`Key ${selectedLicense.id} was revoked.`);
                    } catch (err) {
                      setMutationError(err instanceof Error ? err.message : "Revoke key failed");
                    } finally {
                      setRevoking(false);
                    }
                  }}
                >
                  {revoking ? "Revoking…" : "Revoke key"}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  disabled
                  title={updateDisabledReason}
                >
                  Update key (unavailable)
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled
                  title={deleteDisabledReason}
                >
                  Delete key (unavailable)
                </Button>
              </div>
              <div className="space-y-1 text-xs text-text-muted">
                <p>{updateDisabledReason}</p>
                <p>{deleteDisabledReason}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

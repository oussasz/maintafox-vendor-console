import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/services/license-control-service", () => ({
  listTenants: vi.fn(),
  listEditions: vi.fn(),
  listTenantLicenses: vi.fn(),
  issueLicense: vi.fn(),
  revokeLicense: vi.fn(),
  updateLicense: vi.fn(),
}));

import {
  issueLicense,
  listEditions,
  listTenantLicenses,
  listTenants,
  revokeLicense,
} from "@/services/license-control-service";
import { EntitlementLifecyclePanel } from "../EntitlementLifecyclePanel";

const coreEdition = {
  id: "core",
  label: "Core",
  is_system: true,
  row_version: 1,
  capabilities: {
    equipment: true,
    requests: true,
    work_orders: true,
    inventory: true,
    personnel: true,
    organization: true,
    reference: true,
    planning: false,
    pm: false,
    permits: false,
    inspections: false,
    training: false,
    reports: false,
    rams: false,
    finance: false,
    sync: false,
    erp: false,
  },
};

const tenant = {
  id: "ten-acme",
  slug: "acme",
  display_name: "Acme Corp",
  update_channel: "stable" as const,
  rollout_cohort: "stable-main",
};

const activeLicense = {
  id: "lic-001",
  tenant_id: tenant.id,
  license_key: "MFX-KEY-001",
  max_machines: 5,
  update_channel: "stable",
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  created_at: "2026-04-10T12:00:00.000Z",
};

describe("EntitlementLifecyclePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTenants).mockResolvedValue([tenant]);
    vi.mocked(listEditions).mockResolvedValue([coreEdition]);
    vi.mocked(listTenantLicenses).mockResolvedValue([activeLicense]);
    vi.mocked(issueLicense).mockResolvedValue(activeLicense);
    vi.mocked(revokeLicense).mockResolvedValue();
  });

  it("renders key list and opens detail dialog on row click", async () => {
    render(<EntitlementLifecyclePanel />);

    await screen.findByText("MFX-KEY-001");
    await userEvent.click(screen.getByText("MFX-KEY-001"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("lic-001")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("active")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Revoke key" })).toBeEnabled();
  });

  it("issues a new key via add button and shows success", async () => {
    const createdLicense = {
      ...activeLicense,
      id: "lic-002",
      license_key: "MFX-KEY-002",
    };
    vi.mocked(issueLicense).mockResolvedValue(createdLicense);
    let listCalls = 0;
    vi.mocked(listTenantLicenses).mockImplementation(async () => {
      listCalls += 1;
      if (listCalls < 3) return [activeLicense];
      return [activeLicense, createdLicense];
    });

    render(<EntitlementLifecyclePanel />);
    await screen.findByText("MFX-KEY-001");

    await userEvent.click(screen.getAllByRole("button", { name: "Add/Issue key" })[0]!);

    const issueDialog = await screen.findByRole("dialog");
    const issueButton = within(issueDialog).getByRole("button", { name: "Issue key" });
    expect(issueButton).toBeDisabled();
    await userEvent.type(
      within(issueDialog).getByLabelText("Operator rationale"),
      "Initial onboarding key issuance for new tenant go-live.",
    );
    expect(issueButton).toBeEnabled();

    await userEvent.click(issueButton);

    await waitFor(() => {
      expect(issueLicense).toHaveBeenCalled();
    });
    const issueArgs = vi.mocked(issueLicense).mock.calls[0]?.[0];
    expect(issueArgs).toMatchObject({
      tenant_id: "ten-acme",
      max_machines: 1,
      update_channel: "stable",
      operator_reason_code: null,
      operator_rationale: "Initial onboarding key issuance for new tenant go-live.",
    });
    expect(typeof issueArgs?.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(issueArgs?.expires_at)))).toBe(false);
    expect(Date.parse(String(issueArgs?.expires_at))).toBeGreaterThan(Date.now() - 60_000);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Issue key" })).not.toBeInTheDocument();
    });
    const detailDialog = await screen.findByRole("dialog", { name: "Entitlement key detail" });
    expect(within(detailDialog).getByDisplayValue("lic-002")).toBeInTheDocument();
    expect(within(detailDialog).getByDisplayValue("MFX-KEY-002")).toBeInTheDocument();
  });

  it("shows load error with retry actions", async () => {
    vi.mocked(listTenantLicenses)
      .mockRejectedValueOnce(new Error("License list failed (500)"))
      .mockResolvedValueOnce([activeLicense]);

    render(<EntitlementLifecyclePanel />);

    await screen.findByText("License list failed (500)");
    const callsBeforeRetry = vi.mocked(listTenantLicenses).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Retry key load" }));

    await waitFor(() => {
      expect(vi.mocked(listTenantLicenses).mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    });
    expect(await screen.findByText("MFX-KEY-001")).toBeInTheDocument();
  });

  it("revoke action works and detail dialog points operators to list Actions", async () => {
    render(<EntitlementLifecyclePanel />);
    await screen.findByText("MFX-KEY-001");

    await userEvent.click(screen.getByText("MFX-KEY-001"));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText("Revoke reason"), "security incident");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => {
      expect(revokeLicense).toHaveBeenCalledWith("lic-001", "security incident");
    });

    expect(
      within(dialog).getByText(/Use the list Actions column to edit metadata or revoke from the grid/i),
    ).toBeInTheDocument();
  });

  it("handles newly provisioned tenant issue/list/revoke lifecycle", async () => {
    const newlyProvisionedTenant = {
      id: "ten-new",
      slug: "newco",
      display_name: "New Co",
      update_channel: "pilot" as const,
      rollout_cohort: "pilot-main",
    };
    const newlyIssued = {
      id: "lic-new-001",
      tenant_id: newlyProvisionedTenant.id,
      license_key: "MFX-NEW-001",
      max_machines: 12,
      update_channel: "pilot",
      expires_at: "2027-01-01T00:00:00.000Z",
      revoked_at: null,
      revoked_reason: null,
      created_at: "2026-04-17T10:00:00.000Z",
    };
    const revokedIssued = {
      ...newlyIssued,
      revoked_at: "2026-04-17T10:05:00.000Z",
      revoked_reason: "tenant onboarding correction",
    };

    vi.mocked(listTenants).mockResolvedValue([newlyProvisionedTenant]);
    let currentRows: Array<typeof newlyIssued | typeof revokedIssued> = [];
    vi.mocked(listTenantLicenses).mockImplementation(async () => currentRows);
    vi.mocked(issueLicense).mockResolvedValue(newlyIssued);
    vi.mocked(issueLicense).mockImplementation(async () => {
      currentRows = [newlyIssued];
      return newlyIssued;
    });
    vi.mocked(revokeLicense).mockImplementation(async () => {
      currentRows = [revokedIssued];
    });

    render(<EntitlementLifecyclePanel />);
    expect(await screen.findByText("No keys have been issued for this tenant.")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Add/Issue key" })[0]!);
    const issueDialog = await screen.findByRole("dialog");
    await userEvent.clear(within(issueDialog).getByLabelText("Slot limit"));
    await userEvent.type(within(issueDialog).getByLabelText("Slot limit"), "12");
    await userEvent.selectOptions(within(issueDialog).getByLabelText("Channel"), "pilot");
    const expiryInput = within(issueDialog).getByLabelText("Expiry (optional)");
    await userEvent.clear(expiryInput);
    await userEvent.type(expiryInput, "2027-01-01T00:00");
    await userEvent.type(
      within(issueDialog).getByLabelText("Operator reason code (optional)"),
      "ONBOARD-NEWCO",
    );
    await userEvent.type(
      within(issueDialog).getByLabelText("Operator rationale"),
      "Provisioned tenant requires initial activation keys for onboarding.",
    );
    await userEvent.click(within(issueDialog).getByRole("button", { name: "Issue key" }));

    await waitFor(() => {
      expect(issueLicense).toHaveBeenCalledTimes(1);
    });
    const calledWith = vi.mocked(issueLicense).mock.calls[0]?.[0];
    expect(calledWith).toMatchObject({
      tenant_id: "ten-new",
      max_machines: 12,
      update_channel: "pilot",
      operator_reason_code: "ONBOARD-NEWCO",
      operator_rationale: "Provisioned tenant requires initial activation keys for onboarding.",
    });
    expect(typeof calledWith?.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(calledWith?.expires_at)))).toBe(false);
    expect(await screen.findByText("Key lic-new-001 was issued successfully.")).toBeInTheDocument();

    const detailDialog = await screen.findByRole("dialog", { name: "Entitlement key detail" });
    expect(within(detailDialog).getByRole("button", { name: "Revoke key" })).toBeEnabled();
    await userEvent.type(
      within(detailDialog).getByLabelText("Revoke reason"),
      "tenant onboarding correction",
    );
    await userEvent.click(within(detailDialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => {
      expect(revokeLicense).toHaveBeenCalledWith("lic-new-001", "tenant onboarding correction");
    });
    expect(await screen.findByText("Key lic-new-001 was revoked.")).toBeInTheDocument();
  });
});

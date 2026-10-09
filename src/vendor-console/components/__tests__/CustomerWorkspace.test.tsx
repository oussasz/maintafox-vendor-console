import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Like i18next: a string 2nd arg is the default value; an options object is not rendered.
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
  }),
}));

vi.mock("@/services/customer-entitlement-machine-contracts", () => ({
  channelPolicyConsistent: vi.fn(() => true),
}));

vi.mock("@/services/license-control-service", () => ({
  listTenants: vi.fn(),
  listEditions: vi.fn(),
  createTenant: vi.fn(),
  updateTenant: vi.fn(),
  deleteTenant: vi.fn(),
  getTenantUpdatePolicy: vi.fn(),
  getCohortUpdatePolicy: vi.fn(),
  updateTenantUpdatePolicy: vi.fn(),
  rollbackTenantUpdatePolicy: vi.fn(),
  updateCohortUpdatePolicy: vi.fn(),
  rollbackCohortUpdatePolicy: vi.fn(),
  isDuplicateTenantSlugMessage: vi.fn(() => false),
  requestStepUpToken: vi.fn(async () => ({ token: "stepup-test-token", expiresAtMs: Date.now() + 300_000 })),
}));

import {
  createTenant,
  getCohortUpdatePolicy,
  getTenantUpdatePolicy,
  listEditions,
  listTenants,
  rollbackCohortUpdatePolicy,
  rollbackTenantUpdatePolicy,
  updateCohortUpdatePolicy,
  updateTenantUpdatePolicy,
} from "@/services/license-control-service";
import { CustomerWorkspace } from "../CustomerWorkspace";
import { renderWithConsole } from "./renderWithConsole";

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

const tenantOne = {
  id: "ten-acme",
  slug: "acme",
  display_name: "Acme Corp",
  rollout_cohort: "stable-main",
  update_channel: "stable" as const,
};

const tenantTwo = {
  id: "ten-beta",
  slug: "beta",
  display_name: "Beta Industries",
  rollout_cohort: "pilot-main",
  update_channel: "pilot" as const,
};

function mockPolicyReads() {
  vi.mocked(getTenantUpdatePolicy).mockResolvedValue({
    tenant_id: tenantOne.id,
    update_channel: "stable",
    rollout_cohort: "stable-main",
    force_min_app_version: null,
    force_update_mode: "inherit",
    force_update_reason: null,
  });
  vi.mocked(getCohortUpdatePolicy).mockResolvedValue({
    channel: "stable",
    cohort_label: "stable-main",
    force_min_app_version: null,
    force_update_mode: "off",
    force_update_reason: null,
  });
  vi.mocked(updateTenantUpdatePolicy).mockResolvedValue({
    tenant_id: tenantOne.id,
    update_channel: "stable",
    rollout_cohort: "stable-main",
    force_min_app_version: null,
    force_update_mode: "inherit",
    force_update_reason: null,
  });
  vi.mocked(rollbackTenantUpdatePolicy).mockResolvedValue({
    tenant_id: tenantOne.id,
    update_channel: "stable",
    rollout_cohort: "stable-main",
    force_min_app_version: null,
    force_update_mode: "inherit",
    force_update_reason: null,
  });
  vi.mocked(updateCohortUpdatePolicy).mockResolvedValue({
    channel: "stable",
    cohort_label: "stable-main",
    force_min_app_version: null,
    force_update_mode: "off",
    force_update_reason: null,
  });
  vi.mocked(rollbackCohortUpdatePolicy).mockResolvedValue({
    channel: "stable",
    cohort_label: "stable-main",
    force_min_app_version: null,
    force_update_mode: "off",
    force_update_reason: null,
  });
}

describe("CustomerWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicyReads();
    vi.mocked(listEditions).mockResolvedValue([coreEdition]);
  });

  it("renders API-backed list and allows row selection", async () => {
    vi.mocked(listTenants).mockResolvedValue([tenantOne, tenantTwo]);

    renderWithConsole(<CustomerWorkspace />);

    await screen.findByText("Acme Corp");
    const acmeRow = screen.getByText("acme").closest("tr");
    const betaRow = screen.getByText("beta").closest("tr");
    expect(acmeRow).toHaveAttribute("aria-selected", "true");
    expect(betaRow).toHaveAttribute("aria-selected", "false");

    await userEvent.click(screen.getByText("beta"));
    expect(betaRow).toHaveAttribute("aria-selected", "true");
  });

  it("shows load error state with retry action", async () => {
    vi.mocked(listTenants)
      .mockRejectedValueOnce(new Error("Tenant fetch failed (500)"))
      .mockResolvedValueOnce([]);

    renderWithConsole(<CustomerWorkspace />);

    await screen.findByText("Tenant fetch failed (500)");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(listTenants).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("No customers found.")).toBeInTheDocument();
  });

  it("creates a customer and shows it immediately in the list", async () => {
    vi.mocked(listTenants).mockResolvedValueOnce([tenantOne]).mockResolvedValueOnce([tenantOne, tenantTwo]);
    vi.mocked(createTenant).mockResolvedValue(tenantTwo);

    renderWithConsole(<CustomerWorkspace />);
    await screen.findByText("Acme Corp");

    await userEvent.click(screen.getByRole("button", { name: "Add customer/company" }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Company name"), "Beta Industries");
    await userEvent.type(within(dialog).getByLabelText("Tenant slug"), "beta");

    await userEvent.click(within(dialog).getByRole("button", { name: "Add customer/company" }));

    await waitFor(() => {
      expect(createTenant).toHaveBeenCalledWith({
        slug: "beta",
        display_name: "Beta Industries",
        rollout_cohort: "stable-main",
        update_channel: "stable",
        edition: "core",
      });
    });
    expect(await screen.findByText('Customer "Beta Industries" was added successfully.')).toBeInTheDocument();
    expect(await screen.findByText("Beta Industries")).toBeInTheDocument();

    const betaRow = screen.getByText("beta").closest("tr");
    expect(betaRow).toHaveAttribute("aria-selected", "true");
  });

  it("keeps add action disabled until form is valid and while creating", async () => {
    const created = {
      id: "ten-gamma",
      slug: "gamma-company",
      display_name: "Gamma Company",
      rollout_cohort: "stable-main",
      update_channel: "stable" as const,
    };

    let resolveCreate: (value: typeof created) => void = () => {};
    const createPromise = new Promise<typeof created>((resolve) => {
      resolveCreate = resolve;
    });

    vi.mocked(listTenants).mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    vi.mocked(createTenant).mockReturnValue(createPromise);

    renderWithConsole(<CustomerWorkspace />);
    await screen.findByText("No customers found.");

    await userEvent.click(screen.getByRole("button", { name: "Add customer/company" }));
    const dialog = await screen.findByRole("dialog");
    const submitButton = within(dialog).getByRole("button", { name: "Add customer/company" });

    expect(submitButton).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText("Company name"), "Gamma Company");
    await userEvent.type(within(dialog).getByLabelText("Tenant slug"), "gamma-company");
    expect(submitButton).toBeEnabled();

    await userEvent.click(submitButton);
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();

    resolveCreate(created);
    await screen.findByText("Gamma Company");
  });
});

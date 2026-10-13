import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/console-dashboard-service", () => ({ getConsoleOverview: vi.fn() }));
vi.mock("@/services/license-control-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/license-control-service")>()),
  listTenants: vi.fn(),
  listTenantActivations: vi.fn(),
  suspendTenant: vi.fn(),
  resumeTenant: vi.fn(),
}));
vi.mock("@/services/vendor-audit-support-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-audit-support-service")>()),
  listAuditLedger: vi.fn(async () => []),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ can: () => true, canAny: () => true }) }));

import { getConsoleOverview, type ConsoleOverview } from "@/services/console-dashboard-service";
import { listTenantActivations, listTenants, suspendTenant, type ControlTenant } from "@/services/license-control-service";
import { listAuditLedger } from "@/services/vendor-audit-support-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { CustomerPage } from "../CustomerPage";

const tenant = { id: "tenant_1", slug: "acme", display_name: "Acme Industries", edition: "professional", update_channel: "stable", rollout_cohort: "stable-main", suspended_at: null } as unknown as ControlTenant;
const overview = {
  customers: [
    {
      tenant_id: "tenant_1",
      slug: "acme",
      name: "Acme Industries",
      edition: "professional",
      edition_label: "Professional",
      devices_used: 3,
      seats: 5,
      licence_until: new Date(Date.now() + 12 * 86_400_000).toISOString(),
      licence_never_ends: false,
      licence_ended_at: null,
      status: "expires_soon",
      customer_since: "2026-01-15T00:00:00Z",
    },
  ],
} as unknown as ConsoleOverview;

const renderAt = (path: string) =>
  renderWithConsole(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vendor-console/customers/:tenantId" element={<CustomerPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("CustomerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTenants).mockResolvedValue([tenant]);
    vi.mocked(getConsoleOverview).mockResolvedValue(overview);
    vi.mocked(listTenantActivations).mockResolvedValue([]);
  });

  it("shows who the customer is, where they stand, and the action that matters", async () => {
    renderAt("/vendor-console/customers/tenant_1");
    expect(await screen.findByRole("heading", { level: 1, name: "Acme Industries" })).toBeInTheDocument();
    expect(screen.getAllByText("Expires soon").length).toBeGreaterThan(0);
    expect(screen.getByText("Professional edition")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Renew licence" })).toBeInTheDocument();
    expect(screen.getByText("3 of 5 seats used")).toBeInTheDocument();
    expect(screen.getByText("12 days left")).toBeInTheDocument();
    // The device list loads on its own, after the customer.
    expect(await screen.findByText("No device activated yet")).toBeInTheDocument();
  });

  it("suspending asks for a reason and an authenticator code, then calls the API", async () => {
    renderAt("/vendor-console/customers/tenant_1");
    const sensitive = (await screen.findByRole("heading", { name: "Sensitive actions" })).closest("section") as HTMLElement;
    await userEvent.click(within(sensitive).getByRole("button", { name: "Suspend customer" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "unpaid invoice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Suspend" }));
    await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(suspendTenant).toHaveBeenCalledWith("tenant_1", { reason_code: "unpaid invoice", step_up_token: "stepup-entitlement_suspension" }),
    );
  });

  it("the History tab shows the audit log of this customer only", async () => {
    renderAt("/vendor-console/customers/tenant_1?tab=history");
    await waitFor(() => expect(listAuditLedger).toHaveBeenCalledWith(expect.objectContaining({ q: "tenant_1" })));
    expect(screen.getByRole("tab", { name: "History", selected: true })).toBeInTheDocument();
  });

  it("a customer that does not exist says so, with a way back", async () => {
    renderAt("/vendor-console/customers/tenant_gone");
    expect(await screen.findByText("This customer does not exist (any more)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All customers" })).toHaveAttribute("href", "/vendor-console/customers");
  });
});

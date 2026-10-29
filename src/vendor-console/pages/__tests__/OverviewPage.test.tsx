import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/console-dashboard-service", () => ({ getConsoleOverview: vi.fn() }));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  getSessionInfo: vi.fn(async () => ({ user: { id: 1, email: "amina@maintafox.systems", display_name: "Amina" } })),
}));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ can: () => true, canAny: () => true }) }));

import { ApiRequestError } from "@/lib/api-error";
import { getConsoleOverview, type ConsoleOverview } from "@/services/console-dashboard-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { OverviewPage } from "../OverviewPage";

const overview: ConsoleOverview = {
  generated_at: "2026-10-13T08:00:00Z",
  thresholds: { licence_expiring_days: 30, device_not_syncing_hours: 24 },
  figures: { customers_total: 3, customers_active: 2, devices_in_use: 4, seats_total: 15, seats_free: 11, licences_expiring: 1, open_tickets: 2 },
  attention: [
    { kind: "licence_expiring", severity: "warn", tenant_id: "tenant_1", tenant_name: "Acme", facts: { licence_id: "lic_1", expires_at: "2026-10-25T00:00:00Z", days_left: 12, edition: "Professional", devices: 3 } },
    { kind: "device_not_syncing", severity: "warn", tenant_id: "tenant_1", tenant_name: "Acme", facts: { machine_id: "fp-2", device_label: "Atelier-02", last_sync_at: "2026-10-10T08:00:00Z", days: 3 } },
    { kind: "ticket_new_with_file", severity: "info", tenant_id: "tenant_2", tenant_name: "Beta", facts: { ticket_id: "sup_9", summary: "Le PDF ne sort pas", created_at: "2026-10-13T07:00:00Z" } },
    { kind: "something_new", severity: "warn", tenant_id: null, tenant_name: null, facts: {} },
  ],
  health: {
    status: "ok",
    last_backup_at: "2026-10-13T02:30:00Z",
    last_backup_status: "succeeded",
    backup_encrypted: true,
    last_restore_test_at: "2026-10-01T03:00:00Z",
    last_restore_test_status: "succeeded",
    devices_total: 4,
    devices_syncing: 3,
  },
  customers: [
    { tenant_id: "tenant_1", slug: "acme", name: "Acme", edition: "professional", edition_label: "Professional", devices_used: 3, seats: 5, licence_until: "2026-10-25T00:00:00Z", licence_never_ends: false, licence_ended_at: null, status: "expires_soon", customer_since: "2026-01-01T00:00:00Z" },
    { tenant_id: "tenant_2", slug: "beta", name: "Beta", edition: "core", edition_label: "Core", devices_used: 1, seats: 10, licence_until: null, licence_never_ends: true, licence_ended_at: null, status: "active", customer_since: "2026-02-01T00:00:00Z" },
  ],
};

const renderPage = () =>
  renderWithConsole(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );

describe("OverviewPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("greets the operator and shows the four key figures from the server", async () => {
    vi.mocked(getConsoleOverview).mockResolvedValue(overview);
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: /Amina/ })).toBeInTheDocument();
    const figures = screen.getByRole("region", { name: "Key figures" });
    expect(within(figures).getByText("of 3 in total")).toBeInTheDocument();
    expect(within(figures).getByText("11 seats still free")).toBeInTheDocument();
    expect(within(figures).getByRole("link", { name: "Review renewals" })).toHaveAttribute("href", "/vendor-console/customers?status=expires_soon");
  });

  it("lists what needs attention in plain words, each with one action", async () => {
    vi.mocked(getConsoleOverview).mockResolvedValue(overview);
    renderPage();
    expect(await screen.findByText("Acme: licence expires in 12 days")).toBeInTheDocument();
    expect(screen.getByText("Professional edition · 3 device(s)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Renew" })).toHaveAttribute("href", "/vendor-console/customers/tenant_1?tab=licence");
    expect(screen.getByText("A device has not synced for 3 days")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View device" })).toHaveAttribute("href", "/vendor-console/customers/tenant_1?tab=sync&device=fp-2");
    expect(screen.getByText("New support ticket with a diagnostic file")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open ticket" })).toHaveAttribute("href", "/vendor-console/support?ticket=sup_9");
    // A kind this console does not know yet still reads as a sentence.
    expect(screen.getByText("Something needs a look")).toBeInTheDocument();
  });

  it("sums up health and lists customers with their standing", async () => {
    vi.mocked(getConsoleOverview).mockResolvedValue(overview);
    renderPage();
    expect(await screen.findByText("All systems working")).toBeInTheDocument();
    expect(screen.getByText("3 of 4")).toBeInTheDocument();
    const acme = screen.getByRole("link", { name: "Open Acme" }).closest("tr") as HTMLElement;
    expect(within(acme).getByText("Expires soon")).toBeInTheDocument();
    expect(within(acme).getByText("3 / 5")).toBeInTheDocument();
    const beta = screen.getByRole("link", { name: "Open Beta" }).closest("tr") as HTMLElement;
    expect(within(beta).getByText("No end date")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "acm");
    expect(screen.queryByRole("link", { name: "Open Beta" })).not.toBeInTheDocument();
  });

  it("explains a refusal in a sentence and retries", async () => {
    vi.mocked(getConsoleOverview).mockRejectedValueOnce(new ApiRequestError(500, "internal_error", null)).mockResolvedValueOnce(overview);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server failed to process the request (HTTP 500).");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Acme: licence expires in 12 days")).toBeInTheDocument();
  });

  it("an empty platform says what to do", async () => {
    vi.mocked(getConsoleOverview).mockResolvedValue({
      ...overview,
      figures: { customers_total: 0, customers_active: 0, devices_in_use: 0, seats_total: 0, seats_free: 0, licences_expiring: 0, open_tickets: 0 },
      attention: [],
      customers: [],
    });
    renderPage();
    expect(await screen.findByText("Nothing needs you right now")).toBeInTheDocument();
    expect(screen.getByText("No customers yet")).toBeInTheDocument();
  });
});

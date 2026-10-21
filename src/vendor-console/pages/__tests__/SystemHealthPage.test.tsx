import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/console-dashboard-service", () => ({ getConsoleHealth: vi.fn() }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ can: () => true, canAny: () => true }) }));

import { getConsoleHealth, type ConsoleHealth } from "@/services/console-dashboard-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { SystemHealthPage } from "../SystemHealthPage";

const health: ConsoleHealth = {
  checked_at: new Date().toISOString(),
  status: "attention",
  server: { online: true, database: { state: "ok", latency_ms: 2.1 }, file_storage: "ok", disk_free_bytes: 50 * 1024 ** 3, disk_total_bytes: 100 * 1024 ** 3 },
  backups: {
    last_backup_at: "2026-10-13T02:30:00Z",
    last_backup_status: "succeeded",
    last_backup_attempt_at: "2026-10-13T02:30:00Z",
    encrypted: true,
    backup_late: false,
    last_restore_test_at: "2026-10-01T03:00:00Z",
    last_restore_test_status: "succeeded",
    restore_test_overdue: false,
    offsite: "disabled",
    retention_days: 14,
  },
  sync: { devices_total: 4, devices_up_to_date: 3, first_device_behind: { tenant_id: "tenant_1", machine_id: "fp-2" }, window_hours: 24, refused_not_applied: 2, conflicts: 0 },
  updates: { devices_total: 4, versions: [{ version: "1.0.0", devices: 3 }, { version: null, devices: 1 }] },
};

const renderPage = () =>
  renderWithConsole(
    <MemoryRouter>
      <SystemHealthPage />
    </MemoryRouter>,
  );

describe("SystemHealthPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sums up in one sentence, then server, backups, sync and versions in plain words", async () => {
    vi.mocked(getConsoleHealth).mockResolvedValue(health);
    renderPage();
    expect(await screen.findByText("Something needs a look")).toBeInTheDocument();
    const server = screen.getByRole("heading", { name: "Server" }).closest("section") as HTMLElement;
    expect(within(server).getByText("Online")).toBeInTheDocument();
    expect(within(server).getByText("50 GB of 100 GB")).toBeInTheDocument();
    const backups = screen.getByRole("heading", { name: "Backups" }).closest("section") as HTMLElement;
    expect(within(backups).getByText("Protected")).toBeInTheDocument();
    expect(within(backups).getByText("14 days")).toBeInTheDocument();
    expect(within(backups).getByText(/All copies are on this server only/)).toBeInTheDocument();
    const sync = screen.getByRole("heading", { name: "Data sync" }).closest("section") as HTMLElement;
    expect(within(sync).getByText("1 device to check")).toBeInTheDocument();
    expect(within(sync).getByRole("link", { name: "See the device that is behind" })).toHaveAttribute(
      "href",
      "/vendor-console/customers/tenant_1?tab=sync&device=fp-2",
    );
    const updates = screen.getByRole("heading", { name: "App updates" }).closest("section") as HTMLElement;
    expect(within(updates).getByText("Version 1.0.0")).toBeInTheDocument();
    expect(within(updates).getByText("Version not reported")).toBeInTheDocument();
  });

  it("a backup that never ran is orange, not green", async () => {
    vi.mocked(getConsoleHealth).mockResolvedValue({
      ...health,
      backups: { ...health.backups, last_backup_at: null, last_backup_status: null, encrypted: null, backup_late: true, last_restore_test_at: null, last_restore_test_status: null, restore_test_overdue: true },
    });
    renderPage();
    const backups = (await screen.findByRole("heading", { name: "Backups" })).closest("section") as HTMLElement;
    expect(within(backups).getByText("Look soon")).toBeInTheDocument();
    expect(within(backups).getAllByText("Never")).toHaveLength(2);
  });

  it("explains an unreachable server and retries", async () => {
    vi.mocked(getConsoleHealth).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(health);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("The control API cannot be reached. Check the connection and try again.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Something needs a look")).toBeInTheDocument();
  });
});

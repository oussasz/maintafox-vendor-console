import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/vendor-ops-telemetry-service", () => ({ getPlatformOverview: vi.fn() }));
const granted = new Set<string>();
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: (permission: string) => granted.has(permission) }),
}));

import { getPlatformOverview, type PlatformOverviewV1 } from "@/services/vendor-ops-telemetry-service";
import { PlatformHealthOpsPanel } from "../PlatformHealthOpsPanel";
import { renderWithConsole } from "./renderWithConsole";

const overview: PlatformOverviewV1 = {
  platform_services: [
    { service: "postgresql", severity: "info", detail: "primary reachable, 12 ms" },
    { service: "object_storage", severity: "critical", detail: "bucket unreachable" },
  ],
  infra_pressure: [{ metric_code: "database_size_mib", value: 512, unit: "MiB", threshold_hint: "warn at 8 GiB", trend: "flat" }],
  alerts: [
    {
      alert_id: "al-1",
      title: "Object storage unreachable",
      severity: "critical",
      state: "open",
      owner_actor_id: null,
      acknowledged_at_rfc3339: null,
      notes: [],
      drill_refs: {},
    },
  ],
};

const renderPanel = () =>
  renderWithConsole(
    <MemoryRouter>
      <PlatformHealthOpsPanel />
    </MemoryRouter>,
  );

describe("PlatformHealthOpsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted.clear();
  });

  it("names each service in the operator's language with the server's status and detail", async () => {
    vi.mocked(getPlatformOverview).mockResolvedValue(overview);
    renderPanel();
    expect(await screen.findByText("Object storage")).toBeInTheDocument();
    expect(screen.getByText("bucket unreachable")).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByText("database_size_mib")).toBeInTheDocument();
    expect(screen.getByText("512 MiB")).toBeInTheDocument();
    expect(screen.getByText("Object storage unreachable")).toBeInTheDocument();
  });

  it("links only to the views the operator's role may open", async () => {
    granted.add("sync.operate");
    vi.mocked(getPlatformOverview).mockResolvedValue(overview);
    renderPanel();
    expect(await screen.findByRole("link", { name: "Open sync health" })).toHaveAttribute("href", "/vendor-console/sync");
    expect(screen.queryByRole("link", { name: "Open rollouts" })).not.toBeInTheDocument();
  });

  it("explains an unreachable API and loads again on retry", async () => {
    vi.mocked(getPlatformOverview)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ platform_services: [], infra_pressure: [], alerts: [] });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("The control API cannot be reached.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No platform service telemetry available.")).toBeInTheDocument();
    expect(screen.getByText("No infrastructure pressure metrics available.")).toBeInTheDocument();
  });
});

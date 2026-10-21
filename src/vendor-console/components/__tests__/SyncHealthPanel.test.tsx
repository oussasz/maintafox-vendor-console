import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/vendor-ops-telemetry-service", () => ({ getSyncOverview: vi.fn() }));
// The per-device timeline has its own test (SyncDeviceTimeline.test.tsx).
vi.mock("../SyncDeviceTimeline", () => ({ SyncDeviceTimeline: () => null }));

import { ApiRequestError } from "@/lib/api-error";
import { getSyncOverview, type SyncOverviewV1 } from "@/services/vendor-ops-telemetry-service";
import { SyncHealthPanel } from "../SyncHealthPanel";
import { renderWithConsole } from "./renderWithConsole";

const overview: SyncOverviewV1 = {
  aggregate: {
    max_lag_seconds: 42,
    checkpoint_p95_age_seconds: 90,
    aggregate_retry_pressure: 7,
    dead_letter_total: 3,
    worst_severity: "warn",
  },
  tenant_rows: [
    {
      tenant_id: "tenant-acme",
      lag_seconds: 42,
      checkpoint_age_seconds: 90,
      rejection_rate_bps: 15,
      retry_pressure: 7,
      dead_letter_count: 3,
      severity: "warn",
    },
  ],
  repair_queue: [
    {
      item_id: "rq-1",
      tenant_id: "tenant-acme",
      queue_kind: "rejected_items",
      severity: "warn",
      summary: "3 items refused: unknown_entity_type",
      recommended_action: "replay",
    },
  ],
  heartbeat_anomalies: [
    { tenant_id: "tenant-acme", machine_id: "fp-1", anomaly_code: "heartbeat_gap", detected_at_rfc3339: "2026-10-12T10:00:00Z" },
  ],
  drill_by_tenant: {
    "tenant-acme": [
      {
        batch_id: "batch-77",
        entity_type: "work_orders",
        failure_reason_code: "unknown_entity_type",
        idempotency_key: "idem-1",
        last_attempt_rfc3339: "2026-10-12T09:59:00Z",
        attempt_count: 2,
      },
    ],
  },
};

const renderPanel = () =>
  renderWithConsole(
    <MemoryRouter>
      <SyncHealthPanel />
    </MemoryRouter>,
  );

describe("SyncHealthPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the server's measured figures, per-tenant rows, repair queue and anomalies", async () => {
    vi.mocked(getSyncOverview).mockResolvedValue(overview);
    renderPanel();
    expect(await screen.findAllByText("tenant-acme", { selector: "td" })).not.toHaveLength(0);
    expect(screen.getAllByText("42s").length).toBeGreaterThan(0);
    expect(screen.getByText("3 items refused: unknown_entity_type")).toBeInTheDocument();
    expect(screen.getByText("heartbeat_gap")).toBeInTheDocument();
    // No client-side "allowed actions": refused items are replayed from the device.
    expect(screen.queryByRole("button", { name: /replay/i })).not.toBeInTheDocument();
  });

  it("drills into a tenant's failed batches", async () => {
    vi.mocked(getSyncOverview).mockResolvedValue(overview);
    renderPanel();
    await screen.findAllByText("tenant-acme", { selector: "td" });
    await userEvent.click(screen.getByRole("button", { name: "Open drill-down" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("batch-77")).toBeInTheDocument();
    expect(within(sheet).getByText(/work_orders · unknown_entity_type/)).toBeInTheDocument();
  });

  it("explains a refusal and loads again on retry", async () => {
    vi.mocked(getSyncOverview)
      .mockRejectedValueOnce(new ApiRequestError(403, "permission_denied", null))
      .mockResolvedValueOnce({ ...overview, tenant_rows: [], repair_queue: [], heartbeat_anomalies: [], drill_by_tenant: {} });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this action.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No tenant sync telemetry available yet.")).toBeInTheDocument();
    expect(getSyncOverview).toHaveBeenCalledTimes(2);
  });
});

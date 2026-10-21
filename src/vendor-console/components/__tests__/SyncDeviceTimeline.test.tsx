import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  listTenants: vi.fn(async () => [{ id: "tenant_1", slug: "acme", display_name: "Acme" }]),
  listTenantActivations: vi.fn(async () => [
    {
      machine_id: "fp-device-1",
      tenant_id: "tenant_1",
      last_heartbeat_rfc3339: null,
      trusted_device: true,
      activation_source: "license_claim",
      anomaly_flags: [],
      heartbeat_freshness: "live",
    },
  ]),
}));

vi.mock("@/services/vendor-ops-telemetry-service", () => ({
  getDeviceTimeline: vi.fn(),
  requestDeviceResync: vi.fn(),
}));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import { requestStepUp } from "@/services/vendor-auth-service";
import { getDeviceTimeline, requestDeviceResync, type DeviceTimeline } from "@/services/vendor-ops-telemetry-service";
import { SyncDeviceTimeline } from "../SyncDeviceTimeline";
import { renderWithConsole } from "./renderWithConsole";

function timeline(openResync = false): DeviceTimeline {
  return {
    tenant_id: "tenant_1",
    machine_id: "fp-device-1",
    hours: 72,
    device: {
      app_version: "1.0.0",
      activated_at: "2026-10-01T00:00:00Z",
      last_seen_at: "2026-10-12T10:00:00Z",
      revoked_at: null,
      revocation_kind: null,
    },
    measured: { protocol: "v2", online: true, last_exchange_rfc3339: "2026-10-12T10:00:00Z", lag_seconds: 4, checkpoint_age_seconds: 30 },
    open_resync: openResync ? { requested_at: "2026-10-12T11:00:00Z", requested_by: "user_1", reason: "diverged" } : null,
    events: [
      { at: "2026-10-12T10:00:00Z", kind: "rejection", detail: { entity_sync_id: "eq-x", code: "unknown_entity_type" } },
      { at: "2026-10-12T09:00:00Z", kind: "exchange", detail: { server_batch_id: "b1", retries: 1 } },
    ],
  };
}

describe("SyncDeviceTimeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the measured figures and the recorded events, newest first", async () => {
    vi.mocked(getDeviceTimeline).mockResolvedValue(timeline());
    renderWithConsole(<SyncDeviceTimeline />);
    const list = await screen.findByTestId("timeline-events");
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("sync.timeline.kind.rejection");
    expect(items[0]).toHaveTextContent("entity_sync_id=eq-x");
    expect(items[1]).toHaveTextContent("retries=1");
    expect(screen.getByText(/4 s/)).toBeInTheDocument();
    expect(getDeviceTimeline).toHaveBeenCalledWith("tenant_1", "fp-device-1", 72);
  });

  it("full resynchronisation asks for a reason and a sync_repair code", async () => {
    vi.mocked(getDeviceTimeline).mockResolvedValueOnce(timeline()).mockResolvedValueOnce(timeline(true));
    renderWithConsole(<SyncDeviceTimeline />);
    await screen.findByTestId("timeline-events");
    await userEvent.click(screen.getByRole("button", { name: "sync.timeline.resync" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "diverged copy");
    await userEvent.click(within(dialog).getByRole("button", { name: "sync.timeline.resyncConfirm" }));
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    await waitFor(() =>
      expect(requestDeviceResync).toHaveBeenCalledWith("tenant_1", "fp-device-1", {
        reason_code: "diverged copy",
        step_up_token: "stepup-sync_repair",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("sync_repair", "123456");
    expect(await screen.findByText("sync.timeline.resyncOpen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sync.timeline.resync" })).toBeDisabled();
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
  }),
}));

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  listTenants: vi.fn(),
  listTenantActivations: vi.fn(),
  getTenantOfflinePolicy: vi.fn(),
  updateTenantOfflinePolicy: vi.fn(),
  claimActivation: vi.fn(),
  revokeMachine: vi.fn(),
  reinstateMachine: vi.fn(),
  releaseMachineSlot: vi.fn(),
  rebindMachine: vi.fn(),
  requestMachinePolicyRefresh: vi.fn(),
}));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import {
  getTenantOfflinePolicy,
  listTenantActivations,
  listTenants,
  rebindMachine,
  releaseMachineSlot,
  requestMachinePolicyRefresh,
  type ActivationRow,
} from "@/services/license-control-service";
import { requestStepUp } from "@/services/vendor-auth-service";
import { MachineActivationPanel } from "../MachineActivationPanel";
import { renderWithConsole } from "./renderWithConsole";

const active: ActivationRow = {
  machine_id: "fp-active-0001",
  tenant_id: "tenant_1",
  last_heartbeat_rfc3339: "2026-10-12T10:00:00Z",
  app_version: "1.0.0",
  trusted_device: true,
  revocation_kind: null,
  policy_refresh_requested_at: null,
  activation_source: "license_claim",
  anomaly_flags: [],
  heartbeat_freshness: "live",
};
const released: ActivationRow = {
  ...active,
  machine_id: "fp-released-0002",
  trusted_device: false,
  revocation_kind: "released",
  anomaly_flags: ["revoked"],
};

async function rowOf(fingerprint: string) {
  return (await screen.findByText(fingerprint)).closest("tr") as HTMLElement;
}

async function confirmWithReason(reason: string, confirm: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), reason);
  await userEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

describe("MachineActivationPanel actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTenants).mockResolvedValue([{ id: "tenant_1", slug: "acme", display_name: "Acme" }]);
    vi.mocked(listTenantActivations).mockResolvedValue([active, released]);
    vi.mocked(getTenantOfflinePolicy).mockResolvedValue({
      tenant_id: "tenant_1",
      grace_hours: 72,
      trust_revocation_disconnects_immediately: true,
      reconnect_requires_fresh_heartbeat: true,
    });
  });

  it("slot release asks for a reason and a machine_trust_change code, then calls the API", async () => {
    renderWithConsole(<MachineActivationPanel />);
    const row = await rowOf(active.machine_id);
    await userEvent.click(within(row).getByRole("button", { name: "machines.action.slotRelease" }));
    await confirmWithReason("machine scrapped", "machines.dialog.release.confirm");
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    await waitFor(() =>
      expect(releaseMachineSlot).toHaveBeenCalledWith("tenant_1", active.machine_id, {
        reason_code: "machine scrapped",
        step_up_token: "stepup-machine_trust_change",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("machine_trust_change", "123456");
    expect(await screen.findByText("machines.released")).toBeInTheDocument();
  });

  it("rebind needs the replacement fingerprint before it can be confirmed", async () => {
    renderWithConsole(<MachineActivationPanel />);
    const row = await rowOf(active.machine_id);
    await userEvent.click(within(row).getByRole("button", { name: "machines.action.rebind" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "laptop replaced");
    const confirm = within(dialog).getByRole("button", { name: "machines.dialog.rebind.confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("machines.dialog.rebind.targetLabel"), "fp-new-laptop-99");
    await userEvent.click(confirm);
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "654321");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    await waitFor(() =>
      expect(rebindMachine).toHaveBeenCalledWith("tenant_1", active.machine_id, "fp-new-laptop-99", {
        reason_code: "laptop replaced",
        step_up_token: "stepup-machine_trust_change",
      }),
    );
  });

  it("policy refresh is audited with a reason and needs no step-up", async () => {
    renderWithConsole(<MachineActivationPanel />);
    const row = await rowOf(active.machine_id);
    await userEvent.click(within(row).getByRole("button", { name: "machines.action.policyRefresh" }));
    await confirmWithReason("edition changed", "machines.dialog.refresh.confirm");
    await waitFor(() => expect(requestMachinePolicyRefresh).toHaveBeenCalledWith("tenant_1", active.machine_id, "edition changed"));
    expect(requestStepUp).not.toHaveBeenCalled();
  });

  it("a released slot shows its state and offers no slot actions", async () => {
    renderWithConsole(<MachineActivationPanel />);
    const row = await rowOf(released.machine_id);
    expect(within(row).getByText("machines.slotReleased")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "machines.action.slotRelease" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "machines.action.policyRefresh" })).not.toBeInTheDocument();
  });

  it("a server refusal stays in the dialog", async () => {
    vi.mocked(requestMachinePolicyRefresh).mockRejectedValueOnce(new Error("slot not held (409)"));
    renderWithConsole(<MachineActivationPanel />);
    const row = await rowOf(active.machine_id);
    await userEvent.click(within(row).getByRole("button", { name: "machines.action.policyRefresh" }));
    await confirmWithReason("edition changed", "machines.dialog.refresh.confirm");
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("slot not held (409)");
  });
});

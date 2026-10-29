import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/license-control-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/license-control-service")>()),
  listTenants: vi.fn(),
  getTenantUpdatePolicy: vi.fn(),
  getCohortUpdatePolicy: vi.fn(),
  clearTenantMinAppVersion: vi.fn(),
  clearCohortMinAppVersion: vi.fn(),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import {
  clearCohortMinAppVersion,
  clearTenantMinAppVersion,
  getCohortUpdatePolicy,
  getTenantUpdatePolicy,
  listTenants,
  type ControlTenant,
} from "@/services/license-control-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { ForceUpdatePanel } from "../ForceUpdatePanel";

const tenant = { id: "tenant_1", slug: "acme", display_name: "Acme Industries", update_channel: "pilot", rollout_cohort: "pilot-east" } as unknown as ControlTenant;

type TenantMode = "off" | "required" | "emergency" | "inherit";
type CohortMode = "off" | "required" | "emergency";

function tenantPolicy(floor: string | null, mode: TenantMode) {
  return { tenant_id: "tenant_1", update_channel: "pilot" as const, rollout_cohort: "pilot-east", force_min_app_version: floor, force_update_mode: mode, force_update_reason: null };
}
function cohortPolicy(floor: string | null, mode: CohortMode) {
  return { channel: "pilot" as const, cohort_label: "pilot-east", force_min_app_version: floor, force_update_mode: mode, force_update_reason: null };
}

function setup(tenantFloor: string | null, tenantMode: TenantMode, cohortFloor: string | null, cohortMode: CohortMode) {
  vi.mocked(listTenants).mockResolvedValue([tenant]);
  vi.mocked(getTenantUpdatePolicy).mockResolvedValue(tenantPolicy(tenantFloor, tenantMode));
  vi.mocked(getCohortUpdatePolicy).mockResolvedValue(cohortPolicy(cohortFloor, cohortMode));
  renderWithConsole(<ForceUpdatePanel />);
}

/** The editor box of the customer ("Tenant override") or of the rollout group ("Cohort baseline"). */
async function editor(heading: RegExp): Promise<HTMLElement> {
  return (await screen.findByText(heading)).parentElement as HTMLElement;
}

describe("ForceUpdatePanel: remove minimum version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers the action only where a minimum version is stored", async () => {
    setup(null, "inherit", "1.8.0", "off");
    const cohortBox = await editor(/^Cohort baseline/);
    await waitFor(() => expect(within(cohortBox).getByRole("button", { name: "Remove minimum version" })).toBeInTheDocument());
    const tenantBox = await editor(/^Tenant override/);
    expect(within(tenantBox).queryByRole("button", { name: "Remove minimum version" })).not.toBeInTheDocument();
    // Typing a version is not storing one: the tenant still has nothing to remove.
    await userEvent.type(within(tenantBox).getByLabelText("Minimum app version"), "2.0.0");
    expect(within(tenantBox).queryByRole("button", { name: "Remove minimum version" })).not.toBeInTheDocument();
  });

  it("customer under emergency: the dialog names the floor and the customer, says the block stays, then removes with reason and step-up", async () => {
    vi.mocked(clearTenantMinAppVersion).mockResolvedValue(tenantPolicy(null, "emergency"));
    setup("2.0.0", "emergency", null, "off");
    const tenantBox = await editor(/^Tenant override/);
    await userEvent.click(await within(tenantBox).findByRole("button", { name: "Remove minimum version" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Removes the minimum version 2.0.0 from the rule of customer Acme Industries.");
    expect(dialog).toHaveTextContent("Emergency mode stays on: every PC this rule covers stays blocked, whatever its version, until the mode is changed.");
    expect(dialog).toHaveTextContent("rolling back restores 2.0.0");
    const confirm = within(dialog).getByRole("button", { name: "Remove minimum version" });
    expect(confirm).toBeDisabled(); // no reason yet
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "INC-77 floor no longer needed");
    await userEvent.click(confirm);
    await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(clearTenantMinAppVersion).toHaveBeenCalledWith("tenant_1", "2.0.0", {
        reason_code: "INC-77 floor no longer needed",
        step_up_token: "stepup-rollout_publish",
      }),
    );
    expect(await screen.findByText("Minimum version 2.0.0 removed. Rolling back restores it.")).toBeInTheDocument();
    await waitFor(() => expect(within(tenantBox).queryByRole("button", { name: "Remove minimum version" })).not.toBeInTheDocument());
    expect(clearCohortMinAppVersion).not.toHaveBeenCalled();
  });

  it("rollout group: the dialog names the channel and group; under Off nothing changes for PCs now", async () => {
    vi.mocked(clearCohortMinAppVersion).mockResolvedValue(cohortPolicy(null, "off"));
    setup(null, "inherit", "1.8.0", "off");
    const cohortBox = await editor(/^Cohort baseline/);
    await userEvent.click(await within(cohortBox).findByRole("button", { name: "Remove minimum version" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Removes the minimum version 1.8.0 from the rule of rollout group pilot-east on channel pilot");
    expect(dialog).toHaveTextContent("The mode is Off, so nothing changes for PCs now.");
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "INC-78 group floor");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove minimum version" }));
    await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(clearCohortMinAppVersion).toHaveBeenCalledWith("pilot", "pilot-east", "1.8.0", {
        reason_code: "INC-78 group floor",
        step_up_token: "stepup-rollout_publish",
      }),
    );
  });

  it("customer that inherits: nothing changes for PCs now", async () => {
    setup("2.1.0", "inherit", null, "off");
    await userEvent.click(await within(await editor(/^Tenant override/)).findByRole("button", { name: "Remove minimum version" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("This customer follows its rollout group's rule, so nothing changes for PCs now.");
  });

  it("under Required the removal is explained and cannot be confirmed", async () => {
    setup(null, "inherit", "1.8.0", "required");
    await userEvent.click(await within(await editor(/^Cohort baseline/)).findByRole("button", { name: "Remove minimum version" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("a rule without a minimum version asks every PC to update, so it cannot be removed now");
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "INC-79 try anyway");
    expect(within(dialog).getByRole("button", { name: "Remove minimum version" })).toBeDisabled();
    expect(clearCohortMinAppVersion).not.toHaveBeenCalled();
  });
});

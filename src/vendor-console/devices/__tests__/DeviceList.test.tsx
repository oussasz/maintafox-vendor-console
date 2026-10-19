import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  listTenantActivations: vi.fn(),
  revokeMachine: vi.fn(),
  reinstateMachine: vi.fn(),
  releaseMachineSlot: vi.fn(),
  rebindMachine: vi.fn(),
  requestMachinePolicyRefresh: vi.fn(),
  issueAdminRecoveryCode: vi.fn(),
  listAdminRecoveryCodes: vi.fn(),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ can: () => true, canAny: () => true }) }));

import {
  issueAdminRecoveryCode,
  listAdminRecoveryCodes,
  listTenantActivations,
  rebindMachine,
  releaseMachineSlot,
  requestMachinePolicyRefresh,
  type ActivationRow,
} from "@/services/license-control-service";
import { requestStepUp } from "@/services/vendor-auth-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { DeviceList } from "../DeviceList";

const now = Date.now();
const online: ActivationRow = {
  machine_id: "fp-office-0001",
  machine_label: "Bureau-Maintenance",
  tenant_id: "tenant_1",
  last_heartbeat_rfc3339: new Date(now - 60_000).toISOString(),
  app_version: "1.0.0",
  trusted_device: true,
  revocation_kind: null,
  policy_refresh_requested_at: null,
  activation_source: "license_claim",
  anomaly_flags: [],
  heartbeat_freshness: "live",
};
const quiet: ActivationRow = { ...online, machine_id: "fp-workshop-0002", machine_label: "Atelier-02", last_heartbeat_rfc3339: new Date(now - 3 * 86_400_000).toISOString(), heartbeat_freshness: "stale" };
const released: ActivationRow = { ...online, machine_id: "fp-old-0003", machine_label: null, trusted_device: false, revocation_kind: "released", anomaly_flags: ["revoked"] };

const rowOf = async (name: string) => (await screen.findByText(name)).closest("li") as HTMLElement;

async function confirmWithReason(reason: string, confirm: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), reason);
  await userEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

async function enterCode(code: string) {
  await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), code);
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

describe("DeviceList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTenantActivations).mockResolvedValue([online, quiet, released]);
    vi.mocked(listAdminRecoveryCodes).mockResolvedValue([]);
  });

  it("says in plain words how each device is doing", async () => {
    renderWithConsole(<DeviceList tenantId="tenant_1" onSeeHistory={() => undefined} />);
    expect(within(await rowOf("Bureau-Maintenance")).getByText("Online")).toBeInTheDocument();
    const workshop = await rowOf("Atelier-02");
    expect(within(workshop).getByText("Not seen for 3 days")).toBeInTheDocument();
    expect(within(workshop).getByRole("button", { name: "See what happened" })).toBeInTheDocument();
    const old = await rowOf("fp-old-0003");
    expect(within(old).getByText("Seat freed")).toBeInTheDocument();
    expect(within(old).queryByRole("button", { name: "Free this seat" })).not.toBeInTheDocument();
  });

  it("freeing a seat asks for a reason and an authenticator code, then calls the API", async () => {
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    await userEvent.click(within(await rowOf("Bureau-Maintenance")).getByRole("button", { name: "Free this seat" }));
    await confirmWithReason("computer scrapped", "Release slot");
    await enterCode("123456");
    await waitFor(() =>
      expect(releaseMachineSlot).toHaveBeenCalledWith("tenant_1", online.machine_id, {
        reason_code: "computer scrapped",
        step_up_token: "stepup-machine_trust_change",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("machine_trust_change", "123456");
  });

  it("moving a seat needs the fingerprint of the new computer before it can be confirmed", async () => {
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    await userEvent.click(within(await rowOf("Bureau-Maintenance")).getByRole("button", { name: "More actions for Bureau-Maintenance" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move the seat to a new computer" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "laptop replaced");
    const confirm = within(dialog).getByRole("button", { name: "Move slot" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Fingerprint of the replacement machine/), "fp-new-laptop-99");
    await userEvent.click(confirm);
    await enterCode("654321");
    await waitFor(() =>
      expect(rebindMachine).toHaveBeenCalledWith("tenant_1", online.machine_id, "fp-new-laptop-99", {
        reason_code: "laptop replaced",
        step_up_token: "stepup-machine_trust_change",
      }),
    );
  });

  it("a licence refresh is audited with a reason and needs no code; a refusal stays in the dialog", async () => {
    vi.mocked(requestMachinePolicyRefresh).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    await userEvent.click(within(await rowOf("Bureau-Maintenance")).getByRole("button", { name: "More actions for Bureau-Maintenance" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ask it to refresh its licence now" }));
    await confirmWithReason("edition changed", "Request refresh");
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("The control API cannot be reached");
    expect(requestStepUp).not.toHaveBeenCalled();
    expect(requestMachinePolicyRefresh).toHaveBeenCalledWith("tenant_1", online.machine_id, "edition changed");
  });

  it("an administrator recovery code needs a reason and an admin_recovery_code step-up, then is shown once with a copy button", async () => {
    const code = `MFXREC1.eyJ2IjoxfQ.${"ab".repeat(64)}`;
    vi.mocked(issueAdminRecoveryCode).mockResolvedValue({
      code,
      code_id: "3f6c1d2e-9a4b-4c7d-8e1f-2a3b4c5d6e7f",
      tenant_id: "tenant_1",
      machine_fingerprint: online.machine_id,
      license_id: "lic_1",
      issued_at: "2026-10-19T08:30:00.000Z",
      expires_at: "2026-10-20T08:30:00.000Z",
      key_id: "prod-1",
      audit_record_id: "audit_1",
    });
    const user = userEvent.setup();
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    await user.click(within(await rowOf("Bureau-Maintenance")).getByRole("button", { name: "More actions for Bureau-Maintenance" }));
    await user.click(await screen.findByRole("menuitem", { name: "Administrator recovery code" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Give this PC an administrator recovery code?")).toBeInTheDocument();
    expect(within(dialog).getByText("It is valid for 24 hours and can be used only once.")).toBeInTheDocument();
    expect(within(dialog).getByText(/creates an EXTRA administrator: it does not reset or unlock an existing account/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "site lost every admin");
    await user.click(within(dialog).getByRole("button", { name: "Issue the code" }));
    await user.type(await screen.findByLabelText("6-digit code from your authenticator app"), "246810");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(issueAdminRecoveryCode).toHaveBeenCalledWith("tenant_1", online.machine_id, {
        reason_code: "site lost every admin",
        step_up_token: "stepup-admin_recovery_code",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("admin_recovery_code", "246810");
    expect(await screen.findByTestId("admin-recovery-code")).toHaveTextContent(code);
    expect(screen.getByText(/it is shown only this once/i)).toBeInTheDocument();
    expect(screen.getByText(/^Valid until .+, once\.$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(await navigator.clipboard.readText()).toBe(code);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("admin-recovery-code")).not.toBeInTheDocument());
  });

  it("the recovery dialog says when codes sent earlier are still valid; a refusal stays in the dialog", async () => {
    vi.mocked(listAdminRecoveryCodes).mockResolvedValue([
      {
        code_id: "c1",
        tenant_id: "tenant_1",
        license_id: "lic_1",
        machine_fingerprint: online.machine_id,
        issued_by: "1",
        reason: "earlier",
        issued_at: new Date(now - 3_600_000).toISOString(),
        expires_at: new Date(now + 20 * 3_600_000).toISOString(),
        key_id: "prod-1",
        audit_record_id: "audit_0",
        expired: false,
      },
    ]);
    vi.mocked(issueAdminRecoveryCode).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    await userEvent.click(within(await rowOf("Bureau-Maintenance")).getByRole("button", { name: "More actions for Bureau-Maintenance" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Administrator recovery code" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/1 code issued earlier for this PC is still valid/)).toBeInTheDocument();
    expect(listAdminRecoveryCodes).toHaveBeenCalledWith("tenant_1", online.machine_id);
    await confirmWithReason("site lost every admin", "Issue the code");
    await enterCode("135790");
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("The control API cannot be reached");
    expect(screen.queryByTestId("admin-recovery-code")).not.toBeInTheDocument();
  });

  it("a code list that arrives after the dialog moved to another device is ignored", async () => {
    let resolveFirst: (rows: Awaited<ReturnType<typeof listAdminRecoveryCodes>>) => void = () => undefined;
    vi.mocked(listAdminRecoveryCodes)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([]);
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    const open = async (name: string) => {
      await userEvent.click(within(await rowOf(name)).getByRole("button", { name: `More actions for ${name}` }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Administrator recovery code" }));
      return screen.findByRole("dialog");
    };
    await open("Bureau-Maintenance");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const second = await open("Atelier-02");
    expect(listAdminRecoveryCodes).toHaveBeenLastCalledWith("tenant_1", quiet.machine_id);
    resolveFirst([
      {
        code_id: "c-stale",
        tenant_id: "tenant_1",
        license_id: "lic_1",
        machine_fingerprint: online.machine_id,
        issued_by: "1",
        reason: "earlier",
        issued_at: new Date(now - 3_600_000).toISOString(),
        expires_at: new Date(now + 20 * 3_600_000).toISOString(),
        key_id: "prod-1",
        audit_record_id: "audit_0",
        expired: false,
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(within(second).queryByText(/still valid/)).not.toBeInTheDocument();
  });

  it("explains an empty list", async () => {
    vi.mocked(listTenantActivations).mockResolvedValue([]);
    renderWithConsole(<DeviceList tenantId="tenant_1" />);
    expect(await screen.findByText("No device activated yet")).toBeInTheDocument();
  });
});

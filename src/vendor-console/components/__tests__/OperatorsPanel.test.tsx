import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/services/operators-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/operators-service")>()),
  listOperators: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  resetOperatorMfa: vi.fn(),
}));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  getSessionInfo: vi.fn(),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import { createOperator, listOperators, resetOperatorMfa, updateOperator, type Operator } from "@/services/operators-service";
import { getSessionInfo, requestStepUp } from "@/services/vendor-auth-service";
import { OperatorsPanel } from "../OperatorsPanel";
import { renderWithConsole } from "./renderWithConsole";

const ownerRow: Operator = {
  id: 1,
  email: "owner@maintafox.systems",
  display_name: "Owner",
  role: "owner",
  is_active: true,
  mfa_enrolled: true,
  created_at: "2026-10-01",
  last_login_at: null,
  open_sessions: 1,
};
const auditorRow: Operator = { ...ownerRow, id: 2, email: "auditor@maintafox.systems", display_name: "Auditor", role: "auditor" };

async function confirm(reason: string, button: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), reason);
  await userEvent.click(within(dialog).getByRole("button", { name: button }));
  await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
  await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
}

describe("OperatorsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOperators).mockResolvedValue([ownerRow, auditorRow]);
    vi.mocked(getSessionInfo).mockResolvedValue({
      user: { id: 1, email: ownerRow.email },
      session: { id: "s", created_at: "x", expires_at: "2026-10-13T00:00:00Z" },
      mfa: { enrolled: true, recovery_codes_remaining: 10 },
      step_up_ttl_seconds: 300,
    });
  });

  it("you cannot change your own access here", async () => {
    renderWithConsole(<OperatorsPanel />);
    const self = await screen.findByTestId("operator-1");
    expect(within(self).getByLabelText("operators.roleFor")).toBeDisabled();
    expect(within(self).queryByRole("button", { name: "operators.delete" })).not.toBeInTheDocument();
  });

  it("creating an operator uses the vendor_user_admin step-up and shows the one-time enrolment code", async () => {
    vi.mocked(createOperator).mockResolvedValue({ operator: { ...auditorRow, id: 3, email: "new@maintafox.systems" }, enrolment_code: "ABCDE-FGHJK" });
    renderWithConsole(<OperatorsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "operators.add" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operators.form.email"), "new@maintafox.systems");
    await userEvent.type(within(dialog).getByLabelText("operators.form.name"), "New person");
    await userEvent.selectOptions(within(dialog).getByLabelText("operators.form.role"), "support");
    await userEvent.type(within(dialog).getByLabelText("operators.form.password"), "short");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "new hire");
    const create = within(dialog).getByRole("button", { name: "operators.dialog.create.confirm" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("operators.form.password"), "-but-long-enough");
    await userEvent.click(create);
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    await waitFor(() =>
      expect(createOperator).toHaveBeenCalledWith(
        { email: "new@maintafox.systems", display_name: "New person", role: "support", initial_password: "short-but-long-enough" },
        { reason_code: "new hire", step_up_token: "stepup-vendor_user_admin" },
      ),
    );
    expect(requestStepUp).toHaveBeenCalledWith("vendor_user_admin", "123456");
    expect(await screen.findByTestId("one-time-code")).toHaveTextContent("ABCDE-FGHJK");
  });

  it("changing a role asks for confirmation, then calls the API", async () => {
    vi.mocked(updateOperator).mockResolvedValue({ ...auditorRow, role: "support" });
    renderWithConsole(<OperatorsPanel />);
    const row = await screen.findByTestId("operator-2");
    await userEvent.selectOptions(within(row).getByLabelText("operators.roleFor"), "support");
    await confirm("needs tickets", "operators.dialog.role.confirm");
    await waitFor(() =>
      expect(updateOperator).toHaveBeenCalledWith(2, { role: "support" }, { reason_code: "needs tickets", step_up_token: "stepup-vendor_user_admin" }),
    );
  });

  it("an MFA reset shows the one-time reset code", async () => {
    vi.mocked(resetOperatorMfa).mockResolvedValue("KLMNP-QRSTU");
    renderWithConsole(<OperatorsPanel />);
    const row = await screen.findByTestId("operator-2");
    await userEvent.click(within(row).getByRole("button", { name: "operators.mfaReset" }));
    await confirm("lost phone", "operators.dialog.mfaReset.confirm");
    expect(await screen.findByTestId("one-time-code")).toHaveTextContent("KLMNP-QRSTU");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") } }));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  login: vi.fn(),
  startTotpEnrolment: vi.fn(),
  confirmTotpEnrolment: vi.fn(),
  verifyTotp: vi.fn(),
  verifyRecoveryCode: vi.fn(),
}));

import {
  AuthApiError,
  confirmTotpEnrolment,
  login,
  startTotpEnrolment,
  verifyRecoveryCode,
  verifyTotp,
} from "@/services/vendor-auth-service";
import { ThemeProvider } from "@/components/ui/ThemeProvider";

import { LoginPage } from "../LoginPage";

const CODES = Array.from({ length: 10 }, (_, i) => `ABCDE-${String(i).padStart(5, "2")}`);

function renderLogin() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/vendor-console/audit" } }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/vendor-console/audit" element={<div>Audit page</div>} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

async function submitPassword() {
  await userEvent.type(screen.getByLabelText("vendorLogin.email"), "owner@maintafox.systems");
  await userEvent.type(screen.getByLabelText("vendorLogin.password"), "Secret-password-1");
  await userEvent.click(screen.getByRole("button", { name: "vendorLogin.submit" }));
}

describe("LoginPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("first login: enrols the authenticator, shows recovery codes once, continues only after acknowledgement", async () => {
    vi.mocked(login).mockResolvedValue({ status: "mfa_enrollment_required", mfa_token: "mfa.t.k", expires_in: 600 });
    vi.mocked(startTotpEnrolment).mockResolvedValue({
      otpauth_uri: "otpauth://totp/Maintafox%20Vendor%20Console:owner?secret=JBSWY3DPEHPK3PXPJBSWY3DP",
      secret_base32: "JBSWY3DPEHPK3PXPJBSWY3DP",
      account_name: "owner@maintafox.systems",
    });
    vi.mocked(confirmTotpEnrolment).mockResolvedValue({
      access_token: "a.b.c",
      expires_in: 900,
      session_expires_at: "2026-10-13T00:00:00Z",
      recovery_codes: CODES,
    });
    renderLogin();
    await submitPassword();

    expect(await screen.findByAltText("vendorLogin.enroll.qrAlt")).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(screen.getByTestId("totp-secret")).toHaveTextContent("JBSW Y3DP EHPK 3PXP JBSW Y3DP");
    const confirm = screen.getByRole("button", { name: "vendorLogin.enroll.confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("vendorLogin.codeLabel"), "12a3456");
    expect(screen.getByLabelText("vendorLogin.codeLabel")).toHaveValue("123456");
    await userEvent.click(confirm);
    expect(confirmTotpEnrolment).toHaveBeenCalledWith("mfa.t.k", "123456");

    const list = await screen.findByTestId("recovery-codes");
    expect(list.querySelectorAll("li")).toHaveLength(10);
    const proceed = screen.getByRole("button", { name: "vendorLogin.continue" });
    expect(proceed).toBeDisabled();
    await userEvent.click(screen.getByLabelText("vendorLogin.recovery.ack"));
    await userEvent.click(proceed);
    expect(await screen.findByText("Audit page")).toBeInTheDocument();
  });

  it("a wrong enrolment code keeps the operator on the enrolment step with the reason", async () => {
    vi.mocked(login).mockResolvedValue({ status: "mfa_enrollment_required", mfa_token: "mfa.t.k", expires_in: 600 });
    vi.mocked(startTotpEnrolment).mockResolvedValue({
      otpauth_uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
      secret_base32: "JBSWY3DPEHPK3PXP",
      account_name: "owner@maintafox.systems",
    });
    vi.mocked(confirmTotpEnrolment).mockRejectedValue(new AuthApiError(401, "invalid_mfa_code"));
    renderLogin();
    await submitPassword();
    await userEvent.type(await screen.findByLabelText("vendorLogin.codeLabel"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.enroll.confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("vendorLogin.error.invalid_mfa_code");
    expect(screen.getByAltText("vendorLogin.enroll.qrAlt")).toBeInTheDocument();
  });

  it("enrolled operator: TOTP code signs in", async () => {
    vi.mocked(login).mockResolvedValue({ status: "mfa_required", mfa_token: "mfa.t.k", expires_in: 600 });
    vi.mocked(verifyTotp).mockResolvedValue({ access_token: "a.b.c", expires_in: 900, session_expires_at: "x" });
    renderLogin();
    await submitPassword();
    await userEvent.type(await screen.findByLabelText("vendorLogin.codeLabel"), "654321");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.verify.submit" }));
    expect(verifyTotp).toHaveBeenCalledWith("mfa.t.k", "654321");
    expect(await screen.findByText("Audit page")).toBeInTheDocument();
  });

  it("lost phone: a recovery code signs in and the remaining count is shown", async () => {
    vi.mocked(login).mockResolvedValue({ status: "mfa_required", mfa_token: "mfa.t.k", expires_in: 600 });
    vi.mocked(verifyRecoveryCode).mockResolvedValue({
      access_token: "a.b.c",
      expires_in: 900,
      session_expires_at: "x",
      recovery_codes_remaining: 2,
    });
    renderLogin();
    await submitPassword();
    await userEvent.click(await screen.findByRole("button", { name: "vendorLogin.verify.useRecovery" }));
    await userEvent.type(screen.getByLabelText("vendorLogin.verify.recoveryLabel"), "ABCDE-22222");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.verify.submit" }));
    expect(verifyRecoveryCode).toHaveBeenCalledWith("mfa.t.k", "ABCDE-22222");
    expect(await screen.findByText("vendorLogin.recoveryUsed.body")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.continue" }));
    expect(await screen.findByText("Audit page")).toBeInTheDocument();
  });

  it("an expired MFA step returns to the password form with the reason (never a dead end)", async () => {
    vi.mocked(login).mockResolvedValue({ status: "mfa_required", mfa_token: "mfa.t.k", expires_in: 600 });
    vi.mocked(verifyTotp).mockRejectedValue(new AuthApiError(401, "mfa_token_invalid"));
    renderLogin();
    await submitPassword();
    await userEvent.type(await screen.findByLabelText("vendorLogin.codeLabel"), "111111");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.verify.submit" }));
    await waitFor(() => expect(screen.getByLabelText("vendorLogin.password")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("vendorLogin.error.mfa_token_invalid");
  });

  it("after a server-side MFA reset, enrolment asks for the one-time reset code first", async () => {
    vi.mocked(login).mockResolvedValue({
      status: "mfa_enrollment_required",
      mfa_token: "mfa.t.k",
      expires_in: 600,
      reset_code_required: true,
    });
    vi.mocked(startTotpEnrolment)
      .mockRejectedValueOnce(new AuthApiError(401, "invalid_reset_code"))
      .mockResolvedValueOnce({
        otpauth_uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        secret_base32: "JBSWY3DPEHPK3PXP",
        account_name: "owner@maintafox.systems",
      });
    renderLogin();
    await submitPassword();
    expect(startTotpEnrolment).not.toHaveBeenCalled();
    await userEvent.type(await screen.findByLabelText("vendorLogin.resetCode.label"), "WRONG-CODE1");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("vendorLogin.error.invalid_reset_code");
    await userEvent.clear(screen.getByLabelText("vendorLogin.resetCode.label"));
    await userEvent.type(screen.getByLabelText("vendorLogin.resetCode.label"), "ABCDE-FGHJK");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.continue" }));
    expect(startTotpEnrolment).toHaveBeenLastCalledWith("mfa.t.k", "ABCDE-FGHJK");
    expect(await screen.findByAltText("vendorLogin.enroll.qrAlt")).toBeInTheDocument();
  });

  it("wrong password and rate limit are explained", async () => {
    vi.mocked(login).mockRejectedValueOnce(new AuthApiError(401, "invalid_credentials"));
    renderLogin();
    await submitPassword();
    expect(await screen.findByRole("alert")).toHaveTextContent("vendorLogin.error.invalid_credentials");
    vi.mocked(login).mockRejectedValueOnce(new AuthApiError(429, "rate_limited"));
    await userEvent.type(screen.getByLabelText("vendorLogin.password"), "again");
    await userEvent.click(screen.getByRole("button", { name: "vendorLogin.submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("vendorLogin.error.rate_limited");
  });
});

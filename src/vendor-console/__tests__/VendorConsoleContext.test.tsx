import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: { action?: string }) => (opts?.action ? `${key}:${opts.action}` : key) }),
}));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(),
}));

import { StepUpKinds, type StepUpActionKind } from "@/lib/step-up-kinds";
import { AuthApiError, requestStepUp } from "@/services/vendor-auth-service";
import { renderWithConsole } from "../components/__tests__/renderWithConsole";
import { StepUpCancelledError, useVendorConsole } from "../VendorConsoleContext";

function Probe({ kind }: { kind: StepUpActionKind }) {
  const { requireStepUp } = useVendorConsole();
  const [out, setOut] = useState("");
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void requireStepUp(kind)
            .then(setOut)
            .catch((e: unknown) => setOut(e instanceof StepUpCancelledError ? "cancelled" : "error"))
        }
      >
        run {kind}
      </button>
      <output data-testid={`out-${kind}`}>{out}</output>
    </div>
  );
}

async function enterCode(code: string) {
  await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), code);
  await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
}

describe("step-up per action kind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestStepUp).mockImplementation(async (actionKind, code) => ({
      token: `token-${actionKind}-${code}`,
      actionKind,
      expiresAtMs: Date.now() + 300_000,
    }));
  });

  it("asks for a code naming the action, reuses the token for the same kind, asks again for another kind", async () => {
    renderWithConsole(
      <>
        <Probe kind={StepUpKinds.entitlementSuspension} />
        <Probe kind={StepUpKinds.rolloutPublish} />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "run entitlement_suspension" }));
    expect(await screen.findByText("stepUp.description:stepUp.kinds.entitlement_suspension")).toBeInTheDocument();
    await enterCode("111111");
    expect(screen.getByTestId("out-entitlement_suspension")).toHaveTextContent("token-entitlement_suspension-111111");
    expect(requestStepUp).toHaveBeenCalledWith("entitlement_suspension", "111111");

    // Same kind within the TTL: no new code.
    await userEvent.click(screen.getByRole("button", { name: "run entitlement_suspension" }));
    expect(requestStepUp).toHaveBeenCalledTimes(1);

    // Another kind: the server would refuse the first token, so a new code is required.
    await userEvent.click(screen.getByRole("button", { name: "run rollout_publish" }));
    await enterCode("222222");
    expect(screen.getByTestId("out-rollout_publish")).toHaveTextContent("token-rollout_publish-222222");
    expect(requestStepUp).toHaveBeenCalledTimes(2);
  });

  it("a refused code stays in the dialog with an explanation; cancelling rejects the action", async () => {
    vi.mocked(requestStepUp).mockRejectedValueOnce(new AuthApiError(401, "invalid_mfa_code"));
    renderWithConsole(<Probe kind={StepUpKinds.machineTrustChange} />);
    await userEvent.click(screen.getByRole("button", { name: "run machine_trust_change" }));
    await enterCode("999999");
    expect(await screen.findByRole("alert")).toHaveTextContent("stepUp.errorInvalidCode");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.cancel" }));
    expect(await screen.findByTestId("out-machine_trust_change")).toHaveTextContent("cancelled");
  });
});

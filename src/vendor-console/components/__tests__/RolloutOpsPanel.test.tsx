import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === "string" ? fallback : key),
  }),
}));

vi.mock("@/services/vendor-ops-telemetry-service", () => ({ getRolloutOverview: vi.fn() }));
vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  setRolloutGovernance: vi.fn(),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import { setRolloutGovernance } from "@/services/license-control-service";
import { requestStepUp } from "@/services/vendor-auth-service";
import { getRolloutOverview, type RolloutOverviewV1 } from "@/services/vendor-ops-telemetry-service";
import { RolloutOpsPanel } from "../RolloutOpsPanel";
import { renderWithConsole } from "./renderWithConsole";

type Impact = RolloutOverviewV1["impact"];
const published: Pick<Impact, "release_id" | "release_version" | "release_channel" | "release_rollout_percent"> = {
  release_id: "rel_1",
  release_version: "2.1.0",
  release_channel: "pilot",
  release_rollout_percent: 25,
};
const nothingPublished: typeof published = { release_id: null, release_version: null, release_channel: null, release_rollout_percent: null };

function overview(governance: "active" | "paused" | "recalled", recalled: string | null = null, release = published): RolloutOverviewV1 {
  return {
    impact: { ...release, affected_tenants: 1, affected_machines: 2, entitlement_channel_ok: true, known_blockers: [] },
    cohort_stages: [
      {
        channel: "stable",
        cohort_label: "stable-main",
        tenant_count: 1,
        machine_count: 2,
        governance,
        paused_at_rfc3339: governance === "active" ? null : "2026-10-12T10:00:00Z",
        recalled_version: recalled,
        governance_reason: governance === "active" ? null : "crash reports",
      },
    ],
    diagnostics: [],
  };
}

async function stepUp(code: string) {
  await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), code);
  await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
}

describe("RolloutOpsPanel governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the latest published release as version, ring and percentage", async () => {
    vi.mocked(getRolloutOverview).mockResolvedValue(overview("active"));
    renderWithConsole(<RolloutOpsPanel />);
    expect(await screen.findByText("rollouts.impact.release")).toBeInTheDocument();
    expect(screen.queryByText("rel_1")).not.toBeInTheDocument();
  });

  it("says so when no release is published yet", async () => {
    vi.mocked(getRolloutOverview).mockResolvedValue(overview("active", null, nothingPublished));
    renderWithConsole(<RolloutOpsPanel />);
    expect(await screen.findByText("rollouts.impact.noRelease")).toBeInTheDocument();
  });

  it("says devices act only once the updater exists", async () => {
    vi.mocked(getRolloutOverview).mockResolvedValue(overview("active"));
    renderWithConsole(<RolloutOpsPanel />);
    expect(await screen.findByText("rollouts.governance.deviceNotice")).toBeInTheDocument();
  });

  it("pause uses the rollout_publish step-up and reloads the real state", async () => {
    vi.mocked(getRolloutOverview).mockResolvedValueOnce(overview("active")).mockResolvedValueOnce(overview("paused"));
    renderWithConsole(<RolloutOpsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "rollouts.cohorts.pause" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "crash reports");
    await userEvent.click(within(dialog).getByRole("button", { name: "rollouts.governance.pause.confirm" }));
    await stepUp("111111");
    await waitFor(() =>
      expect(setRolloutGovernance).toHaveBeenCalledWith("stable", "stable-main", "pause", {
        reason_code: "crash reports",
        step_up_token: "stepup-rollout_publish",
        recalled_version: undefined,
      }),
    );
    expect(await screen.findByRole("button", { name: "rollouts.cohorts.resume" })).toBeInTheDocument();
    expect(screen.getByText("crash reports")).toBeInTheDocument();
  });

  it("recall needs the version and the forced_rollback step-up", async () => {
    vi.mocked(getRolloutOverview).mockResolvedValueOnce(overview("paused")).mockResolvedValueOnce(overview("recalled", "2.1.0"));
    renderWithConsole(<RolloutOpsPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "rollouts.cohorts.recall" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "bad build");
    const confirm = within(dialog).getByRole("button", { name: "rollouts.governance.recall.confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("rollouts.governance.recall.versionLabel"), "2.1.0");
    await userEvent.click(confirm);
    await stepUp("222222");
    await waitFor(() =>
      expect(setRolloutGovernance).toHaveBeenCalledWith("stable", "stable-main", "recall", {
        reason_code: "bad build",
        step_up_token: "stepup-forced_rollback",
        recalled_version: "2.1.0",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("forced_rollback", "222222");
    expect(await screen.findByText("rollouts.cohorts.recalledVersion")).toBeInTheDocument();
  });
});

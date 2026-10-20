import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/release-catalog-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/release-catalog-service")>()),
  listReleases: vi.fn(),
  updateReleaseNotes: vi.fn(),
  publishRelease: vi.fn(),
  recallRelease: vi.fn(),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));
const permissions = vi.hoisted(() => ({ manage: true }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: (p: string) => (p === "rollout.manage" ? permissions.manage : true), canAny: () => true }),
}));

import { ApiRequestError } from "@/lib/api-error";
import { listReleases, publishRelease, recallRelease, updateReleaseNotes, type Release } from "@/services/release-catalog-service";
import { requestStepUp } from "@/services/vendor-auth-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { ReleaseCatalogPanel } from "../ReleaseCatalogPanel";

const base: Release = {
  release_id: "rel_210",
  version: "2.1.0",
  state: "registered",
  notes_en: "Faster sync.",
  notes_fr: "Synchronisation plus rapide.",
  channel: null,
  rollout_percent: 0,
  code_signed: true,
  git_commit: "abc1234def",
  registered_by: "release_publisher:rpk_1",
  registered_at: "2026-10-12T08:00:00.000Z",
  published_at: null,
  updated_at: "2026-10-12T08:00:00.000Z",
  recalled_at: null,
  recalled_reason: null,
  recalled_by: null,
  artifacts: [
    {
      target: "windows",
      arch: "x86_64",
      file_name: "Maintafox_2.1.0_x64-setup.exe",
      byte_size: 104_857_600,
      sha256: "a".repeat(64),
      verified_at: "2026-10-12T08:05:00.000Z",
    },
  ],
};
const draft = base;
const pilot: Release = { ...base, release_id: "rel_200", version: "2.0.0", channel: "pilot", rollout_percent: 25, published_at: "2026-10-01T08:00:00.000Z", code_signed: false };
const uploading: Release = { ...base, release_id: "rel_220", version: "2.2.0", state: "uploading" };
const recalled: Release = {
  ...base,
  release_id: "rel_190",
  version: "1.9.0",
  channel: "stable",
  rollout_percent: 100,
  recalled_at: "2026-09-20T08:00:00.000Z",
  recalled_reason: "crash on start",
  recalled_by: "op_1",
};

const row = async (version: string) => screen.findByTestId(`release-${version}`);

async function confirmWithReason(reason: string, confirm: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), reason);
  await userEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

async function enterCode(code: string) {
  await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), code);
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

describe("ReleaseCatalogPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.manage = true;
    vi.mocked(listReleases).mockResolvedValue([uploading, draft, pilot, recalled]);
  });

  it("lists every release with its status and warns when it is not code-signed", async () => {
    renderWithConsole(<ReleaseCatalogPanel />);
    expect(within(await row("2.2.0")).getByText("Uploading")).toBeInTheDocument();
    expect(within(await row("2.1.0")).getByText("Draft")).toBeInTheDocument();
    const pilotRow = await row("2.0.0");
    expect(within(pilotRow).getByText("Pilot")).toBeInTheDocument();
    expect(within(pilotRow).getByText("25% of the ring")).toBeInTheDocument();
    expect(within(pilotRow).getByText("Not code-signed")).toBeInTheDocument();
    expect(within(pilotRow).getByText(/Windows SmartScreen will warn users/)).toBeInTheDocument();
    expect(within(await row("2.1.0")).queryByText("Not code-signed")).not.toBeInTheDocument();
    expect(within(await row("1.9.0")).getByText("Recalled")).toBeInTheDocument();
    expect(within(await row("1.9.0")).getByText(/crash on start/)).toBeInTheDocument();
  });

  it("shows the files, the commit and the notes in the details", async () => {
    renderWithConsole(<ReleaseCatalogPanel />);
    await userEvent.click(within(await row("2.1.0")).getByRole("button", { name: "Details" }));
    const r = await row("2.1.0");
    expect(within(r).getByText("Maintafox_2.1.0_x64-setup.exe")).toBeInTheDocument();
    expect(within(r).getByText("100 MB")).toBeInTheDocument();
    expect(within(r).getByText("abc1234def")).toBeInTheDocument();
    expect(within(r).getByLabelText("English notes")).toHaveValue("Faster sync.");
  });

  it("saves edited notes", async () => {
    vi.mocked(updateReleaseNotes).mockResolvedValue({ ...draft, notes_en: "Faster sync and fixes." });
    renderWithConsole(<ReleaseCatalogPanel />);
    await userEvent.click(within(await row("2.1.0")).getByRole("button", { name: "Details" }));
    const r = await row("2.1.0");
    await userEvent.type(within(r).getByLabelText("English notes"), " And fixes.");
    await userEvent.click(within(r).getByRole("button", { name: "Save notes" }));
    await waitFor(() =>
      expect(updateReleaseNotes).toHaveBeenCalledWith("rel_210", { notes_en: "Faster sync. And fixes.", notes_fr: "Synchronisation plus rapide." }),
    );
    expect(await screen.findByText("Notes of v2.1.0 saved.")).toBeInTheDocument();
  });

  it("publishes a draft to the chosen ring and percentage after the rollout_publish step-up", async () => {
    vi.mocked(publishRelease).mockResolvedValue({ ...draft, channel: "pilot", rollout_percent: 10, published_at: "2026-10-13T08:00:00.000Z" });
    renderWithConsole(<ReleaseCatalogPanel />);
    await userEvent.click(within(await row("2.1.0")).getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Pilot/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "10%" }));
    await confirmWithReason("pilot wave 1", "Publish");
    await enterCode("123456");
    await waitFor(() =>
      expect(publishRelease).toHaveBeenCalledWith("rel_210", { channel: "pilot", rollout_percent: 10 }, { reason_code: "pilot wave 1", step_up_token: "stepup-rollout_publish" }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("rollout_publish", "123456");
    expect(await screen.findByText("v2.1.0 is now published to Pilot at 10%.")).toBeInTheDocument();
  });

  it("offers only the current ring or a wider one and explains a refused narrowing", async () => {
    vi.mocked(publishRelease).mockRejectedValue(new ApiRequestError(409, "channel_narrowing_refused", null, {}));
    renderWithConsole(<ReleaseCatalogPanel />);
    await userEvent.click(within(await row("2.0.0")).getByRole("button", { name: "Widen" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("radio", { name: /Internal/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Pilot/ })).toBeChecked();
    const confirm = within(dialog).getByRole("button", { name: "Publish" });
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "widen");
    expect(confirm).toBeDisabled(); // nothing changed yet
    await userEvent.click(within(dialog).getByRole("button", { name: "50%" }));
    await userEvent.click(confirm);
    await enterCode("123456");
    expect(await within(dialog).findByText(/can only be widened \(Internal, then Pilot, then Stable\)/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not offer publishing an uploading or recalled release, and says why", async () => {
    renderWithConsole(<ReleaseCatalogPanel />);
    expect(within(await row("2.2.0")).getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(within(await row("2.2.0")).getByText(/has not finished uploading/)).toBeInTheDocument();
    expect(within(await row("1.9.0")).getByRole("button", { name: "Widen" })).toBeDisabled();
    expect(within(await row("1.9.0")).queryByRole("button", { name: "Recall" })).not.toBeInTheDocument();
  });

  it("recalls with a reason after the forced_rollback step-up", async () => {
    vi.mocked(recallRelease).mockResolvedValue({ ...pilot, recalled_at: "2026-10-13T09:00:00.000Z", recalled_reason: "data loss", recalled_by: "op_1" });
    renderWithConsole(<ReleaseCatalogPanel />);
    await userEvent.click(within(await row("2.0.0")).getByRole("button", { name: "Recall" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/devices already running it are moved back to the previous release/)).toBeInTheDocument();
    await confirmWithReason("data loss", "Recall this version");
    await enterCode("654321");
    await waitFor(() => expect(recallRelease).toHaveBeenCalledWith("rel_200", { reason_code: "data loss", step_up_token: "stepup-forced_rollback" }));
    expect(requestStepUp).toHaveBeenCalledWith("forced_rollback", "654321");
    expect(await screen.findByText("v2.0.0 recalled.")).toBeInTheDocument();
    expect(within(await row("2.0.0")).getByText("Recalled")).toBeInTheDocument();
  });

  it("is read-only without the rollout management permission", async () => {
    permissions.manage = false;
    renderWithConsole(<ReleaseCatalogPanel />);
    expect(await screen.findByText(/need the rollout management permission/)).toBeInTheDocument();
    expect(within(await row("2.1.0")).queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    expect(within(await row("2.0.0")).queryByRole("button", { name: "Recall" })).not.toBeInTheDocument();
  });

  it("shows a plain-language error when the list cannot be loaded", async () => {
    vi.mocked(listReleases).mockRejectedValue(new TypeError("Failed to fetch"));
    renderWithConsole(<ReleaseCatalogPanel />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });
});

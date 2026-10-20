import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/release-catalog-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/release-catalog-service")>()),
  listPublisherKeys: vi.fn(),
  createPublisherKey: vi.fn(),
  revokePublisherKey: vi.fn(),
}));
vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));
const granted = vi.hoisted(() => ({ permissions: null as string[] | null }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    can: (p: string) => granted.permissions === null || granted.permissions.includes(p),
    canAny: () => true,
  }),
}));

import { createPublisherKey, listPublisherKeys, revokePublisherKey, type PublisherKey } from "@/services/release-catalog-service";
import { requestStepUp } from "@/services/vendor-auth-service";
import { renderWithConsole } from "../../components/__tests__/renderWithConsole";
import { ReleasePublisherKeysPanel } from "../ReleasePublisherKeysPanel";

const existing: PublisherKey = {
  key_id: "rpk_1",
  label: "desktop repo",
  created_at: "2026-10-01T08:00:00.000Z",
  created_by: "op_1",
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
};
const fresh: PublisherKey = { ...existing, key_id: "rpk_2", label: "desktop repo 2026", created_at: "2026-10-13T08:00:00.000Z" };

async function confirmWithReason(reason: string, confirm: string) {
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), reason);
  await userEvent.click(within(dialog).getByRole("button", { name: confirm }));
}

async function enterCode(code: string) {
  await userEvent.type(await screen.findByLabelText("6-digit code from your authenticator app"), code);
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

describe("ReleasePublisherKeysPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted.permissions = null;
    vi.mocked(listPublisherKeys).mockResolvedValue([existing]);
  });

  it("offers create and revoke only with operator.manage (rollout.manage is not enough)", async () => {
    granted.permissions = ["console.view", "rollout.manage"];
    renderWithConsole(<ReleasePublisherKeysPanel />);
    expect(await screen.findByText("desktop repo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("creates a key with the release_publisher_key step-up and shows its token once", async () => {
    vi.mocked(createPublisherKey).mockResolvedValue({ ...fresh, token: "mfxrp_onetime" });
    renderWithConsole(<ReleasePublisherKeysPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "New key" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Create key" });
    await userEvent.type(within(dialog).getByLabelText("Reason (kept in the audit log)"), "CI setup");
    expect(confirm).toBeDisabled(); // a name is needed
    await userEvent.type(within(dialog).getByLabelText("Key name"), "desktop repo 2026");
    vi.mocked(listPublisherKeys).mockResolvedValue([fresh, existing]);
    await userEvent.click(confirm);
    await enterCode("123456");
    await waitFor(() => expect(createPublisherKey).toHaveBeenCalledWith("desktop repo 2026", { reason_code: "CI setup", step_up_token: "stepup-release_publisher_key" }));
    expect(requestStepUp).toHaveBeenCalledWith("release_publisher_key", "123456");
    expect(await screen.findByLabelText("Key token")).toHaveValue("mfxrp_onetime");
    expect(screen.getByText(/MAINTAFOX_RELEASE_PUBLISHER_TOKEN: it cannot be shown again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "I have stored it" }));
    expect(screen.queryByLabelText("Key token")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("mfxrp_onetime")).not.toBeInTheDocument();
    expect(await screen.findByText("desktop repo 2026")).toBeInTheDocument();
  });

  it("revokes a key", async () => {
    vi.mocked(revokePublisherKey).mockResolvedValue({ ...existing, revoked_at: "2026-10-13T08:00:00.000Z", revoked_by: "op_1" });
    renderWithConsole(<ReleasePublisherKeysPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await confirmWithReason("leaked in logs", "Revoke key");
    await enterCode("654321");
    await waitFor(() => expect(revokePublisherKey).toHaveBeenCalledWith("rpk_1", { reason_code: "leaked in logs", step_up_token: "stepup-release_publisher_key" }));
    expect(await screen.findByText("Key desktop repo revoked.")).toBeInTheDocument();
    expect(screen.getByText("Revoked", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
}));

vi.mock("@/services/vendor-ops-telemetry-service", () => ({
  listDeletedAttachments: vi.fn(),
  restoreDeletedAttachment: vi.fn(),
}));

vi.mock("@/services/vendor-auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/vendor-auth-service")>()),
  requestStepUp: vi.fn(async (actionKind: string) => ({ token: `stepup-${actionKind}`, actionKind, expiresAtMs: Date.now() + 300_000 })),
}));

import { requestStepUp } from "@/services/vendor-auth-service";
import { listDeletedAttachments, restoreDeletedAttachment, type DeletedAttachment } from "@/services/vendor-ops-telemetry-service";
import { DeletedAttachmentsPanel } from "../DeletedAttachmentsPanel";
import { renderWithConsole } from "./renderWithConsole";

function entry(over: Partial<DeletedAttachment> = {}): DeletedAttachment {
  return {
    id: "7",
    entity_type: "media_attachments",
    entity_sync_id: "media-1",
    change_kind: "delete",
    changed_at: "2026-10-20T08:00:00Z",
    changed_by: { license_id: "lic_1", machine_fingerprint: "fp-tablet-2" },
    change_row_version: 2,
    prior_state: "present",
    prior_row_version: 1,
    content_sha256: "a".repeat(64),
    byte_size: 1234,
    file_on_server: true,
    companion: null,
    restored: null,
    restore_blocker: null,
    ...over,
  };
}

describe("DeletedAttachmentsPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists deletes with the deleting device; only restorable ones offer Restore", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue([
      entry(),
      entry({ id: "8", entity_sync_id: "photo-2", entity_type: "asset_photos", restore_blocker: "entity_changed_since_delete" }),
      entry({
        id: "9",
        entity_sync_id: "media-3",
        restored: { at: "2026-10-20T09:00:00Z", by: "user_1", reason: "mistake", audit_record_id: "rec_1", row_version: 3 },
        restore_blocker: "already_restored",
      }),
    ]);
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    const table = await screen.findByTestId("deleted-attachments");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("media-1");
    expect(rows[0]).toHaveTextContent("fp-tablet-2");
    expect(rows[0]).toHaveTextContent("sync.deletedAttachments.type.media_attachments");
    expect(within(rows[0]!).getByRole("button", { name: "sync.deletedAttachments.restore" })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("sync.deletedAttachments.blocker.entity_changed_since_delete");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(rows[2]).toHaveTextContent("sync.deletedAttachments.state.restored");
    expect(rows[2]).toHaveTextContent("mistake");
    expect(within(rows[2]!).queryByRole("button")).toBeNull();
    expect(listDeletedAttachments).toHaveBeenCalledWith("tenant_1");
  });

  it("restore asks for a reason and a sync_attachment_restore code, then reloads", async () => {
    vi.mocked(listDeletedAttachments)
      .mockResolvedValueOnce([entry()])
      .mockResolvedValueOnce([
        entry({
          restored: { at: "2026-10-20T09:00:00Z", by: "user_1", reason: "deleted by mistake", audit_record_id: "rec_1", row_version: 3 },
          restore_blocker: "already_restored",
        }),
      ]);
    vi.mocked(restoreDeletedAttachment).mockResolvedValue();
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "sync.deletedAttachments.restore" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "sync.deletedAttachments.restoreConfirm" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "deleted by mistake");
    await userEvent.click(confirm);
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    await waitFor(() =>
      expect(restoreDeletedAttachment).toHaveBeenCalledWith("tenant_1", "7", {
        reason_code: "deleted by mistake",
        step_up_token: "stepup-sync_attachment_restore",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("sync_attachment_restore", "123456");
    expect(await screen.findByText("sync.deletedAttachments.restored")).toBeInTheDocument();
    expect(await screen.findByText("sync.deletedAttachments.state.restored")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "sync.deletedAttachments.restore" })).toBeNull();
  });

  it("a refused restore stays in the dialog with the reason", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue([entry()]);
    vi.mocked(restoreDeletedAttachment).mockRejectedValue(new Error("entity changed"));
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "sync.deletedAttachments.restore" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "deleted by mistake");
    await userEvent.click(within(dialog).getByRole("button", { name: "sync.deletedAttachments.restoreConfirm" }));
    await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
    expect(await within(await screen.findByRole("dialog")).findByRole("alert")).toHaveTextContent("entity changed");
  });

  it("shows a replaced entry, the server file copy and the companion Photo or file entry", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue([
      entry({
        id: "11",
        entity_type: "asset_photos",
        entity_sync_id: "photo-1",
        change_kind: "overwrite",
        file_on_server: true,
        companion: { entity_sync_id: "media-photo-1", archive_id: "12", live: false, file_on_server: true },
      }),
      entry({ id: "12", entity_sync_id: "media-photo-1", file_on_server: false }),
    ]);
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    const table = await screen.findByTestId("deleted-attachments");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    const [replaced, media] = within(table).getAllByRole("row").slice(1);
    expect(replaced).toHaveTextContent("sync.deletedAttachments.state.replaced");
    expect(replaced).toHaveTextContent("sync.deletedAttachments.file.onServer");
    expect(within(replaced!).getByTestId("companion-11")).toHaveTextContent("sync.deletedAttachments.companion.archived");
    expect(media).toHaveTextContent("sync.deletedAttachments.state.deleted");
    expect(media).toHaveTextContent("sync.deletedAttachments.file.notOnServer");
  });

  it("says when nothing was deleted", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue([]);
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    expect(await screen.findByText("sync.deletedAttachments.empty")).toBeInTheDocument();
  });
});

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
import {
  listDeletedAttachments,
  restoreDeletedAttachment,
  type DeletedAttachment,
  type DeletedAttachmentsPage,
} from "@/services/vendor-ops-telemetry-service";
import { DeletedAttachmentsPanel } from "../DeletedAttachmentsPanel";
import { renderWithConsole } from "./renderWithConsole";

const CURRENT = { row_version: 2, payload_hash: "b".repeat(64), deleted: true };

function entry(over: Partial<DeletedAttachment> = {}): DeletedAttachment {
  return {
    id: "7",
    entity_type: "media_attachments",
    entity_sync_id: "media-1",
    change_kind: "delete",
    locator_changed: true,
    changed_at: "2026-10-20T08:00:00Z",
    changed_by: { license_id: "lic_1", machine_fingerprint: "fp-tablet-2", operator: null },
    change_row_version: 2,
    prior_state: "present",
    prior_row_version: 1,
    prior_payload_hash: "a".repeat(64),
    content_sha256: "a".repeat(64),
    byte_size: 1234,
    file_on_server: true,
    companion: null,
    restorable: true,
    current: CURRENT,
    restores: [],
    ...over,
  };
}

function page(items: DeletedAttachment[], extra: Partial<DeletedAttachmentsPage> = {}): DeletedAttachmentsPage {
  return { tenant_id: "tenant_1", items, next_cursor: null, nothing_kept_summary: [], ...extra };
}

async function restoreFirstRow() {
  await userEvent.click(await screen.findByRole("button", { name: "sync.deletedAttachments.restore" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "sync.deletedAttachments.restoreConfirm" });
  expect(confirm).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "deleted by mistake");
  await userEvent.click(confirm);
  await userEvent.type(await screen.findByLabelText("stepUp.codeLabel"), "123456");
  await userEvent.click(screen.getByRole("button", { name: "stepUp.confirm" }));
}

describe("DeletedAttachmentsPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists changes with the sending device, the current state and restores; only kept versions offer Restore", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue(page([
      entry({
        restores: [{ at: "2026-10-20T09:00:00Z", by: "user_1", reason: "mistake", audit_record_id: "rec_1", row_version: 3 }],
        current: { row_version: 3, payload_hash: "a".repeat(64), deleted: false },
      }),
      entry({ id: "8", entity_sync_id: "photo-2", entity_type: "asset_photos", prior_state: "already_deleted", prior_row_version: null, restorable: false }),
      entry({
        id: "9",
        entity_sync_id: "media-3",
        change_kind: "restore",
        changed_by: { license_id: null, machine_fingerprint: "server:attachment-restore", operator: "user_2" },
      }),
    ]));
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    const table = await screen.findByTestId("deleted-attachments");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("media-1");
    expect(rows[0]).toHaveTextContent("fp-tablet-2");
    expect(rows[0]).toHaveTextContent("sync.deletedAttachments.archivedVersion");
    expect(rows[0]).toHaveTextContent("sync.deletedAttachments.restoredBy");
    expect(rows[0]).toHaveTextContent("mistake");
    expect(within(rows[0]!).getByTestId("current-7")).toHaveTextContent("sync.deletedAttachments.current.live");
    expect(within(rows[0]!).getByRole("button", { name: "sync.deletedAttachments.restore" })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("sync.deletedAttachments.prior.already_deleted");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(rows[2]).toHaveTextContent("sync.deletedAttachments.state.replacedByRestore");
    expect(rows[2]).toHaveTextContent("sync.deletedAttachments.byOperator");
    expect(listDeletedAttachments).toHaveBeenCalledWith("tenant_1", {
      view: "kept",
      since: undefined,
      entity_sync_id: undefined,
      limit: 100,
      cursor: undefined,
    });
  });

  it("the view, the period and the item search reload the list", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue(page([]));
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await screen.findByText("sync.deletedAttachments.empty");
    const lastQuery = () => vi.mocked(listDeletedAttachments).mock.calls.at(-1)![1]!;
    await userEvent.selectOptions(screen.getByLabelText("sync.deletedAttachments.view.label"), "nothing_kept");
    await waitFor(() => expect(lastQuery().view).toBe("nothing_kept"));
    await userEvent.selectOptions(screen.getByLabelText("sync.deletedAttachments.period.label"), "7");
    await waitFor(() => expect(typeof lastQuery().since).toBe("string"));
    await userEvent.type(screen.getByLabelText("sync.deletedAttachments.search.label"), "media-42");
    await userEvent.click(screen.getByRole("button", { name: "sync.deletedAttachments.search.submit" }));
    await waitFor(() => expect(lastQuery().entity_sync_id).toBe("media-42"));
  });

  it("deletes of items the server never held are counted per device, not listed, and can be shown", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue(
      page([entry()], {
        nothing_kept_summary: [{ machine_fingerprint: "fp-rogue", license_id: "lic_1", entity_type: "media_attachments", count: 1240, last_at: "2026-10-20T10:00:00Z" }],
      }),
    );
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    const summary = await screen.findByTestId("nothing-kept-summary");
    expect(summary).toHaveTextContent("sync.deletedAttachments.nothingKept.summary");
    await userEvent.click(within(summary).getByRole("button", { name: "sync.deletedAttachments.nothingKept.show" }));
    await waitFor(() => expect(vi.mocked(listDeletedAttachments).mock.calls.at(-1)![1]!.view).toBe("nothing_kept"));
  });

  it("Load more fetches the next page with the cursor and appends it", async () => {
    vi.mocked(listDeletedAttachments)
      .mockResolvedValueOnce(page([entry()], { next_cursor: "cur-1" }))
      .mockResolvedValueOnce(page([entry({ id: "8", entity_sync_id: "media-2" })]));
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "sync.deletedAttachments.loadMore" }));
    const table = await screen.findByTestId("deleted-attachments");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    expect(vi.mocked(listDeletedAttachments).mock.calls.at(-1)![1]!.cursor).toBe("cur-1");
    expect(screen.queryByRole("button", { name: "sync.deletedAttachments.loadMore" })).toBeNull();
  });

  it("after a refusal, confirming again sends the state of the reloaded list", async () => {
    const newer = { row_version: 5, payload_hash: "c".repeat(64), deleted: false };
    vi.mocked(listDeletedAttachments)
      .mockResolvedValueOnce(page([entry()]))
      .mockResolvedValueOnce(page([entry({ current: newer })]))
      .mockResolvedValue(page([entry({ current: newer })]));
    vi.mocked(restoreDeletedAttachment).mockRejectedValueOnce(new Error("changed since the listing")).mockResolvedValueOnce();
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await restoreFirstRow();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("changed since the listing");
    await userEvent.click(within(dialog).getByRole("button", { name: "sync.deletedAttachments.restoreConfirm" }));
    await waitFor(() => expect(restoreDeletedAttachment).toHaveBeenCalledTimes(2));
    expect(vi.mocked(restoreDeletedAttachment).mock.calls[0]![2]).toEqual(CURRENT);
    expect(vi.mocked(restoreDeletedAttachment).mock.calls[1]![2]).toEqual(newer);
  });

  it("restore sends the listed current state, a reason and a sync_attachment_restore code, then reloads", async () => {
    vi.mocked(listDeletedAttachments)
      .mockResolvedValueOnce(page([entry()]))
      .mockResolvedValueOnce(page([
        entry({ restores: [{ at: "2026-10-20T09:00:00Z", by: "user_1", reason: "deleted by mistake", audit_record_id: "rec_1", row_version: 3 }] }),
      ]));
    vi.mocked(restoreDeletedAttachment).mockResolvedValue();
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await restoreFirstRow();
    await waitFor(() =>
      expect(restoreDeletedAttachment).toHaveBeenCalledWith("tenant_1", "7", CURRENT, {
        reason_code: "deleted by mistake",
        step_up_token: "stepup-sync_attachment_restore",
      }),
    );
    expect(requestStepUp).toHaveBeenCalledWith("sync_attachment_restore", "123456");
    expect(await screen.findByText("sync.deletedAttachments.restored")).toBeInTheDocument();
    expect(await screen.findByText(/sync.deletedAttachments.restoredBy/)).toBeInTheDocument();
    // Still restorable: an entry can be restored again later.
    expect(screen.getByRole("button", { name: "sync.deletedAttachments.restore" })).toBeInTheDocument();
  });

  it("a refused restore stays in the dialog with the reason and reloads the list", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue(page([entry()]));
    vi.mocked(restoreDeletedAttachment).mockRejectedValue(new Error("changed since the listing"));
    renderWithConsole(<DeletedAttachmentsPanel tenantId="tenant_1" />);
    await restoreFirstRow();
    expect(await within(await screen.findByRole("dialog")).findByRole("alert")).toHaveTextContent("changed since the listing");
    expect(listDeletedAttachments).toHaveBeenCalledTimes(2);
  });

  it("shows the server file copy and the companion Photo or file entry", async () => {
    vi.mocked(listDeletedAttachments).mockResolvedValue(page([
      entry({
        id: "11",
        entity_type: "asset_photos",
        entity_sync_id: "photo-1",
        change_kind: "overwrite",
        file_on_server: true,
        companion: { entity_sync_id: "media-photo-1", archive_id: "12", live: false, file_on_server: true },
      }),
      entry({ id: "12", entity_sync_id: "media-photo-1", file_on_server: false }),
    ]));
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
});

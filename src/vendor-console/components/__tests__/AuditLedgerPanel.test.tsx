import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/vendor-audit-support-service", () => ({
  listAuditLedger: vi.fn(),
  verifyAuditLedgerChainRemote: vi.fn(),
  downloadAuditLedgerCsv: vi.fn(),
}));

import type { AuditRecord } from "@/services/vendor-audit-support-service";
import { downloadAuditLedgerCsv, listAuditLedger, verifyAuditLedgerChainRemote } from "@/services/vendor-audit-support-service";
import { ApiRequestError } from "@/lib/api-error";
import { AuditLedgerPanel } from "../AuditLedgerPanel";
import { renderWithConsole } from "./renderWithConsole";

const record: AuditRecord = {
  record_id: "aud-0001",
  sequence: 41,
  occurred_at_rfc3339: "2026-10-12T10:00:00Z",
  actor_id: "user_1",
  action_code: "machine_slot_release",
  action_category: "machine",
  correlation_id: "corr-9",
  scope_tenant_id: "tenant-acme",
  before_snapshot_sha256: null,
  after_snapshot_sha256: null,
  payload_canonical_sha256: "a".repeat(64),
  chain_prev_hash: "b".repeat(64),
  record_integrity_sha256: "c".repeat(64),
  reason_code: "laptop stolen",
  approval_correlation_id: null,
  entity_refs: { tenant_id: "tenant-acme", machine_id: "fp-1" },
};

describe("AuditLedgerPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the server's records and opens one with its reason and references", async () => {
    vi.mocked(listAuditLedger).mockResolvedValue([record]);
    renderWithConsole(<AuditLedgerPanel />);
    expect(await screen.findByText("machine_slot_release")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("aud-0001")).toBeInTheDocument();
    expect(within(sheet).getByText(/laptop stolen/)).toBeInTheDocument();
    expect(within(sheet).getByText(/fp-1/)).toBeInTheDocument();
  });

  it("searches on the server", async () => {
    vi.mocked(listAuditLedger).mockResolvedValue([record]);
    renderWithConsole(<AuditLedgerPanel />);
    await screen.findByText("machine_slot_release");
    await userEvent.type(screen.getByPlaceholderText("record, actor, correlation, tenant…"), "corr-9");
    await waitFor(() =>
      expect(listAuditLedger).toHaveBeenLastCalledWith({ q: "corr-9", category: "all", limit: 500 }),
    );
  });

  it("reports the server's chain verification, including a broken chain", async () => {
    vi.mocked(listAuditLedger).mockResolvedValue([record]);
    vi.mocked(verifyAuditLedgerChainRemote)
      .mockResolvedValueOnce({ status: "ok", checked_count: 41 })
      .mockResolvedValueOnce({ status: "chain_broken", checked_count: 41 });
    renderWithConsole(<AuditLedgerPanel />);
    await screen.findByText("machine_slot_release");
    const verify = screen.getByRole("button", { name: "Verify sample chain" });
    await userEvent.click(verify);
    expect(await screen.findByText("Chain OK")).toBeInTheDocument();
    await userEvent.click(verify);
    expect(await screen.findByText("Chain / integrity issue")).toBeInTheDocument();
  });

  it("explains a refused export", async () => {
    vi.mocked(listAuditLedger).mockResolvedValue([record]);
    vi.mocked(downloadAuditLedgerCsv).mockRejectedValue(new ApiRequestError(403, "permission_denied", null));
    renderWithConsole(<AuditLedgerPanel />);
    await screen.findByText("machine_slot_release");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your role does not allow this action.");
  });
});

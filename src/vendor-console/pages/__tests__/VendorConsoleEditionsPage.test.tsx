import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";

vi.mock("@/services/license-control-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/license-control-service")>()),
  listEditions: vi.fn(),
  createEdition: vi.fn(),
  updateEdition: vi.fn(),
  deleteEdition: vi.fn(),
}));

import { ApiRequestError } from "@/lib/api-error";
import {
  deleteEdition,
  listEditions,
  MODULE_CAPABILITY_KEYS,
  updateEdition,
  type CapabilitiesMap,
  type EditionCatalogEntry,
} from "@/services/license-control-service";
import { VendorConsoleEditionsPage } from "../VendorConsoleEditionsPage";

const caps = (enabled: string[]): CapabilitiesMap =>
  Object.fromEntries(MODULE_CAPABILITY_KEYS.map((k) => [k, enabled.includes(k)])) as CapabilitiesMap;

const core: EditionCatalogEntry = { id: "core", label: "Core", capabilities: caps(["equipment"]), is_system: true, row_version: 1 };
const custom: EditionCatalogEntry = {
  id: "field-ops",
  label: "Field operations",
  capabilities: caps(["equipment", "work_orders"]),
  is_system: false,
  row_version: 4,
};

const rowOf = async (id: string) => (await screen.findByText(id)).closest("tr") as HTMLElement;

describe("VendorConsoleEditionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEditions).mockResolvedValue([core, custom]);
  });

  it("lists the catalog; built-in editions cannot be deleted", async () => {
    render(<VendorConsoleEditionsPage />);
    const coreRow = await rowOf("core");
    expect(within(coreRow).getByText("System")).toBeInTheDocument();
    expect(within(coreRow).queryByRole("button", { name: "Delete edition" })).not.toBeInTheDocument();
    const customRow = await rowOf("field-ops");
    expect(within(customRow).getByText("equipment, work_orders")).toBeInTheDocument();
    expect(within(customRow).getByRole("button", { name: "Delete edition" })).toBeInTheDocument();
  });

  it("saves an edit with the version it was read at (another operator's change is refused)", async () => {
    vi.mocked(updateEdition).mockResolvedValue({ ...custom, label: "Field ops", row_version: 5 });
    render(<VendorConsoleEditionsPage />);
    await userEvent.click(within(await rowOf("field-ops")).getByRole("button", { name: "Edit edition" }));
    const dialog = await screen.findByRole("dialog");
    const label = within(dialog).getByLabelText("Label");
    await userEvent.clear(label);
    await userEvent.type(label, "Field ops");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateEdition).toHaveBeenCalledWith("field-ops", {
        label: "Field ops",
        capabilities: custom.capabilities,
        expected_row_version: 4,
      }),
    );
    expect(await screen.findByText(/Edition field-ops saved/)).toBeInTheDocument();
  });

  it("explains why an edition still in use cannot be deleted", async () => {
    vi.mocked(deleteEdition).mockRejectedValue(new ApiRequestError(409, "edition_in_use", "Edition is assigned"));
    render(<VendorConsoleEditionsPage />);
    await userEvent.click(within(await rowOf("field-ops")).getByRole("button", { name: "Delete edition" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(deleteEdition).toHaveBeenCalledWith("field-ops");
    expect(await screen.findByText("This edition is still assigned to customers (including inactive ones).")).toBeInTheDocument();
  });
});

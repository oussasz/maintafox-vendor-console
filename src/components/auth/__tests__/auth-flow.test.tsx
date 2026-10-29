import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/test/i18n";


vi.mock("@/services/admin-permissions", async () => {
  const actual = await vi.importActual<typeof import("@/services/admin-permissions")>(
    "@/services/admin-permissions",
  );
  return {
    ...actual,
    fetchMyPermissions: vi.fn(),
  };
});

const sessionEnded = new Set<() => void>();
vi.mock("@/lib/auth-session", () => ({
  ensureAccessToken: vi.fn(),
  endSession: vi.fn(() => sessionEnded.forEach((l) => l())),
  onSessionEnded: vi.fn((listener: () => void) => {
    sessionEnded.add(listener);
    return () => sessionEnded.delete(listener);
  }),
}));

import { AuthGuard } from "@/components/auth/AuthGuard";
import { PermissionRoute } from "@/components/auth/PermissionRoute";
import { endSession, ensureAccessToken } from "@/lib/auth-session";
import {
  AuthenticationRequiredError,
  PermissionsLoadError,
  fetchMyPermissions,
} from "@/services/admin-permissions";

const fullPerms = [
  {
    name: "console.view",
    description: "console.view",
    category: "vendor",
    is_dangerous: false,
    requires_step_up: false,
  },
];

function renderConsoleTree(initialPath = "/vendor-console") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>Login screen</div>} />
        <Route element={<AuthGuard />}>
          <Route path="/" element={<Navigate to="/vendor-console" replace />} />
          <Route path="/vendor-console" element={<PermissionRoute permission="console.view" />}>
            <Route index element={<div>Console home</div>} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("auth-before-authz flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionEnded.clear();
  });

  it("redirects to login when there is no session (refresh cookie refused)", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue(null);
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByText("Console home")).not.toBeInTheDocument();
    expect(screen.queryByText(/necessary permissions/i)).not.toBeInTheDocument();
  });

  it("redirects to login and ends the session when permissions API returns 401", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockRejectedValue(
      new AuthenticationRequiredError(401, "invalid_token"),
    );
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(endSession).toHaveBeenCalled();
    expect(screen.queryByText(/necessary permissions/i)).not.toBeInTheDocument();
  });

  it("allows authenticated admin with console.view into the console", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockResolvedValue(fullPerms);
    renderConsoleTree();
    expect(await screen.findByText("Console home")).toBeInTheDocument();
  });

  it("shows Access Denied when authenticated with empty permissions", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockResolvedValue([]);
    renderConsoleTree();
    expect(await screen.findByText(/Access denied/i)).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("Console home")).not.toBeInTheDocument();
  });

  it("shows retry panel (not Access Denied) on permissions load failure", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockRejectedValue(
      new PermissionsLoadError("network"),
    );
    renderConsoleTree();
    expect(await screen.findByText(/Unable to verify permissions/i)).toBeInTheDocument();
    expect(screen.queryByText(/necessary permissions/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();

    vi.mocked(fetchMyPermissions).mockResolvedValue(fullPerms);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.getByText("Console home")).toBeInTheDocument();
    });
  });

  it("does not load permissions without a session", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue(null);
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(fetchMyPermissions).not.toHaveBeenCalled();
  });

  it("sends the operator to login when the API cannot be reached", async () => {
    vi.mocked(ensureAccessToken).mockRejectedValue(new TypeError("Failed to fetch"));
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
  });

  it("returns to login when the session ends while the console is open", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockResolvedValue(fullPerms);
    renderConsoleTree();
    expect(await screen.findByText("Console home")).toBeInTheDocument();
    act(() => {
      sessionEnded.forEach((listener) => listener());
    });
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
  });
});

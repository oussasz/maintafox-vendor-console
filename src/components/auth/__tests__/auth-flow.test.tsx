import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/services/admin-permissions", async () => {
  const actual = await vi.importActual<typeof import("@/services/admin-permissions")>(
    "@/services/admin-permissions",
  );
  return {
    ...actual,
    fetchMyPermissions: vi.fn(),
  };
});

vi.mock("@/lib/auth-token", () => ({
  getAccessToken: vi.fn(),
  getValidLookingAccessToken: vi.fn(),
  setAccessToken: vi.fn(),
  looksLikeJwt: (token: string) => token.split(".").length === 3,
}));

import { AuthGuard } from "@/components/auth/AuthGuard";
import { PermissionRoute } from "@/components/auth/PermissionRoute";
import { getValidLookingAccessToken, setAccessToken } from "@/lib/auth-token";
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
  });

  it("redirects anonymous users (no token) to login", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue(null);
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByText("Console home")).not.toBeInTheDocument();
    expect(screen.queryByText(/necessary permissions/i)).not.toBeInTheDocument();
  });

  it("redirects to login and clears token when permissions API returns 401", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockRejectedValue(
      new AuthenticationRequiredError("Authentication required", 401, "invalid_token"),
    );
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(setAccessToken).toHaveBeenCalledWith(null);
    expect(screen.queryByText(/necessary permissions/i)).not.toBeInTheDocument();
  });

  it("allows authenticated admin with console.view into the console", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockResolvedValue(fullPerms);
    renderConsoleTree();
    expect(await screen.findByText("Console home")).toBeInTheDocument();
  });

  it("shows Access Denied when authenticated with empty permissions", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockResolvedValue([]);
    renderConsoleTree();
    expect(await screen.findByText(/Access denied/i)).toBeInTheDocument();
    expect(screen.queryByText("Login screen")).not.toBeInTheDocument();
    expect(screen.queryByText("Console home")).not.toBeInTheDocument();
  });

  it("shows retry panel (not Access Denied) on permissions load failure", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue("hdr.payload.sig");
    vi.mocked(fetchMyPermissions).mockRejectedValue(
      new PermissionsLoadError("Network error while loading permissions."),
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

  it("redirects invalid (non-JWT-shaped) tokens to login without calling the API", async () => {
    vi.mocked(getValidLookingAccessToken).mockReturnValue(null);
    renderConsoleTree();
    expect(await screen.findByText("Login screen")).toBeInTheDocument();
    expect(fetchMyPermissions).not.toHaveBeenCalled();
  });
});

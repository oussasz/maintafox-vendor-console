import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-token", () => ({
  getAccessToken: vi.fn(),
  setAccessToken: vi.fn(),
}));

import { getAccessToken } from "@/lib/auth-token";
import {
  AuthenticationRequiredError,
  PermissionsLoadError,
  fetchMyPermissions,
  isAuthenticationRequiredError,
  isPermissionsLoadError,
} from "../admin-permissions";

const samplePerm = {
  name: "console.view",
  description: "console.view",
  category: "vendor",
  is_dangerous: false,
  requires_step_up: false,
};

describe("fetchMyPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VITE_ADMIN_API_BASE_URL", "https://api.example.test");
    vi.mocked(getAccessToken).mockReturnValue("hdr.payload.sig");
    vi.unstubAllGlobals();
  });

  it("throws AuthenticationRequiredError when no token", async () => {
    vi.mocked(getAccessToken).mockReturnValue(null);
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("throws PermissionsLoadError when API base is missing", async () => {
    vi.stubEnv("VITE_ADMIN_API_BASE_URL", "");
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(PermissionsLoadError);
  });

  it("throws AuthenticationRequiredError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({ error: "invalid_token" }),
        }),
      }),
    );
    await expect(fetchMyPermissions()).rejects.toSatisfy(
      (err: unknown) =>
        isAuthenticationRequiredError(err) && err.code === "invalid_token" && err.status === 401,
    );
  });

  it("throws AuthenticationRequiredError on 403 invalid_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        clone: () => ({
          json: async () => ({ error: "invalid_token" }),
        }),
      }),
    );
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("throws PermissionsLoadError on 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        clone: () => ({
          json: async () => ({ error: "server_error" }),
        }),
      }),
    );
    await expect(fetchMyPermissions()).rejects.toSatisfy(
      (err: unknown) => isPermissionsLoadError(err) && err.status === 500,
    );
  });

  it("throws PermissionsLoadError on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(PermissionsLoadError);
  });

  it("returns parsed permissions on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [samplePerm],
      }),
    );
    await expect(fetchMyPermissions()).resolves.toEqual([samplePerm]);
  });
});

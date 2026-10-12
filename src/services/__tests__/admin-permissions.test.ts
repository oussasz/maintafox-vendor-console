import { beforeEach, describe, expect, it, vi } from "vitest";

// The real api-client runs; only the in-memory session is controlled here.
vi.mock("@/lib/auth-session", () => ({
  ensureAccessToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  endSession: vi.fn(),
}));

import { endSession, ensureAccessToken, refreshAccessToken } from "@/lib/auth-session";
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
    vi.mocked(ensureAccessToken).mockResolvedValue("hdr.payload.sig");
    vi.mocked(refreshAccessToken).mockResolvedValue(false);
    vi.unstubAllGlobals();
  });

  it("throws AuthenticationRequiredError when there is no session", async () => {
    vi.mocked(ensureAccessToken).mockResolvedValue(null);
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(endSession).toHaveBeenCalled();
  });

  it("throws PermissionsLoadError when API base is missing", async () => {
    vi.stubEnv("VITE_ADMIN_API_BASE_URL", "");
    await expect(fetchMyPermissions()).rejects.toBeInstanceOf(PermissionsLoadError);
  });

  it("throws AuthenticationRequiredError on 401 when the refresh is refused", async () => {
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
        isAuthenticationRequiredError(err) && err.code === "session_ended" && err.status === 401,
    );
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retries once with a renewed token after a 401", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(true);
    vi.mocked(ensureAccessToken).mockResolvedValueOnce("old.token.sig").mockResolvedValueOnce("new.token.sig");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, clone: () => ({ json: async () => ({ error: "session_ended" }) }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [samplePerm] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMyPermissions()).resolves.toEqual([samplePerm]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer new.token.sig" });
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

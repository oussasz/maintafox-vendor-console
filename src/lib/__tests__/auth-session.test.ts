import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fresh module per test: the session lives in module memory. */
async function loadSession() {
  vi.resetModules();
  return import("@/lib/auth-session");
}

function refreshResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 401, json: async () => body } as Response;
}

describe("auth-session", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_API_BASE_URL", "https://api.example.test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps the access token in memory only and removes the pre-4.1 localStorage token", async () => {
    localStorage.setItem("maintafox:vendor:access_token", "old.long.lived");
    const session = await loadSession();
    expect(localStorage.getItem("maintafox:vendor:access_token")).toBeNull();
    session.setSession("a.b.c", 900);
    expect(session.getAccessToken()).toBe("a.b.c");
    expect(localStorage.length).toBe(0);
  });

  it("exchanges the refresh cookie (credentials: include) and shares one request between callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(refreshResponse({ access_token: "new.tok.en", expires_in: 900 }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await loadSession();
    const [a, b] = await Promise.all([session.ensureAccessToken(), session.ensureAccessToken()]);
    expect(a).toBe("new.tok.en");
    expect(b).toBe("new.tok.en");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("serialises refreshes across tabs with the Web Locks API", async () => {
    const request = vi.fn(async (_name: string, cb: () => Promise<boolean>) => cb());
    vi.stubGlobal("navigator", { ...navigator, locks: { request } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refreshResponse({ access_token: "x.y.z", expires_in: 900 })));
    const session = await loadSession();
    await session.refreshAccessToken();
    expect(request).toHaveBeenCalledWith("maintafox-vendor-refresh", expect.any(Function));
  });

  it("reuses a token with time left and refreshes one about to expire", async () => {
    const fetchMock = vi.fn().mockResolvedValue(refreshResponse({ access_token: "renewed.t.k", expires_in: 900 }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await loadSession();
    session.setSession("fresh.t.k", 900);
    expect(await session.ensureAccessToken()).toBe("fresh.t.k");
    expect(fetchMock).not.toHaveBeenCalled();
    session.setSession("ending.t.k", 10);
    expect(await session.ensureAccessToken()).toBe("renewed.t.k");
  });

  it("reports no session when the refresh is refused, and tells listeners when it ends", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refreshResponse({ error: "session_ended" }, false)));
    const session = await loadSession();
    expect(await session.ensureAccessToken()).toBeNull();
    const listener = vi.fn();
    const off = session.onSessionEnded(listener);
    session.setSession("a.b.c", 900);
    session.endSession();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getAccessToken()).toBeNull();
    off();
    session.endSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/api-client";
import { ApiRequestError } from "@/lib/api-error";
import {
  createPublisherKey,
  listReleases,
  publishRelease,
  recallRelease,
  releaseStatus,
  ringsAllowedFrom,
  type Release,
} from "@/services/release-catalog-service";

const release: Release = {
  release_id: "rel_1",
  version: "2.1.0",
  state: "registered",
  notes_en: "Fixes",
  notes_fr: "Corrections",
  channel: "internal",
  rollout_percent: 100,
  code_signed: true,
  git_commit: "abc1234",
  registered_by: "release_publisher:rpk_1",
  registered_at: "2026-10-10T08:00:00.000Z",
  published_at: "2026-10-11T08:00:00.000Z",
  updated_at: "2026-10-11T08:00:00.000Z",
  recalled_at: null,
  recalled_reason: null,
  recalled_by: null,
  artifacts: [],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function lastCall() {
  const [path, init] = vi.mocked(authFetch).mock.calls.at(-1)!;
  return { path, init: init!, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) as unknown };
}

describe("release-catalog-service", () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it("lists releases newest first", async () => {
    const older = { ...release, release_id: "rel_0", version: "2.0.0", registered_at: "2026-09-01T08:00:00.000Z" };
    vi.mocked(authFetch).mockResolvedValue(json(200, [older, release]));
    expect((await listReleases()).map((r) => r.version)).toEqual(["2.1.0", "2.0.0"]);
  });

  it("publish sends the ring, the percentage, the reason, the step-up token and an idempotency key", async () => {
    vi.mocked(authFetch).mockResolvedValue(json(200, { ...release, channel: "pilot", rollout_percent: 25, audit_record_id: "aud_1" }));
    const out = await publishRelease("rel_1", { channel: "pilot", rollout_percent: 25 }, { reason_code: "pilot wave", step_up_token: "su_1" });
    const call = lastCall();
    expect(call.path).toBe("/api/v1/releases/rel_1/publish");
    expect(call.init.method).toBe("POST");
    expect(call.body).toEqual({ channel: "pilot", rollout_percent: 25 });
    expect(call.headers["X-Operator-Reason"]).toBe("pilot wave");
    expect(call.headers["X-Step-Up-Token"]).toBe("su_1");
    expect(call.headers["Idempotency-Key"]).toMatch(/^release-publish-/);
    expect(out.channel).toBe("pilot");
  });

  it("a refused narrowing comes back as the API's code", async () => {
    vi.mocked(authFetch).mockResolvedValue(json(409, { error: "channel_narrowing_refused", channel: "stable" }));
    const err = await publishRelease("rel_1", { channel: "internal", rollout_percent: 10 }, { reason_code: "oops", step_up_token: "su_1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe("channel_narrowing_refused");
  });

  it("recall sends the reason in the body and the headers", async () => {
    vi.mocked(authFetch).mockResolvedValue(json(200, { ...release, recalled_at: "2026-10-12T08:00:00.000Z", recalled_reason: "crash", recalled_by: "op_1" }));
    await recallRelease("rel_1", { reason_code: "crash on start", step_up_token: "su_2" });
    const call = lastCall();
    expect(call.path).toBe("/api/v1/releases/rel_1/recall");
    expect(call.body).toEqual({ reason: "crash on start" });
    expect(call.headers["X-Step-Up-Token"]).toBe("su_2");
    expect(call.headers["X-Operator-Reason"]).toBe("crash on start");
  });

  it("a created publisher key carries its one-time token", async () => {
    vi.mocked(authFetch).mockResolvedValue(
      json(201, {
        key_id: "rpk_1",
        label: "desktop repo",
        created_at: "2026-10-12T08:00:00.000Z",
        created_by: "op_1",
        last_used_at: null,
        revoked_at: null,
        revoked_by: null,
        token: "mfxrp_secret",
        audit_record_id: "aud_2",
      }),
    );
    const key = await createPublisherKey("desktop repo", { reason_code: "CI setup", step_up_token: "su_3" });
    expect(key.token).toBe("mfxrp_secret");
    expect(lastCall().body).toEqual({ label: "desktop repo" });
  });

  it("derives the status and the rings a release may still be published to", () => {
    expect(releaseStatus({ state: "uploading", channel: null, recalled_at: null })).toBe("uploading");
    expect(releaseStatus({ state: "registered", channel: null, recalled_at: null })).toBe("draft");
    expect(releaseStatus({ state: "registered", channel: "pilot", recalled_at: null })).toBe("pilot");
    expect(releaseStatus({ state: "registered", channel: "pilot", recalled_at: "2026-10-12T08:00:00.000Z" })).toBe("recalled");
    expect(ringsAllowedFrom(null)).toEqual(["internal", "pilot", "stable"]);
    expect(ringsAllowedFrom("pilot")).toEqual(["pilot", "stable"]);
  });
});

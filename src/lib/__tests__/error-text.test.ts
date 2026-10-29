import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import "@/test/i18n";
import { i18n } from "@/i18n/config";
import { SessionEndedError } from "@/lib/api-client";
import { apiRequestError, ApiRequestError } from "@/lib/api-error";
import { errorText } from "@/lib/error-text";

const refusal = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("errorText", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates a known API refusal code, in the current language", async () => {
    const err = await apiRequestError(refusal(409, { error: "slot_limit_reached", message: "server text", max_machines: 2 }));
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(errorText(err)).toBe("Activation slot limit reached for this licence.");
    await i18n.changeLanguage("fr");
    expect(errorText(err)).toBe("Limite de postes d'activation atteinte pour cette licence.");
  });

  it("translates a phone refused on a licence without mobile devices", async () => {
    const err = await apiRequestError(
      refusal(409, { error: "mobile_not_licensed", device_class: "mobile", max_mobile_devices: 0 }),
    );
    expect(err.params).toEqual({ max: 0 });
    expect(errorText(err)).toBe(
      "This licence does not include mobile devices. Set a number of mobile devices on the licence first.",
    );
    await i18n.changeLanguage("fr");
    expect(errorText(err)).toBe(
      "Cette licence n’inclut pas d’appareils mobiles. Indiquez d’abord un nombre d’appareils mobiles sur la licence.",
    );
  });

  it("explains a step-up refusal by its reason", async () => {
    const err = await apiRequestError(
      refusal(403, { error: "privileged_action_guard_failed", reason: "step_up_action_kind_mismatch" }),
    );
    expect(errorText(err)).toBe("The authenticator confirmation was for another action. Confirm again.");
  });

  it("shows the server's own message for a code the console does not know", async () => {
    const err = await apiRequestError(refusal(422, { error: "brand_new_code", message: "Explained by the server." }));
    expect(errorText(err)).toBe("Explained by the server.");
  });

  it("names the HTTP status when the answer has no body", async () => {
    const err = await apiRequestError(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(errorText(err)).toBe("The request failed (HTTP 502).");
  });

  it("distinguishes an ended session, an unreachable API and an unreadable answer", () => {
    expect(errorText(new SessionEndedError())).toBe("Your session has ended. Sign in again.");
    expect(errorText(new TypeError("Failed to fetch"))).toBe(
      "The control API cannot be reached. Check the connection and try again.",
    );
    const parsed = z.object({ id: z.string() }).safeParse({ id: 1 });
    expect(parsed.success).toBe(false);
    expect(errorText(parsed.error)).toBe(
      "The control API sent an unexpected answer. Refresh the page; if it persists, report it.",
    );
  });
});

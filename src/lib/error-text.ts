/**
 * What the operator reads when something fails, in the console's current language: a known API
 * refusal code is translated (common.json `errors.codes.*`), otherwise the server's own explanation
 * is shown as sent; a lost connection, an unexpected answer and an ended session have their own
 * texts. A plain function (not a hook) so loaders can use it without re-running on language change.
 */
import i18n from "i18next"; // the instance src/i18n/config.ts initialises (no React binding needed)
import { ZodError } from "zod";

import { ApiRequestError } from "@/lib/api-error";
import { SessionEndedError } from "@/lib/api-client";

export function errorText(err: unknown): string {
  if (err instanceof SessionEndedError) return i18n.t("common:errors.sessionEnded");
  if (err instanceof ApiRequestError) {
    if (err.code === "privileged_action_guard_failed" && typeof err.params.reason === "string") {
      const reasonKey = `common:errors.guard.${err.params.reason}`;
      if (i18n.exists(reasonKey)) return i18n.t(reasonKey);
    }
    if (err.code) {
      const key = `common:errors.codes.${err.code}`;
      if (i18n.exists(key)) return i18n.t(key, { ...err.params, status: err.status });
    }
    return err.serverMessage ?? i18n.t("common:errors.requestFailed", { status: err.status });
  }
  if (err instanceof ZodError) return i18n.t("common:errors.invalidResponse");
  // fetch() rejects with a TypeError when the API cannot be reached.
  if (err instanceof TypeError) return i18n.t("common:errors.network");
  if (err instanceof Error && err.message) return err.message;
  return i18n.t("common:errors.unexpected");
}

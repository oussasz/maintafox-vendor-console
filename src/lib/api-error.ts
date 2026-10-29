/**
 * A refusal of the control API, kept as data (status, code, the server's own message) so the
 * console shows it in the operator's language at display time (`useErrorText`).
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    /** The API's `error` code (e.g. `slot_limit_reached`), when it sent one. */
    readonly code: string | null,
    /** The API's own explanation (`message` or `detail`), shown when the code has no translation. */
    readonly serverMessage: string | null,
    /** Values a translation can use (e.g. `max` for `slot_limit_reached`, `reason` for a guard refusal). */
    readonly params: Record<string, string | number> = {},
  ) {
    super(serverMessage ?? code ?? `HTTP ${status}`);
    this.name = "ApiRequestError";
  }
}

type ErrorBody = {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
  reason?: unknown;
  max_machines?: unknown;
  max_mobile_devices?: unknown;
};

/** Reads a non-OK response of the control API into an `ApiRequestError`. */
export async function apiRequestError(res: Response): Promise<ApiRequestError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    return new ApiRequestError(res.status, null, null);
  }
  const code = typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
  const detail =
    typeof body.detail === "string"
      ? body.detail.trim()
      : Array.isArray(body.detail)
        ? body.detail.map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d))).join(" ")
        : "";
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : detail || null;
  const params: Record<string, string | number> = {};
  if (typeof body.reason === "string") params.reason = body.reason;
  if (typeof body.max_machines === "number") params.max = body.max_machines;
  if (typeof body.max_mobile_devices === "number") params.max = body.max_mobile_devices;
  return new ApiRequestError(res.status, code, message, params);
}

/** Throws the API's refusal when the response is not OK. */
export async function throwIfNotOk(res: Response): Promise<void> {
  if (!res.ok) throw await apiRequestError(res);
}

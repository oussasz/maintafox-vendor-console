import type { Tone } from "./kit";

/** Colour of a customer's standing (codes from GET /api/v1/console/overview). */
const STATUS_TONE: Record<string, Tone> = {
  active: "ok",
  expires_soon: "attention",
  expired: "danger",
  not_activated: "neutral",
  no_licence: "neutral",
  suspended: "danger",
};

export const KNOWN_CUSTOMER_STATUSES = Object.keys(STATUS_TONE);

export function customerStatusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

/** Translation key of a status; an unknown code (newer server) reads "Unknown". */
export function customerStatusKey(status: string): string {
  return status in STATUS_TONE ? `customers.status.${status}` : "customers.status.unknown";
}

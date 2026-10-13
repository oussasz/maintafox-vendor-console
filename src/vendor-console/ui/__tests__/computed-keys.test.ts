// @vitest-environment node
/**
 * Texts whose key is computed at run time (attention kinds, statuses, tabs) exist in English and
 * French: the static guard (src/i18n/__tests__/translations.test.ts) cannot see them.
 */
import { describe, expect, it } from "vitest";

import "@/test/i18n";
import { i18n } from "@/i18n/config";

import { ATTENTION_KINDS } from "../AttentionList";
import { KNOWN_CUSTOMER_STATUSES } from "../customer-status";

const keys = [
  ...[...ATTENTION_KINDS, "unknown"].flatMap((k) => [`attention.${k}.title`, `attention.${k}.detail`]),
  ...[...KNOWN_CUSTOMER_STATUSES, "unknown"].map((s) => `customers.status.${s}`),
  ...["overview", "licence", "sync", "support", "history"].map((x) => `customer.tabs.${x}`),
  ...["online", "lastSeen", "notSeenDays", "neverSeen", "released", "blocked", "licenceRevoked"].map((s) => `devices.status.${s}`),
  ...["new", "triaged", "waiting_for_vendor", "waiting_for_customer", "resolved", "closed"].map((s) => `customer.support.state.${s}`),
  ...["ok", "slow", "down", "unknown"].map((s) => `sysHealth.dbState.${s}`),
  ...["ok", "not_configured", "unreachable", "unknown"].map((s) => `sysHealth.storageState.${s}`),
  ...["stable", "pilot", "internal"].map((c) => `customers.form.channels.${c}`),
  ...["keys", "editions", "payments"].map((x) => `licences.tabs.${x}`),
  ...["devices", "sync", "test"].map((x) => `devices.tabs.${x}`),
  ...["team", "audit", "safeguards"].map((x) => `settings.tabs.${x}`),
  ...["inherit", "off", "required", "emergency"].map((m) => `customers.policy.modes.${m}`),
];

describe("computed translation keys", () => {
  it.each(["en", "fr"])("all exist in %s", (lng) => {
    const missing = keys.filter((k) => !i18n.exists(`vendorConsole:${k}`, { lng, count: 2 }) && !i18n.exists(`vendorConsole:${k}`, { lng }));
    expect(missing).toEqual([]);
  });
});

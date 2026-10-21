/**
 * "Needs your attention": each item the server found, in plain words, with one action.
 */
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import type { AttentionItem } from "@/services/console-dashboard-service";

import { formatAgo, formatDate } from "./format";
import { Dot, EmptyState, type Tone } from "./kit";

/** Every kind the server sends today (an unknown one reads "Something needs a look"). */
export const ATTENTION_KINDS = [
  "backup_failed",
  "backup_late",
  "restore_test_failed",
  "restore_test_overdue",
  "licence_expired",
  "licence_expiring",
  "device_not_syncing",
  "device_never_synced",
  "ticket_new",
  "ticket_new_with_file",
] as const;
const KNOWN_KINDS = new Set<string>(ATTENTION_KINDS);

const toneOf = (severity: string): Tone => (severity === "critical" ? "danger" : severity === "warn" ? "attention" : "info");

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** Where the item's one action leads. */
function actionOf(item: AttentionItem): { labelKey: string; to: string } {
  const customer = item.tenant_id ? `/vendor-console/customers/${encodeURIComponent(item.tenant_id)}` : "/vendor-console/customers";
  switch (item.kind) {
    case "licence_expired":
    case "licence_expiring":
      return { labelKey: "attention.action.renew", to: `${customer}?tab=licence` };
    case "device_not_syncing":
    case "device_never_synced":
      return { labelKey: "attention.action.viewDevice", to: `${customer}?tab=sync&device=${encodeURIComponent(str(item.facts.machine_id))}` };
    case "ticket_new":
    case "ticket_new_with_file":
      return { labelKey: "attention.action.openTicket", to: `/vendor-console/support?ticket=${encodeURIComponent(str(item.facts.ticket_id))}` };
    case "backup_failed":
    case "backup_late":
    case "restore_test_failed":
    case "restore_test_overdue":
      return { labelKey: "attention.action.openHealth", to: "/vendor-console/health" };
    default:
      return { labelKey: "attention.action.open", to: item.tenant_id ? customer : "/vendor-console/health" };
  }
}

export function AttentionList({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation("vendorConsole");
  if (items.length === 0) {
    return <EmptyState title={t("attention.none.title")} body={t("attention.none.body")} />;
  }
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        const kind = KNOWN_KINDS.has(item.kind) ? item.kind : "unknown";
        const f = item.facts;
        const device = str(f.device_label) || str(f.machine_id);
        const count = Number(f.days_left ?? f.days_ago ?? f.days ?? 0);
        const vars = {
          customer: item.tenant_name ?? "",
          count,
          devices: Number(f.devices ?? 0),
          edition: str(f.edition),
          device,
          summary: str(f.summary),
          at: formatDate(str(f.at) || str(f.last_at) || str(f.ended_at) || str(f.expires_at)),
          ago: formatAgo(str(f.last_sync_at)),
        };
        const action = actionOf(item);
        return (
          <li key={`${item.kind}-${i}`} className="flex items-center gap-3.5 border-t border-surface-3 py-3.5 first:border-t-0">
            <Dot tone={toneOf(item.severity)} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-text-primary">{t(`attention.${kind}.title`, vars)}</span>
              <span className="text-[13px] text-text-secondary">{t(`attention.${kind}.detail`, vars)}</span>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={action.to}>{t(action.labelKey)}</Link>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

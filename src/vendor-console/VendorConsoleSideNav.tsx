import type { ReactNode } from "react";
import { HeartPulse, KeyRound, LayoutDashboard, LifeBuoy, MonitorSmartphone, RefreshCw, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

import { MaintafoxMark } from "@/components/branding/MaintafoxMark";
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

type NavItem = { to: string; labelKey: string; anyOf: string[]; icon: ReactNode; end?: boolean };

/** The console's sections (2026 redesign). A section shows when the role can use part of it. */
export const NAV_SECTIONS: NavItem[] = [
  { to: "/vendor-console", labelKey: "nav.overview", anyOf: ["console.view"], icon: <LayoutDashboard className="h-4 w-4" />, end: true },
  { to: "/vendor-console/customers", labelKey: "nav.customers", anyOf: ["console.view"], icon: <Users className="h-4 w-4" /> },
  { to: "/vendor-console/licences", labelKey: "nav.licences", anyOf: ["entitlement.manage", "customer.manage"], icon: <KeyRound className="h-4 w-4" /> },
  { to: "/vendor-console/devices", labelKey: "nav.devices", anyOf: ["sync.operate", "entitlement.manage"], icon: <MonitorSmartphone className="h-4 w-4" /> },
  { to: "/vendor-console/updates", labelKey: "nav.updates", anyOf: ["rollout.manage"], icon: <RefreshCw className="h-4 w-4" /> },
  { to: "/vendor-console/support", labelKey: "nav.support", anyOf: ["support.manage"], icon: <LifeBuoy className="h-4 w-4" /> },
  { to: "/vendor-console/health", labelKey: "nav.health", anyOf: ["platform.observe"], icon: <HeartPulse className="h-4 w-4" /> },
];
const SETTINGS: NavItem = { to: "/vendor-console/settings", labelKey: "nav.settings", anyOf: ["console.view"], icon: <Settings className="h-4 w-4" /> };

function Item({ item, muted = false }: { item: NavItem; muted?: boolean }) {
  const { t } = useTranslation("vendorConsole");
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-[11px] text-sm transition-colors",
          isActive ? "bg-navy-active font-semibold text-white" : muted ? "text-navy-muted hover:bg-navy-active/60 hover:text-white" : "text-navy-text hover:bg-navy-active/60 hover:text-white",
        )
      }
    >
      {item.icon}
      {t(item.labelKey)}
    </NavLink>
  );
}

export function VendorConsoleSideNav() {
  const { t } = useTranslation("vendorConsole");
  const { canAny } = usePermissions();
  return (
    <nav aria-label={t("nav.aria")} className="flex w-[232px] shrink-0 flex-col gap-1 border-r border-white/5 bg-navy px-4 py-6">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <MaintafoxMark variant="white" size={36} />
        <div className="flex flex-col">
          <span className="text-base font-bold text-white">{t("common:app.name")}</span>
          <span className="text-xs text-navy-muted">{t("shell.consoleName")}</span>
        </div>
      </div>
      {NAV_SECTIONS.filter((item) => canAny(...item.anyOf)).map((item) => (
        <Item key={item.to} item={item} />
      ))}
      <div className="flex-1" />
      <Item item={SETTINGS} muted />
    </nav>
  );
}

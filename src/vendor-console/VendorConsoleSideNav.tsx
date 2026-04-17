import type { ReactNode } from "react";
import { Activity, Cpu, FileSearch, Layers, Rocket, Server, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";

import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

const NAV: {
  to: string;
  labelKey: string;
  permission: string;
  icon: ReactNode;
}[] = [
  {
    to: "/vendor-console",
    labelKey: "nav.overview",
    permission: "console.view",
    icon: <Layers className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/customers",
    labelKey: "nav.customers",
    permission: "customer.manage",
    icon: <Users className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/entitlements",
    labelKey: "nav.entitlements",
    permission: "entitlement.manage",
    icon: <Server className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/machines",
    labelKey: "nav.machines",
    permission: "entitlement.manage",
    icon: <Cpu className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/sync",
    labelKey: "nav.sync",
    permission: "sync.operate",
    icon: <Activity className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/rollouts",
    labelKey: "nav.rollouts",
    permission: "rollout.manage",
    icon: <Rocket className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/health",
    labelKey: "nav.health",
    permission: "platform.observe",
    icon: <Activity className="h-4 w-4" />,
  },
  {
    to: "/vendor-console/audit",
    labelKey: "nav.audit",
    permission: "audit.view",
    icon: <FileSearch className="h-4 w-4" />,
  },
];

export function VendorConsoleSideNav() {
  const { t } = useTranslation("vendorConsole");
  const { can } = usePermissions();

  return (
    <nav
      className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-surface-border bg-surface-0 p-2"
      aria-label={t("nav.aria", "Vendor console sections")}
    >
      {NAV.filter((item) => can(item.permission)).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === "/vendor-console"}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary/15 text-primary"
                : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
            )
          }
        >
          {item.icon}
          {t(item.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}

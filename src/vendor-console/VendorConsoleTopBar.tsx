import { ArrowLeft, Radio } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { VendorConsoleAccountMenu } from "./VendorConsoleAccountMenu";
import { useVendorConsole } from "./VendorConsoleContext";

export function VendorConsoleTopBar() {
  const { t } = useTranslation("vendorConsole");
  const { tenantSearch, setTenantSearch, integrationDegraded } = useVendorConsole();

  const env =
    import.meta.env.MODE === "production"
      ? "prod"
      : import.meta.env.MODE === "development"
        ? "dev"
        : import.meta.env.MODE;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-surface-border bg-surface-1 px-4">
      <Link
        to="/vendor-console"
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        aria-label={t("shell.backToApp")}
      >
        <ArrowLeft className="h-4 w-4" />
        <span className="hidden sm:inline">{t("shell.backToApp")}</span>
      </Link>

      <div className="flex items-center gap-2 border-l border-surface-border pl-3">
        <Radio className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-sm font-semibold text-text-primary">
          {t("shell.product")}
        </span>
        <span
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium uppercase",
            env === "prod"
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
              : "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
          )}
        >
          {env}
        </span>
      </div>

      <div className="mx-auto hidden max-w-md flex-1 md:block">
        <Input
          value={tenantSearch}
          onChange={(e) => setTenantSearch(e.target.value)}
          placeholder={t("shell.tenantSearchPlaceholder")}
          aria-label={t("shell.tenantSearchAria")}
          className="h-9"
        />
      </div>

      {integrationDegraded ? (
        <div
          className="ml-auto max-w-sm truncate rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-950 dark:bg-amber-900 dark:text-amber-50"
          role="status"
        >
          {t("shell.degradedBanner")}
        </div>
      ) : (
        <div className="ml-auto text-xs text-text-muted">{t("shell.hostHint")}</div>
      )}
      <LanguageSwitcher />
      <VendorConsoleAccountMenu />
    </header>
  );
}

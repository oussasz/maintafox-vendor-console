import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";

import { VendorConsoleAccountMenu } from "./VendorConsoleAccountMenu";

/** Theme, language and the operator's account, top right of every page. */
export function VendorConsoleTopBar() {
  return (
    <div className="flex items-center justify-end gap-3">
      <ThemeToggle />
      <LanguageSwitcher />
      <VendorConsoleAccountMenu />
    </div>
  );
}

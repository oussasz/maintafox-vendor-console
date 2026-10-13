import { LanguageSwitcher } from "@/components/LanguageSwitcher";

import { VendorConsoleAccountMenu } from "./VendorConsoleAccountMenu";

/** Language and the operator's account, top right of every page. */
export function VendorConsoleTopBar() {
  return (
    <div className="flex items-center justify-end gap-3">
      <LanguageSwitcher />
      <VendorConsoleAccountMenu />
    </div>
  );
}

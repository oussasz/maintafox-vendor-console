import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

import { VendorConsoleProvider, useVendorConsole } from "./VendorConsoleContext";
import { VendorConsoleSideNav } from "./VendorConsoleSideNav";
import { VendorConsoleStepUpDialog } from "./VendorConsoleStepUpDialog";
import { VendorConsoleTopBar } from "./VendorConsoleTopBar";

function VendorConsoleShellInner() {
  const { t } = useTranslation("common");
  const { stepUpOpen, stepUpActionKind, completeStepUp, cancelStepUp } = useVendorConsole();

  return (
    <div className="flex h-screen flex-col bg-surface-0 text-text-primary">
      <VendorConsoleTopBar />
      <div className="flex min-h-0 flex-1">
        <VendorConsoleSideNav />
        <main id="vendor-console-main" className="min-h-0 flex-1 overflow-auto p-6" tabIndex={-1}>
          <Suspense
            fallback={
              <div className="flex h-40 items-center justify-center text-sm text-text-muted">
                {t("app.loading")}
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
      <VendorConsoleStepUpDialog
        open={stepUpOpen}
        actionKind={stepUpActionKind}
        onGranted={completeStepUp}
        onCancel={cancelStepUp}
      />
    </div>
  );
}

export function VendorConsoleShell() {
  return (
    <VendorConsoleProvider>
      <VendorConsoleShellInner />
    </VendorConsoleProvider>
  );
}

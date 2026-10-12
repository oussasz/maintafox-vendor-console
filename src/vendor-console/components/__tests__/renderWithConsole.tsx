import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import { VendorConsoleProvider, useVendorConsole } from "../../VendorConsoleContext";
import { VendorConsoleStepUpDialog } from "../../VendorConsoleStepUpDialog";

/** Mirrors VendorConsoleShell's dialog wiring so step-up flows run end-to-end in tests. */
function StepUpHost() {
  const { stepUpOpen, stepUpActionKind, completeStepUp, cancelStepUp } = useVendorConsole();
  return (
    <VendorConsoleStepUpDialog
      open={stepUpOpen}
      actionKind={stepUpActionKind}
      onGranted={completeStepUp}
      onCancel={cancelStepUp}
    />
  );
}

export function renderWithConsole(ui: ReactElement): RenderResult {
  return render(
    <VendorConsoleProvider>
      {ui}
      <StepUpHost />
    </VendorConsoleProvider>,
  );
}

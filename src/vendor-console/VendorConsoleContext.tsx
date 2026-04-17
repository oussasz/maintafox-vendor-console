import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface VendorConsoleContextValue {
  /** Tenant or machine id filter shown in shell (operational context). */
  tenantSearch: string;
  setTenantSearch: (q: string) => void;
  /** Epoch ms until step-up is considered satisfied (client hint; server must re-verify). */
  stepUpValidUntilMs: number | null;
  markStepUpSatisfied: (ttlMs?: number) => void;
  clearStepUp: () => void;
  /** Integration / queue degraded banner driven by telemetry health. */
  integrationDegraded: boolean;
  setIntegrationDegraded: (v: boolean) => void;
  stepUpOpen: boolean;
  stepUpActionLabel: string;
  openStepUp: (actionLabel: string) => void;
  closeStepUp: () => void;
}

const VendorConsoleContext = createContext<VendorConsoleContextValue | null>(null);

const DEFAULT_STEP_UP_TTL_MS = 10 * 60 * 1000;

export function VendorConsoleProvider({ children }: { children: ReactNode }) {
  const [tenantSearch, setTenantSearch] = useState("");
  const [stepUpValidUntilMs, setStepUpValidUntilMs] = useState<number | null>(null);
  const [integrationDegraded, setIntegrationDegraded] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpActionLabel, setStepUpActionLabel] = useState("");

  const markStepUpSatisfied = useCallback((ttlMs: number = DEFAULT_STEP_UP_TTL_MS) => {
    setStepUpValidUntilMs(Date.now() + ttlMs);
  }, []);

  const clearStepUp = useCallback(() => {
    setStepUpValidUntilMs(null);
  }, []);

  const openStepUp = useCallback((actionLabel: string) => {
    setStepUpActionLabel(actionLabel);
    setStepUpOpen(true);
  }, []);

  const closeStepUp = useCallback(() => {
    setStepUpOpen(false);
  }, []);

  const value = useMemo(
    () => ({
      tenantSearch,
      setTenantSearch,
      stepUpValidUntilMs,
      markStepUpSatisfied,
      clearStepUp,
      integrationDegraded,
      setIntegrationDegraded,
      stepUpOpen,
      stepUpActionLabel,
      openStepUp,
      closeStepUp,
    }),
    [
      tenantSearch,
      stepUpValidUntilMs,
      markStepUpSatisfied,
      clearStepUp,
      integrationDegraded,
      stepUpOpen,
      stepUpActionLabel,
      openStepUp,
      closeStepUp,
    ],
  );

  return <VendorConsoleContext.Provider value={value}>{children}</VendorConsoleContext.Provider>;
}

export function useVendorConsole(): VendorConsoleContextValue {
  const ctx = useContext(VendorConsoleContext);
  if (!ctx) {
    throw new Error("useVendorConsole must be used within VendorConsoleProvider");
  }
  return ctx;
}

export function isStepUpFresh(stepUpValidUntilMs: number | null): boolean {
  return typeof stepUpValidUntilMs === "number" && stepUpValidUntilMs > Date.now();
}

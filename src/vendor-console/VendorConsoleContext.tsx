import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { StepUpGrant } from "@/services/license-control-service";

/** Rejection reason when the operator closes the step-up dialog without confirming. */
export class StepUpCancelledError extends Error {
  constructor() {
    super("Step-up confirmation was cancelled.");
    this.name = "StepUpCancelledError";
  }
}

/** Re-prompt instead of sending a token that could expire while the request is in flight. */
const STEP_UP_REUSE_MARGIN_MS = 30_000;

export interface VendorConsoleContextValue {
  /** Tenant or machine id filter shown in shell (operational context). */
  tenantSearch: string;
  setTenantSearch: (q: string) => void;
  /** Epoch ms until the server-issued step-up token expires (null when none is held). */
  stepUpValidUntilMs: number | null;
  clearStepUp: () => void;
  /**
   * Resolve a server-issued step-up token for a privileged action. Reuses a fresh token,
   * otherwise opens the password dialog. Rejects with StepUpCancelledError when dismissed.
   */
  requireStepUp: (actionLabel: string) => Promise<string>;
  /** Integration / queue degraded banner driven by telemetry health. */
  integrationDegraded: boolean;
  setIntegrationDegraded: (v: boolean) => void;
  /** Dialog wiring (VendorConsoleShell). */
  stepUpOpen: boolean;
  stepUpActionLabel: string;
  completeStepUp: (grant: StepUpGrant) => void;
  cancelStepUp: () => void;
}

const VendorConsoleContext = createContext<VendorConsoleContextValue | null>(null);

type PendingStepUp = { resolve: (token: string) => void; reject: (err: Error) => void };

export function VendorConsoleProvider({ children }: { children: ReactNode }) {
  const [tenantSearch, setTenantSearch] = useState("");
  const [grant, setGrant] = useState<StepUpGrant | null>(null);
  const [integrationDegraded, setIntegrationDegraded] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpActionLabel, setStepUpActionLabel] = useState("");
  const pendingRef = useRef<PendingStepUp[]>([]);
  const grantRef = useRef<StepUpGrant | null>(null);

  const clearStepUp = useCallback(() => {
    grantRef.current = null;
    setGrant(null);
  }, []);

  const requireStepUp = useCallback((actionLabel: string) => {
    const current = grantRef.current;
    if (current && current.expiresAtMs - Date.now() > STEP_UP_REUSE_MARGIN_MS) {
      return Promise.resolve(current.token);
    }
    return new Promise<string>((resolve, reject) => {
      pendingRef.current.push({ resolve, reject });
      setStepUpActionLabel(actionLabel);
      setStepUpOpen(true);
    });
  }, []);

  const completeStepUp = useCallback((next: StepUpGrant) => {
    grantRef.current = next;
    setGrant(next);
    setStepUpOpen(false);
    const waiting = pendingRef.current;
    pendingRef.current = [];
    waiting.forEach((p) => p.resolve(next.token));
  }, []);

  const cancelStepUp = useCallback(() => {
    setStepUpOpen(false);
    const waiting = pendingRef.current;
    pendingRef.current = [];
    waiting.forEach((p) => p.reject(new StepUpCancelledError()));
  }, []);

  const stepUpValidUntilMs = grant?.expiresAtMs ?? null;

  const value = useMemo(
    () => ({
      tenantSearch,
      setTenantSearch,
      stepUpValidUntilMs,
      clearStepUp,
      requireStepUp,
      integrationDegraded,
      setIntegrationDegraded,
      stepUpOpen,
      stepUpActionLabel,
      completeStepUp,
      cancelStepUp,
    }),
    [
      tenantSearch,
      stepUpValidUntilMs,
      clearStepUp,
      requireStepUp,
      integrationDegraded,
      stepUpOpen,
      stepUpActionLabel,
      completeStepUp,
      cancelStepUp,
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

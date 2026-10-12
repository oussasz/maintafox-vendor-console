import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { StepUpActionKind } from "@/lib/step-up-kinds";
import type { StepUpGrant } from "@/services/vendor-auth-service";

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
  /**
   * Resolve a server-issued step-up token for one privileged action kind. Reuses a fresh token of
   * that kind, otherwise asks for an authenticator code (the dialog names the kind). Rejects with
   * StepUpCancelledError when dismissed. A token is accepted by the API only on routes of its kind.
   */
  requireStepUp: (actionKind: StepUpActionKind) => Promise<string>;
  /** Integration / queue degraded banner driven by telemetry health. */
  integrationDegraded: boolean;
  setIntegrationDegraded: (v: boolean) => void;
  /** Dialog wiring (VendorConsoleShell). */
  stepUpOpen: boolean;
  stepUpActionKind: StepUpActionKind | null;
  completeStepUp: (grant: StepUpGrant) => void;
  cancelStepUp: () => void;
}

const VendorConsoleContext = createContext<VendorConsoleContextValue | null>(null);

type PendingStepUp = {
  actionKind: StepUpActionKind;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
};

export function VendorConsoleProvider({ children }: { children: ReactNode }) {
  const [tenantSearch, setTenantSearch] = useState("");
  const [integrationDegraded, setIntegrationDegraded] = useState(false);
  const [prompt, setPrompt] = useState<StepUpActionKind | null>(null);
  const pendingRef = useRef<PendingStepUp[]>([]);
  const grantsRef = useRef(new Map<StepUpActionKind, StepUpGrant>());

  /** Shows the dialog for the oldest waiting request (one kind at a time). */
  const promptNext = useCallback(() => {
    const next = pendingRef.current[0];
    setPrompt(next ? next.actionKind : null);
  }, []);

  const requireStepUp = useCallback(
    (actionKind: StepUpActionKind) => {
      const current = grantsRef.current.get(actionKind);
      if (current && current.expiresAtMs - Date.now() > STEP_UP_REUSE_MARGIN_MS) {
        return Promise.resolve(current.token);
      }
      return new Promise<string>((resolve, reject) => {
        pendingRef.current.push({ actionKind, resolve, reject });
        if (pendingRef.current.length === 1) promptNext();
      });
    },
    [promptNext],
  );

  const completeStepUp = useCallback(
    (grant: StepUpGrant) => {
      grantsRef.current.set(grant.actionKind, grant);
      const served = pendingRef.current.filter((p) => p.actionKind === grant.actionKind);
      pendingRef.current = pendingRef.current.filter((p) => p.actionKind !== grant.actionKind);
      served.forEach((p) => p.resolve(grant.token));
      promptNext();
    },
    [promptNext],
  );

  const cancelStepUp = useCallback(() => {
    const head = pendingRef.current[0];
    if (!head) {
      setPrompt(null);
      return;
    }
    const cancelled = pendingRef.current.filter((p) => p.actionKind === head.actionKind);
    pendingRef.current = pendingRef.current.filter((p) => p.actionKind !== head.actionKind);
    cancelled.forEach((p) => p.reject(new StepUpCancelledError()));
    promptNext();
  }, [promptNext]);

  const value = useMemo(
    () => ({
      tenantSearch,
      setTenantSearch,
      requireStepUp,
      integrationDegraded,
      setIntegrationDegraded,
      stepUpOpen: prompt !== null,
      stepUpActionKind: prompt,
      completeStepUp,
      cancelStepUp,
    }),
    [tenantSearch, requireStepUp, integrationDegraded, prompt, completeStepUp, cancelStepUp],
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

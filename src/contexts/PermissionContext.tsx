import { type ReactNode, createContext, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import {
  fetchMyPermissions,
  isAuthenticationRequiredError,
  isPermissionsLoadError,
} from "@/services/admin-permissions";
import { endSession } from "@/lib/auth-session";
import type { PermissionRecord } from "@maintafox/contracts";

export type SessionStatus = "loading" | "authenticated" | "unauthenticated" | "forbidden" | "error";

export interface PermissionContextValue {
  permissions: PermissionRecord[];
  isLoading: boolean;
  sessionStatus: SessionStatus;
  loadError: string | null;
  can: (permissionName: string) => boolean;
  canAny: (...permissionNames: string[]) => boolean;
  canAll: (...permissionNames: string[]) => boolean;
  refresh: () => Promise<void>;
}

export const PermissionContext = createContext<PermissionContextValue | null>(null);

interface PermissionProviderProps {
  children?: ReactNode;
}

/**
 * Loads permissions after AuthGuard confirmed a token is present.
 * Auth failures clear the token and redirect to login; load failures surface retry UI.
 */
export function PermissionProvider({ children }: PermissionProviderProps) {
  const location = useLocation();
  const [permissions, setPermissions] = useState<PermissionRecord[]>([]);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSessionStatus("loading");
    setLoadError(null);
    try {
      const perms = await fetchMyPermissions();
      setPermissions(perms);
      if (perms.length === 0) {
        setSessionStatus("forbidden");
      } else {
        setSessionStatus("authenticated");
      }
    } catch (err) {
      setPermissions([]);
      if (isAuthenticationRequiredError(err)) {
        endSession();
        setSessionStatus("unauthenticated");
        setLoadError(null);
        return;
      }
      const message = isPermissionsLoadError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : "Failed to load permissions";
      setLoadError(message);
      setSessionStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const nameSet = useMemo(() => new Set(permissions.map((p) => p.name)), [permissions]);

  const can = useCallback((permissionName: string) => nameSet.has(permissionName), [nameSet]);

  const canAny = useCallback(
    (...permissionNames: string[]) => permissionNames.some((n) => nameSet.has(n)),
    [nameSet],
  );

  const canAll = useCallback(
    (...permissionNames: string[]) => permissionNames.every((n) => nameSet.has(n)),
    [nameSet],
  );

  const isLoading = sessionStatus === "loading";

  const value = useMemo<PermissionContextValue>(
    () => ({
      permissions,
      isLoading,
      sessionStatus,
      loadError,
      can,
      canAny,
      canAll,
      refresh: load,
    }),
    [permissions, isLoading, sessionStatus, loadError, can, canAny, canAll, load],
  );

  if (sessionStatus === "unauthenticated") {
    return (
      <PermissionContext.Provider value={value}>
        <Navigate
          to="/login"
          replace
          state={{ from: location.pathname, reason: "session_expired" }}
        />
      </PermissionContext.Provider>
    );
  }

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

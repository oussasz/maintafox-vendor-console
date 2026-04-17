import { type ReactNode, createContext, useCallback, useEffect, useMemo, useState } from "react";

import { fetchMyPermissions } from "@/services/admin-permissions";
import type { PermissionRecord } from "@shared/ipc-types";

export interface PermissionContextValue {
  permissions: PermissionRecord[];
  isLoading: boolean;
  can: (permissionName: string) => boolean;
  canAny: (...permissionNames: string[]) => boolean;
  canAll: (...permissionNames: string[]) => boolean;
  refresh: () => Promise<void>;
}

export const PermissionContext = createContext<PermissionContextValue | null>(null);

interface PermissionProviderProps {
  children?: ReactNode;
}

export function PermissionProvider({ children }: PermissionProviderProps) {
  const [permissions, setPermissions] = useState<PermissionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const perms = await fetchMyPermissions();
      setPermissions(perms);
    } catch {
      setPermissions([]);
    } finally {
      setIsLoading(false);
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

  const value = useMemo<PermissionContextValue>(
    () => ({ permissions, isLoading, can, canAny, canAll, refresh: load }),
    [permissions, isLoading, can, canAny, canAll, load],
  );

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

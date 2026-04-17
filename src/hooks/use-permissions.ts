import { useContext } from "react";

import { PermissionContext, type PermissionContextValue } from "@/contexts/PermissionContext";

export function usePermissions(): PermissionContextValue {
  const context = useContext(PermissionContext);
  if (!context) {
    throw new Error("usePermissions must be used within <PermissionProvider>");
  }
  return context;
}

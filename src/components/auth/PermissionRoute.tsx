import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";

import { usePermissions } from "@/hooks/use-permissions";
import { UnauthorizedPage } from "@/pages/UnauthorizedPage";

interface PermissionRouteProps {
  permission?: string;
  anyOf?: string[];
  allOf?: string[];
  fallback?: ReactNode;
}

export function PermissionRoute({ permission, anyOf, allOf, fallback }: PermissionRouteProps) {
  const { can, canAny, canAll, isLoading } = usePermissions();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-primary" />
      </div>
    );
  }

  let allowed = false;

  if (permission) {
    allowed = can(permission);
  } else if (anyOf && anyOf.length > 0) {
    allowed = canAny(...anyOf);
  } else if (allOf && allOf.length > 0) {
    allowed = canAll(...allOf);
  } else {
    allowed = true;
  }

  if (!allowed) {
    return <>{fallback ?? <UnauthorizedPage />}</>;
  }

  return <Outlet />;
}

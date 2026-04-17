import { Navigate, Outlet, useLocation } from "react-router-dom";

import { PermissionProvider } from "@/contexts/PermissionContext";
import { getAccessToken } from "@/lib/auth-token";

/**
 * Requires a bearer token in localStorage.
 * Wraps children with `PermissionProvider` after auth.
 */
export function AuthGuard() {
  const location = useLocation();
  const token = getAccessToken();

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <PermissionProvider>
      <Outlet />
    </PermissionProvider>
  );
}

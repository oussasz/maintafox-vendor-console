import { Navigate, Outlet, useLocation } from "react-router-dom";

import { PermissionProvider } from "@/contexts/PermissionContext";
import { getValidLookingAccessToken, setAccessToken } from "@/lib/auth-token";

/**
 * Requires a JWT-shaped bearer token in localStorage.
 * Wraps children with `PermissionProvider` after a local presence check;
 * the provider validates the token against the API and redirects on 401.
 */
export function AuthGuard() {
  const location = useLocation();
  const token = getValidLookingAccessToken();

  if (!token) {
    // Clear garbage/whitespace tokens so they do not loop forever.
    setAccessToken(null);
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <PermissionProvider>
      <Outlet />
    </PermissionProvider>
  );
}

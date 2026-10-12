import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { PermissionProvider } from "@/contexts/PermissionContext";
import { ensureAccessToken, onSessionEnded } from "@/lib/auth-session";

type GuardState = "checking" | "signedIn" | "signedOut" | "unreachable";

/**
 * Requires an operator session. The access token lives only in memory, so after a page load the
 * guard first exchanges the httpOnly refresh cookie (if any) for one; without a session it shows
 * the login page. When a session ends while the console is open (logout everywhere, expiry,
 * revoked), every guard sends the operator back to the login page.
 */
export function AuthGuard() {
  const location = useLocation();
  const [state, setState] = useState<GuardState>("checking");

  useEffect(() => {
    let active = true;
    ensureAccessToken()
      .then((token) => {
        if (active) setState(token ? "signedIn" : "signedOut");
      })
      .catch(() => {
        if (active) setState("unreachable");
      });
    const unsubscribe = onSessionEnded(() => setState("signedOut"));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (state === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-0" role="status" aria-busy="true">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-primary" />
      </div>
    );
  }
  if (state === "signedOut" || state === "unreachable") {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname, reason: state === "unreachable" ? "api_unreachable" : undefined }}
      />
    );
  }
  return (
    <PermissionProvider>
      <Outlet />
    </PermissionProvider>
  );
}

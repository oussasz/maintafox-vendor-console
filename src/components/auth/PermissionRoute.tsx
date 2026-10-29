import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { usePermissions } from "@/hooks/use-permissions";
import { UnauthorizedPage } from "@/pages/UnauthorizedPage";
import type { PermissionsLoadError } from "@/services/admin-permissions";

interface PermissionRouteProps {
  permission?: string;
  anyOf?: string[];
  allOf?: string[];
  fallback?: ReactNode;
}

function PermissionsLoadErrorPanel({ error, onRetry }: { error: PermissionsLoadError | null; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold text-text-primary">{t("permissions.loadError.title")}</h1>
        <p className="text-sm text-text-secondary" role="alert">
          {t(`permissions.loadError.${error?.kind ?? "invalid"}`, { status: error?.status ?? "" })}
        </p>
        <Button type="button" onClick={onRetry}>
          {t("action.retry")}
        </Button>
      </div>
    </div>
  );
}

export function PermissionRoute({ permission, anyOf, allOf, fallback }: PermissionRouteProps) {
  const { can, canAny, canAll, isLoading, sessionStatus, loadError, refresh } = usePermissions();

  if (isLoading || sessionStatus === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-primary" />
      </div>
    );
  }

  // Provider handles Navigate to /login
  if (sessionStatus === "unauthenticated") {
    return null;
  }

  if (sessionStatus === "error") {
    return (
      <PermissionsLoadErrorPanel error={loadError} onRetry={() => void refresh()} />
    );
  }

  // Authenticated with empty permission set (future RBAC) or missing required permission
  if (sessionStatus === "forbidden") {
    return <>{fallback ?? <UnauthorizedPage />}</>;
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

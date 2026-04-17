import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

export function UnauthorizedPage() {
  const { t } = useTranslation("auth");

  return (
    <div className="flex h-full items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-status-danger/10">
          <Lock className="h-8 w-8 text-status-danger" />
        </div>

        <h1 className="text-xl font-semibold text-text-primary">
          {t("unauthorized.title", "Access denied")}
        </h1>

        <p className="mt-2 text-sm text-text-secondary">
          {t(
            "unauthorized.message",
            "You do not have permission to access this section. Ask an administrator to update your role.",
          )}
        </p>

        <Link
          to="/vendor-console"
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
        >
          {t("unauthorized.backToDashboard", "Back to vendor console")}
        </Link>
      </div>
    </div>
  );
}

import { Suspense, lazy } from "react";
import { Navigate, Outlet, type RouteObject, createBrowserRouter } from "react-router-dom";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { PermissionRoute } from "@/components/auth/PermissionRoute";

const LoginPage = lazy(() => import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const VendorConsoleShell = lazy(() =>
  import("@/vendor-console/VendorConsoleShell").then((m) => ({ default: m.VendorConsoleShell })),
);
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const OverviewPage = page(() => import("@/vendor-console/pages/OverviewPage"), "OverviewPage");
const CustomersPage = page(() => import("@/vendor-console/pages/CustomersPage"), "CustomersPage");
const CustomerPage = page(() => import("@/vendor-console/pages/CustomerPage"), "CustomerPage");
const LicencesPage = page(() => import("@/vendor-console/pages/LicencesPage"), "LicencesPage");
const DevicesPage = page(() => import("@/vendor-console/pages/DevicesPage"), "DevicesPage");
const UpdatesPage = page(() => import("@/vendor-console/pages/UpdatesPage"), "UpdatesPage");
const SupportPage = page(() => import("@/vendor-console/pages/SupportPage"), "SupportPage");
const SystemHealthPage = page(() => import("@/vendor-console/pages/SystemHealthPage"), "SystemHealthPage");
const SettingsPage = page(() => import("@/vendor-console/pages/SettingsPage"), "SettingsPage");

function PageSuspense() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-primary" />
        </div>
      }
    >
      <Outlet />
    </Suspense>
  );
}

const routes: RouteObject[] = [
  {
    path: "login",
    element: (
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center bg-surface-0">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-primary" />
          </div>
        }
      >
        <LoginPage />
      </Suspense>
    ),
  },
  {
    element: <AuthGuard />,
    children: [
      {
        index: true,
        element: <Navigate to="/vendor-console" replace />,
      },
      {
        path: "vendor-console",
        element: <PermissionRoute permission="console.view" />,
        children: [
          {
            element: <PageSuspense />,
            children: [
              {
                element: <VendorConsoleShell />,
                children: [
                  { index: true, element: <OverviewPage /> },
                  { path: "customers", element: <CustomersPage /> },
                  { path: "customers/:tenantId", element: <CustomerPage /> },
                  {
                    path: "licences",
                    element: <PermissionRoute anyOf={["entitlement.manage", "customer.manage"]} />,
                    children: [{ index: true, element: <LicencesPage /> }],
                  },
                  {
                    path: "devices",
                    element: <PermissionRoute anyOf={["sync.operate", "entitlement.manage"]} />,
                    children: [{ index: true, element: <DevicesPage /> }],
                  },
                  {
                    path: "updates",
                    element: <PermissionRoute permission="rollout.manage" />,
                    children: [{ index: true, element: <UpdatesPage /> }],
                  },
                  {
                    path: "support",
                    element: <PermissionRoute permission="support.manage" />,
                    children: [{ index: true, element: <SupportPage /> }],
                  },
                  {
                    path: "health",
                    element: <PermissionRoute permission="platform.observe" />,
                    children: [{ index: true, element: <SystemHealthPage /> }],
                  },
                  { path: "settings", element: <SettingsPage /> },
                  // Addresses of the console before the 2026 redesign (bookmarks, links in e-mails).
                  { path: "entitlements", element: <Navigate to="/vendor-console/licences" replace /> },
                  { path: "editions", element: <Navigate to="/vendor-console/licences?tab=editions" replace /> },
                  { path: "billing", element: <Navigate to="/vendor-console/licences?tab=payments" replace /> },
                  { path: "machines", element: <Navigate to="/vendor-console/devices" replace /> },
                  { path: "sync", element: <Navigate to="/vendor-console/devices?tab=sync" replace /> },
                  { path: "rollouts", element: <Navigate to="/vendor-console/updates" replace /> },
                  { path: "audit", element: <Navigate to="/vendor-console/settings?tab=audit" replace /> },
                  { path: "operators", element: <Navigate to="/vendor-console/settings?tab=team" replace /> },
                  { path: "*", element: <Navigate to="/vendor-console" replace /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);

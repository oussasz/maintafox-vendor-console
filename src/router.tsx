import { Suspense, lazy } from "react";
import { Navigate, Outlet, type RouteObject, createBrowserRouter } from "react-router-dom";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { PermissionRoute } from "@/components/auth/PermissionRoute";

const LoginPage = lazy(() => import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const VendorConsoleShell = lazy(() =>
  import("@/vendor-console/VendorConsoleShell").then((m) => ({ default: m.VendorConsoleShell })),
);
const VendorConsoleHomePage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleHomePage").then((m) => ({
    default: m.VendorConsoleHomePage,
  })),
);
const VendorConsoleCustomersPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleCustomersPage").then((m) => ({
    default: m.VendorConsoleCustomersPage,
  })),
);
const VendorConsoleEntitlementsPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleEntitlementsPage").then((m) => ({
    default: m.VendorConsoleEntitlementsPage,
  })),
);
const VendorConsoleMachinesPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleMachinesPage").then((m) => ({
    default: m.VendorConsoleMachinesPage,
  })),
);
const VendorConsoleSyncPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleSyncPage").then((m) => ({
    default: m.VendorConsoleSyncPage,
  })),
);
const VendorConsoleRolloutsPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleRolloutsPage").then((m) => ({
    default: m.VendorConsoleRolloutsPage,
  })),
);
const VendorConsoleHealthPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleHealthPage").then((m) => ({
    default: m.VendorConsoleHealthPage,
  })),
);
const VendorConsoleAuditPage = lazy(() =>
  import("@/vendor-console/pages/VendorConsoleAuditPage").then((m) => ({
    default: m.VendorConsoleAuditPage,
  })),
);

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
                  { index: true, element: <VendorConsoleHomePage /> },
                  {
                    path: "customers",
                    element: <PermissionRoute permission="customer.manage" />,
                    children: [{ index: true, element: <VendorConsoleCustomersPage /> }],
                  },
                  {
                    path: "entitlements",
                    element: <PermissionRoute permission="entitlement.manage" />,
                    children: [{ index: true, element: <VendorConsoleEntitlementsPage /> }],
                  },
                  {
                    path: "machines",
                    element: <PermissionRoute permission="entitlement.manage" />,
                    children: [{ index: true, element: <VendorConsoleMachinesPage /> }],
                  },
                  {
                    path: "sync",
                    element: <PermissionRoute permission="sync.operate" />,
                    children: [{ index: true, element: <VendorConsoleSyncPage /> }],
                  },
                  {
                    path: "rollouts",
                    element: <PermissionRoute permission="rollout.manage" />,
                    children: [{ index: true, element: <VendorConsoleRolloutsPage /> }],
                  },
                  {
                    path: "health",
                    element: <PermissionRoute permission="platform.observe" />,
                    children: [{ index: true, element: <VendorConsoleHealthPage /> }],
                  },
                  {
                    path: "audit",
                    element: <PermissionRoute permission="audit.view" />,
                    children: [{ index: true, element: <VendorConsoleAuditPage /> }],
                  },
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

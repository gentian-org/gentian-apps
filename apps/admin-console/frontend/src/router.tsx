import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { RequireAuth } from "@/auth/RequireAuth";
import { AdminPage } from "@/pages/AdminPage";

const rootRoute = createRootRoute({
  component: () => (
    <RequireAuth>
      <Outlet />
    </RequireAuth>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: AdminPage,
});

const routeTree = rootRoute.addChildren([indexRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { Loader } from "./components/loader";
import { RouteNotFound } from "./components/route-not-found";
import { createQueryClient } from "./lib/query-client";
import { routeTree } from "./routeTree.gen";

const queryClient = createQueryClient({
  /**
   * A toast Retry that recovers a read a loader had awaited re-runs the loaders too, so the
   * boundary standing on that read clears with the toast (`lib/query-error-retry.ts`). `router`
   * is assigned below; this closure runs on a click, long after.
   */
  onRecover: () => void router.invalidate(),
});

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  /**
   * Zero hands caching to React Query. The router's own loader cache would otherwise treat a
   * preload's result as fresh for thirty seconds and skip the loader — and the loaders here read
   * through Query, so skipping them is skipping Query's cache too. Cando settled the same way
   * (`apps/web/src/main.tsx` there, CAN-242).
   */
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingComponent: Loader,
  /**
   * On the router, not the root route: `notFoundComponent` on `__root` fires only for a `notFound()`
   * thrown by a route that matched, and an address matching nothing never reaches one.
   */
  defaultNotFoundComponent: RouteNotFound,
  context: { queryClient },
  Wrap: function WrapComponent({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
}

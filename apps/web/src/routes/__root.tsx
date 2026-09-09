import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";

import { RouteError } from "@/components/route-error";

import "../index.css";

export interface RouterAppContext {
  queryClient: QueryClient;
}

/**
 * The root renders no chrome. Whether a screen wears the shell is decided by where its file sits —
 * `_auth/_shell/` — and whether it needs a session one level up, in `_auth/`. Cando arrived at the
 * same split after a list of "bare" paths kept needing edits (its `apps/web/src/routes/__root.tsx`).
 */
export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  errorComponent: RouteError,
  head: () => ({
    meta: [{ title: "Graft" }],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <Outlet />
      <Toaster richColors position="top-right" />
    </>
  );
}
